"""musetalk_infer.py — thin programmatic wrapper around MuseTalk v1.5.

Exposes two functions:
    prepare_avatar(source_frame_bgr, avatar_id, work_dir)  →  AvatarPrep | None
    synthesize(prep, audio_path, fps=25)                   →  list[np.ndarray] (BGR)

Graceful degradation: if MuseTalk is not installed at MUSETALK_DIR both
functions return None / [] and runtime.py falls back to TPS warp as before.

MUSETALK_DIR defaults to /workspace/MuseTalk (RunPod standard location) but can
be overridden via the MUSETALK_DIR environment variable.
"""
from __future__ import annotations

import copy
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Make system-installed packages (torch, mmcv, etc.) visible when the backend
# runs inside its own .venv which does not include those heavy deps.
# ---------------------------------------------------------------------------
_SYSTEM_SITE = "/usr/local/lib/python3.11/dist-packages"
if os.path.isdir(_SYSTEM_SITE) and _SYSTEM_SITE not in sys.path:
    sys.path.append(_SYSTEM_SITE)  # append so venv packages take priority

# SD-VAE checkpoints we provision are .bin-based; disabling safetensors lookup
# avoids noisy "diffusion_pytorch_model.safetensors not found" warnings.
os.environ.setdefault("DIFFUSERS_USE_SAFETENSORS", "0")

# ---------------------------------------------------------------------------
# Path to the cloned MuseTalk repository
# ---------------------------------------------------------------------------
MUSETALK_DIR = Path(os.environ.get("MUSETALK_DIR", "/workspace/MuseTalk"))

# ---------------------------------------------------------------------------
# Global model cache — loaded once, reused for every synthesis call
# ---------------------------------------------------------------------------
_models: dict[str, Any] = {}
_models_available: Optional[bool] = None   # None = not yet probed
_models_load_lock = threading.Lock()       # prevent concurrent load attempts

# musetalk sub-modules that may be left in a broken state if an import fails
# mid-way; purging them lets the next attempt do a clean import.
_MUSETALK_SUBMODULES = [
    "musetalk",
    "musetalk.utils",
    "musetalk.utils.utils",
    "musetalk.utils.audio_processor",
    "musetalk.utils.face_parsing",
    "musetalk.utils.preprocessing",
    "musetalk.utils.blending",
    "musetalk.models",
    "musetalk.models.vae",
    "musetalk.models.unet",
    "musetalk.models.pe",
]


@dataclass
class AvatarPrep:
    """Per-avatar data cached after the one-time preparation pass."""
    frame_list_cycle: list          # list of BGR np.ndarray (original frames, looping)
    coord_list_cycle: list          # list of [x1,y1,x2,y2] face bboxes (looping)
    input_latent_list_cycle: Any    # torch.Tensor stack of VAE-encoded face crops
    mask_list_cycle: list           # list of alpha masks (looping)
    mask_coords_list_cycle: list    # list of crop-box coords for each mask


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _load_models() -> bool:
    """Try to load MuseTalk models once.  Caches success/failure in
    _models_available so repeated calls are instant."""
    global _models_available, _models

    if _models_available is not None:
        return _models_available

    # Prevent concurrent coroutines from each racing into the heavy import
    # block simultaneously, which produces duplicate / conflicting module stubs.
    if not _models_load_lock.acquire(blocking=False):
        # Another thread/coroutine is already loading; wait until it finishes.
        with _models_load_lock:
            pass
        return _models_available if _models_available is not None else False

    # Lock is now held by this caller; release it in all exit paths.
    musetalk_str = str(MUSETALK_DIR)
    orig_cwd = os.getcwd()

    try:
        if not MUSETALK_DIR.exists():
            logger.warning(
                "MuseTalk directory not found at %s. "
                "Mouth animation will use TPS warp fallback.",
                MUSETALK_DIR,
            )
            _models_available = False
            return False

        import torch  # noqa: PLC0415

        # MuseTalk's preprocessing.py initialises models at module level using
        # *relative* paths ("./models/dwpose/…").  We must be inside the
        # MuseTalk directory before any musetalk.* import happens.
        if musetalk_str not in sys.path:
            sys.path.insert(0, musetalk_str)
        os.chdir(MUSETALK_DIR)

        from musetalk.utils.utils import load_all_model          # noqa: PLC0415
        from musetalk.utils.audio_processor import AudioProcessor  # noqa: PLC0415
        from musetalk.utils.face_parsing import FaceParsing        # noqa: PLC0415
        from transformers import WhisperModel                      # noqa: PLC0415

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        vae_type = None
        for candidate in ("sd-vae", "sd-vae-ft-mse"):
            cfg_path = MUSETALK_DIR / "models" / candidate / "config.json"
            if cfg_path.exists():
                vae_type = candidate
                break
        if vae_type is None:
            raise FileNotFoundError(
                "MuseTalk VAE weights missing. Expected one of: "
                "models/sd-vae/config.json or models/sd-vae-ft-mse/config.json"
            )

        vae, unet, pe = load_all_model(
            unet_model_path=str(MUSETALK_DIR / "models/musetalkV15/unet.pth"),
            vae_type=vae_type,
            unet_config=str(MUSETALK_DIR / "models/musetalkV15/musetalk.json"),
            device=device,
        )

        # Run in half-precision to cut VRAM usage
        pe = pe.half().to(device)
        vae.vae = vae.vae.half().to(device)
        unet.model = unet.model.half().to(device)
        weight_dtype = unet.model.dtype

        whisper_dir = str(MUSETALK_DIR / "models/whisper")
        whisper = WhisperModel.from_pretrained(whisper_dir)
        whisper = whisper.to(device=device, dtype=weight_dtype).eval()
        whisper.requires_grad_(False)

        audio_processor = AudioProcessor(feature_extractor_path=whisper_dir)
        fp = FaceParsing(left_cheek_width=90, right_cheek_width=90)
        timesteps = torch.tensor([0], device=device)

        _models.update(
            vae=vae, unet=unet, pe=pe,
            whisper=whisper, audio_processor=audio_processor,
            fp=fp, device=device, timesteps=timesteps,
            weight_dtype=weight_dtype,
        )

        logger.info("MuseTalk v1.5 models loaded on %s", device)
        _models_available = True

    except Exception as exc:
        logger.warning(
            "MuseTalk model load failed (%s). TPS warp fallback active.",
            exc, exc_info=True,
        )
        # Purge any partially-initialised musetalk modules from the import
        # cache so that a later attempt (e.g. after an env fix + restart) gets
        # a clean slate rather than seeing broken stubs.
        for _mod in _MUSETALK_SUBMODULES:
            sys.modules.pop(_mod, None)
        _models_available = False

    finally:
        os.chdir(orig_cwd)
        _models_load_lock.release()

    return _models_available


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def prepare_avatar(
    source_frame_bgr: np.ndarray,
    avatar_id: str,
    work_dir: str = "/tmp/musetalk_avatars",
) -> AvatarPrep | None:
    """One-time preparation for a source portrait.

    Saves the frame to disk, runs MuseTalk's face detection + VAE encoding,
    and returns an ``AvatarPrep`` dataclass that is passed to every
    ``synthesize()`` call for this avatar.

    Returns ``None`` if MuseTalk is unavailable or no face is detected.
    Takes ~2–5 s on first call (GPU); subsequent calls reuse cached files.
    """
    if not _load_models():
        return None

    musetalk_str = str(MUSETALK_DIR)
    orig_cwd = os.getcwd()

    try:
        if musetalk_str not in sys.path:
            sys.path.insert(0, musetalk_str)
        os.chdir(MUSETALK_DIR)

        from musetalk.utils.blending import get_image_prepare_material    # noqa: PLC0415

        avatar_dir = Path(work_dir) / avatar_id
        full_imgs_path = avatar_dir / "full_imgs"
        mask_out_path = avatar_dir / "mask"
        full_imgs_path.mkdir(parents=True, exist_ok=True)
        mask_out_path.mkdir(parents=True, exist_ok=True)

        # Persist to a PNG file (MuseTalk preprocessing expects file paths)
        frame_path = str(full_imgs_path / "00000000.png")
        cv2.imwrite(frame_path, source_frame_bgr)

        try:
            from musetalk.utils.preprocessing import get_landmark_and_bbox   # noqa: PLC0415
            coord_list, frame_list = get_landmark_and_bbox([frame_path], bbox_shift=0)
        except Exception as exc:
            logger.warning(
                "MuseTalk preprocessing unavailable (%s); using fallback bbox path.",
                exc,
            )
            frame = source_frame_bgr
            h, w = frame.shape[:2]
            # Fallback ROI: central lower-face-biased box (works without DWPose).
            x1 = max(0, int(w * 0.20))
            y1 = max(0, int(h * 0.18))
            x2 = min(w, int(w * 0.80))
            y2 = min(h, int(h * 0.92))
            if x2 <= x1 or y2 <= y1:
                x1, y1, x2, y2 = 0, 0, w, h
            coord_list = [(x1, y1, x2, y2)]
            frame_list = [frame]

        coord_placeholder = (0.0, 0.0, 0.0, 0.0)
        vae = _models["vae"]
        fp  = _models["fp"]
        extra_margin = 10

        input_latent_list: list = []
        for bbox, frame in zip(coord_list, frame_list):
            if bbox == coord_placeholder:
                continue
            x1, y1, x2, y2 = bbox
            y2 = min(y2 + extra_margin, frame.shape[0])
            crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256),
                              interpolation=cv2.INTER_LANCZOS4)
            input_latent_list.append(vae.get_latents_for_unet(crop))

        if not input_latent_list:
            logger.warning("MuseTalk: no face detected in source frame (%s)", avatar_id)
            return None

        frame_list_cycle = frame_list + frame_list[::-1]
        coord_list_cycle = coord_list + coord_list[::-1]
        input_latent_list_cycle = input_latent_list + input_latent_list[::-1]

        mask_list_cycle: list = []
        mask_coords_list_cycle: list = []
        for i, frame in enumerate(frame_list_cycle):
            x1, y1, x2, y2 = coord_list_cycle[i]
            mask, crop_box = get_image_prepare_material(
                frame, [x1, y1, x2, y2], fp=fp, mode="jaw"
            )
            mask_list_cycle.append(mask)
            mask_coords_list_cycle.append(crop_box)

        logger.info(
            "MuseTalk avatar '%s' prepared: %d cycle frames",
            avatar_id, len(frame_list_cycle),
        )
        return AvatarPrep(
            frame_list_cycle=frame_list_cycle,
            coord_list_cycle=coord_list_cycle,
            input_latent_list_cycle=input_latent_list_cycle,
            mask_list_cycle=mask_list_cycle,
            mask_coords_list_cycle=mask_coords_list_cycle,
        )

    except Exception as exc:
        logger.warning("MuseTalk prepare_avatar failed: %s", exc, exc_info=True)
        return None

    finally:
        os.chdir(orig_cwd)


def synthesize(
    prep: AvatarPrep,
    audio_path: str,
    fps: int = 25,
) -> list[np.ndarray]:
    """Generate lip-synced frames for the given audio file.

    Parameters
    ----------
    prep        : AvatarPrep returned by ``prepare_avatar()``
    audio_path  : path to an audio file (MP3 or WAV; librosa handles both)
    fps         : frames per second for output (default 25, matches MuseTalk training)

    Returns a list of BGR ``np.ndarray`` frames ready to stream via WebRTC.
    Returns ``[]`` on any failure so the caller can fall back to TPS warp.
    """
    if prep is None or not _load_models():
        return []

    musetalk_str = str(MUSETALK_DIR)
    orig_cwd = os.getcwd()

    try:
        import torch  # noqa: PLC0415

        if musetalk_str not in sys.path:
            sys.path.insert(0, musetalk_str)
        os.chdir(MUSETALK_DIR)

        from musetalk.utils.utils import datagen             # noqa: PLC0415
        from musetalk.utils.blending import get_image_blending  # noqa: PLC0415

        audio_processor = _models["audio_processor"]
        pe              = _models["pe"]
        unet            = _models["unet"]
        vae             = _models["vae"]
        whisper         = _models["whisper"]
        device          = _models["device"]
        timesteps       = _models["timesteps"]
        weight_dtype    = _models["weight_dtype"]

        t0 = time.monotonic()

        # ── 1. Audio features (Whisper) ────────────────────────────────────
        whisper_input, librosa_len = audio_processor.get_audio_feature(
            audio_path, weight_dtype=weight_dtype
        )
        whisper_chunks = audio_processor.get_whisper_chunk(
            whisper_input, device, weight_dtype, whisper, librosa_len,
            fps=fps,
            audio_padding_length_left=2,
            audio_padding_length_right=2,
        )
        video_num = len(whisper_chunks)

        # ── 2. UNet inference (batch) ──────────────────────────────────────
        gen = datagen(
            whisper_chunks=whisper_chunks,
            vae_encode_latents=prep.input_latent_list_cycle,
            batch_size=20,
        )
        res_frame_list: list[np.ndarray] = []
        with torch.no_grad():
            for whisper_batch, latent_batch in gen:
                audio_feat = pe(whisper_batch.to(device))
                latent_batch = latent_batch.to(device=device, dtype=unet.model.dtype)
                pred = unet.model(
                    latent_batch, timesteps, encoder_hidden_states=audio_feat
                ).sample
                pred = pred.to(device=device, dtype=vae.vae.dtype)
                for res_frame in vae.decode_latents(pred):
                    res_frame_list.append(res_frame)

        # ── 3. Blend generated mouth crops back onto original frames ───────
        n_cycle = len(prep.frame_list_cycle)
        combined: list[np.ndarray] = []
        for i, res_frame in enumerate(res_frame_list):
            bbox = prep.coord_list_cycle[i % n_cycle]
            ori  = copy.deepcopy(prep.frame_list_cycle[i % n_cycle])
            x1, y1, x2, y2 = bbox
            try:
                res_frame = cv2.resize(
                    res_frame.astype(np.uint8), (x2 - x1, y2 - y1)
                )
            except Exception:
                combined.append(ori)
                continue
            mask = prep.mask_list_cycle[i % n_cycle]
            mcb  = prep.mask_coords_list_cycle[i % n_cycle]
            combined.append(get_image_blending(ori, res_frame, bbox, mask, mcb))

        logger.info(
            "MuseTalk synthesized %d frames in %.2fs",
            len(combined), time.monotonic() - t0,
        )
        return combined

    except Exception as exc:
        logger.warning("MuseTalk synthesize failed: %s", exc, exc_info=True)
        return []

    finally:
        os.chdir(orig_cwd)
