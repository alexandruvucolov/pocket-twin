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


def _color_match(src: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Match src's per-channel mean+std to ref (LAB space, per-channel).

    This corrects brightness/tone differences between the MuseTalk VAE output
    and the original frame region, making the blending seam far less visible.
    Both images must be BGR uint8 and the same shape.
    """
    if src.shape != ref.shape or src.dtype != np.uint8:
        return src
    src_lab = cv2.cvtColor(src, cv2.COLOR_BGR2LAB).astype(np.float32)
    ref_lab = cv2.cvtColor(ref, cv2.COLOR_BGR2LAB).astype(np.float32)
    for c in range(3):
        s_mean = src_lab[:, :, c].mean()
        s_std  = src_lab[:, :, c].std()
        r_mean = ref_lab[:, :, c].mean()
        r_std  = ref_lab[:, :, c].std()
        if s_std > 1e-6:
            src_lab[:, :, c] = (src_lab[:, :, c] - s_mean) * (r_std / s_std) + r_mean
    return cv2.cvtColor(np.clip(src_lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


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

# Haarcascade face detector — loaded once, CPU-only, no extra deps
_face_cascade: Optional[Any] = None
_face_cascade_loaded: bool = False
_models_load_lock = threading.Lock()       # prevent concurrent load attempts
_preprocess_available: Optional[bool] = None
_preprocess_warned: bool = False
_last_synthesize_reason: str = ""
_whisper_dim_warned: bool = False

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

def _get_face_cascade():
    """Lazy-load OpenCV Haarcascade face detector (CPU-only)."""
    global _face_cascade, _face_cascade_loaded
    if _face_cascade_loaded:
        return _face_cascade
    try:
        _face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        _face_cascade_loaded = True
        logger.info("OpenCV Haarcascade face detector loaded")
    except Exception as exc:
        logger.warning("Could not load Haarcascade: %s", exc)
        _face_cascade = None
        _face_cascade_loaded = True
    return _face_cascade


def _detect_lip_bbox_opencv(
    frame_bgr: np.ndarray,
) -> tuple[int, int, int, int] | None:
    """Use OpenCV Haarcascade to detect the full face bbox.

    MuseTalk was trained on full-face 256x256 crops, so we return the entire
    face region. Blending is restricted to the mouth area separately.

    Returns (x1, y1, x2, y2) clipped to frame bounds, or None.
    """
    cascade = _get_face_cascade()
    if cascade is None or cascade.empty():
        return None
    h, w = frame_bgr.shape[:2]
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60)
    )
    if not len(faces):
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.05, minNeighbors=2, minSize=(40, 40)
        )
    if not len(faces):
        return None
    faces_sorted = sorted(faces.tolist(), key=lambda f: f[2] * f[3], reverse=True)
    fx, fy, fw, fh = faces_sorted[0]
    # Add small padding around the full face
    pad = int(fw * 0.05)
    x1 = max(0, fx - pad)
    y1 = max(0, fy - pad)
    x2 = min(w, fx + fw + pad)
    y2 = min(h, fy + fh + pad)
    if x2 - x1 < 64 or y2 - y1 < 64:
        return None
    logger.debug("OpenCV full-face bbox: (%d,%d,%d,%d)", x1, y1, x2, y2)
    return (x1, y1, x2, y2)


def _make_lip_alpha_mask(
    crop_h: int, crop_w: int,
) -> np.ndarray:
    """Soft mouth-only mask for fallback blending.

    This keeps transitions natural around the lips while limiting changes to
    the mouth area.
    """
    mask = np.zeros((crop_h, crop_w), dtype=np.float32)
    cy = int(crop_h * 0.72)
    cx = int(crop_w * 0.50)
    rx = int(crop_w * 0.28)
    ry = int(crop_h * 0.12)
    cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, 1.0, -1)
    mask = cv2.GaussianBlur(mask, (15, 15), 0)
    mask = np.power(mask, 1.2).astype(np.float32)
    return mask


def _match_chroma_to_source(
    src_bgr: np.ndarray,
    gen_bgr: np.ndarray,
    alpha: np.ndarray,
) -> np.ndarray:
    """Match generated patch chroma to source patch inside the mouth mask.

    We keep luminance from the generated patch (mouth motion detail) and align
    only chroma channels (Cr/Cb equivalent in YCrCb) to avoid blue/purple tint.
    """
    mask = alpha > 0.08
    if int(mask.sum()) < 32:
        return gen_bgr

    src_ycc = cv2.cvtColor(src_bgr.astype(np.uint8), cv2.COLOR_BGR2YCrCb).astype(np.float32)
    gen_ycc = cv2.cvtColor(gen_bgr.astype(np.uint8), cv2.COLOR_BGR2YCrCb).astype(np.float32)

    corrected = gen_ycc.copy()
    for channel in (1, 2):  # Cr, Cb
        src_vals = src_ycc[..., channel][mask]
        gen_vals = gen_ycc[..., channel][mask]
        src_mean, src_std = float(src_vals.mean()), float(src_vals.std() + 1e-6)
        gen_mean, gen_std = float(gen_vals.mean()), float(gen_vals.std() + 1e-6)
        corrected[..., channel] = (gen_ycc[..., channel] - gen_mean) * (src_std / gen_std) + src_mean

    corrected = np.clip(corrected, 0, 255).astype(np.uint8)
    return cv2.cvtColor(corrected, cv2.COLOR_YCrCb2BGR)


def _poisson_blend_refinement(
    alpha_blended: np.ndarray,
    original: np.ndarray,
    mask_array: np.ndarray,
    crop_box: list,
) -> np.ndarray:
    """Apply Poisson seamless cloning on top of the alpha-blended result.

    This removes the visible dissolving border that Gaussian alpha blending
    produces around the mouth/chin/cheek region, replacing it with a seamless
    transition that matches color and texture at the boundary.

    Uses MIXED_CLONE which preserves the background texture (skin pores etc.)
    while transplanting the generated mouth motion — giving the cleanest result.
    Falls back silently to alpha_blended if anything goes wrong.
    """
    try:
        x_s, y_s, x_e, y_e = [int(v) for v in crop_box]
        h, w = original.shape[:2]
        x_s = max(0, x_s); y_s = max(0, y_s)
        x_e = min(w, x_e); y_e = min(h, y_e)
        if x_e - x_s < 16 or y_e - y_s < 16:
            return alpha_blended

        crop_h, crop_w = y_e - y_s, x_e - x_s

        # Convert Gaussian mask_array to uint8 binary at crop size
        ma = mask_array
        if ma.dtype != np.uint8:
            ma = (np.clip(ma, 0, 255)).astype(np.uint8)
        if ma.shape[:2] != (crop_h, crop_w):
            ma = cv2.resize(ma, (crop_w, crop_h), interpolation=cv2.INTER_LINEAR)

        _, binary = cv2.threshold(ma, 25, 255, cv2.THRESH_BINARY)
        # Erode so the mask stays away from the crop boundary (seamlessClone
        # requires the white region not to touch the image/mask edge)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        binary = cv2.erode(binary, kernel, iterations=2)

        if binary.max() == 0:
            return alpha_blended

        full_mask = np.zeros((h, w), dtype=np.uint8)
        full_mask[y_s:y_e, x_s:x_e] = binary

        cx = (x_s + x_e) // 2
        cy = (y_s + y_e) // 2

        # Ensure center point is well inside frame (seamlessClone requirement)
        cx = int(np.clip(cx, 3, w - 4))
        cy = int(np.clip(cy, 3, h - 4))

        return cv2.seamlessClone(
            alpha_blended, original, full_mask, (cx, cy), cv2.MIXED_CLONE
        )
    except Exception as exc:
        logger.debug("Poisson blend failed (%s); using alpha-blend result", exc)
        return alpha_blended


def _fallback_blend(
    original: np.ndarray,
    generated_crop: np.ndarray,
    bbox: tuple[int, int, int, int],
) -> np.ndarray:
    """Blend generated mouth motion into the source frame with soft alpha and
    local chroma correction to avoid blue tint and harsh dissolving."""
    out = original.copy()
    x1, y1, x2, y2 = bbox
    bh, bw = y2 - y1, x2 - x1
    if bh <= 0 or bw <= 0:
        return out

    roi_gen = cv2.resize(generated_crop.astype(np.uint8), (bw, bh),
                         interpolation=cv2.INTER_LANCZOS4)

    alpha = _make_lip_alpha_mask(bh, bw)                # float32 [0,1]
    # Cap at 0.6 so original sharp texture always bleeds through.
    # This hides VAE blurriness while keeping visible lip motion.
    alpha = np.clip(alpha * 0.60, 0.0, 0.60)
    alpha3 = np.stack([alpha, alpha, alpha], axis=-1)
    src = original[y1:y2, x1:x2].astype(np.float32)
    gen_corr = _match_chroma_to_source(original[y1:y2, x1:x2], roi_gen, alpha)
    gen = gen_corr.astype(np.float32)
    blended = (gen * alpha3 + src * (1.0 - alpha3)).clip(0, 255).astype(np.uint8)
    out[y1:y2, x1:x2] = blended
    return out


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
        fp = FaceParsing(left_cheek_width=60, right_cheek_width=60)
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
    bbox_shift: int = 0,
) -> AvatarPrep | None:
    """One-time preparation for a source portrait.

    Saves the frame to disk, runs MuseTalk's face detection + VAE encoding,
    and returns an ``AvatarPrep`` dataclass that is passed to every
    ``synthesize()`` call for this avatar.

    Returns ``None`` if MuseTalk is unavailable or no face is detected.
    Takes ~2–5 s on first call (GPU); subsequent calls reuse cached files.

    Args:
        bbox_shift: Shift the mouth mask region vertically. Positive values
            (e.g. +5) move toward the lower half → more mouth openness.
            Negative values (e.g. -5) move toward the upper half → less
            mouth openness. Typical range returned by MuseTalk is [-9, 9].
    """
    if not _load_models():
        return None

    musetalk_str = str(MUSETALK_DIR)
    orig_cwd = os.getcwd()

    global _preprocess_available, _preprocess_warned

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

        used_fallback_bbox = False

        if _preprocess_available is not False:
            try:
                from musetalk.utils.preprocessing import get_landmark_and_bbox   # noqa: PLC0415
                coord_list, frame_list = get_landmark_and_bbox([frame_path], bbox_shift=bbox_shift)
                _preprocess_available = True
            except Exception as exc:
                _preprocess_available = False
                if not _preprocess_warned:
                    logger.warning(
                        "MuseTalk preprocessing unavailable (%s); switching to fallback bbox path.",
                        exc,
                    )
                    _preprocess_warned = True
                coord_list, frame_list = [], []
        else:
            coord_list, frame_list = [], []

        if not coord_list or not frame_list:
            used_fallback_bbox = True
            frame = source_frame_bgr
            h, w = frame.shape[:2]

            # ── Try OpenCV face detection first (CPU, no GPU) ──────────────
            opencv_lip_bbox = _detect_lip_bbox_opencv(frame)
            if opencv_lip_bbox is not None:
                x1, y1, x2, y2 = opencv_lip_bbox
                logger.info(
                    "Fallback: OpenCV full-face bbox: (%d,%d,%d,%d) size=%dx%d",
                    x1, y1, x2, y2, x2-x1, y2-y1,
                )
            else:
                # Last-resort: full image as face region
                x1 = max(0, int(w * 0.10))
                y1 = max(0, int(h * 0.05))
                x2 = min(w, int(w * 0.90))
                y2 = min(h, int(h * 0.95))
                if x2 <= x1 or y2 <= y1:
                    x1, y1, x2, y2 = 0, 0, w, h
                logger.info(
                    "Fallback: proportional full-face bbox: (%d,%d,%d,%d)",
                    x1, y1, x2, y2,
                )
            coord_list = [(x1, y1, x2, y2)]
            frame_list = [frame]

        coord_placeholder = (0.0, 0.0, 0.0, 0.0)
        vae = _models["vae"]
        fp  = _models["fp"]
        extra_margin = 2 if used_fallback_bbox else 10

        input_latent_list: list = []
        for bbox, frame in zip(coord_list, frame_list):
            if bbox == coord_placeholder:
                continue
            x1, y1, x2, y2 = bbox
            y2 = min(y2 + extra_margin, frame.shape[0])
            crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256),
                              interpolation=cv2.INTER_LANCZOS4)
            # MuseTalk VAE expects RGB — convert from OpenCV BGR
            crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            input_latent_list.append(vae.get_latents_for_unet(crop_rgb))

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
            # Always try to use get_image_prepare_material — it only needs
            # FaceParsing (BiSeNet), NOT DWPose. It generates a pixel-accurate
            # lower-face mask with the official 10%-of-image Gaussian blur.
            try:
                mask, crop_box = get_image_prepare_material(
                    frame, [x1, y1, x2, y2], fp=fp, mode="jaw", expand=1.5
                )
                mask_list_cycle.append(mask)
                mask_coords_list_cycle.append(crop_box)
            except Exception as exc:
                logger.warning("get_image_prepare_material failed (frame %d): %s", i, exc)
                mask_list_cycle.append(None)
                mask_coords_list_cycle.append(None)

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
        logger.warning("MuseTalk prepare_avatar failed: %s", exc)
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
    global _last_synthesize_reason, _whisper_dim_warned

    if prep is None:
        _last_synthesize_reason = "avatar prep is None"
        return []
    if not _load_models():
        _last_synthesize_reason = "models unavailable"
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
        if video_num == 0:
            _last_synthesize_reason = "no whisper chunks extracted from audio"
            logger.warning("MuseTalk synthesize: no whisper chunks extracted from audio")
            return []

        # ── 2. UNet inference (batch) ──────────────────────────────────────
        gen = datagen(
            whisper_chunks=whisper_chunks,
            vae_encode_latents=prep.input_latent_list_cycle,
            batch_size=20,
        )
        res_frame_list: list[np.ndarray] = []
        with torch.no_grad():
            for whisper_batch, latent_batch in gen:
                # MuseTalk v1.5 expects 384-dim audio features. If a different
                # Whisper checkpoint is present (e.g. whisper-small = 768),
                # adapt at runtime so synthesis can proceed.
                feat_dim = int(whisper_batch.shape[-1])
                if feat_dim != 384:
                    if not _whisper_dim_warned:
                        logger.warning(
                            "MuseTalk: adapting whisper feature dim %d -> 384",
                            feat_dim,
                        )
                        _whisper_dim_warned = True
                    if feat_dim > 384:
                        whisper_batch = whisper_batch[..., :384]
                    else:
                        pad = 384 - feat_dim
                        whisper_batch = torch.nn.functional.pad(whisper_batch, (0, pad))

                audio_feat = pe(whisper_batch.to(device))
                latent_batch = latent_batch.to(device=device, dtype=unet.model.dtype)
                pred = unet.model(
                    latent_batch, timesteps, encoder_hidden_states=audio_feat
                ).sample
                pred = pred.to(device=device, dtype=vae.vae.dtype)
                for res_frame in vae.decode_latents(pred):
                    # VAE decoders may return float32 in [0,1] or [0,255].
                    # Normalise to uint8 [0,255] so blending works correctly.
                    rf = np.array(res_frame)
                    if rf.dtype != np.uint8:
                        if rf.max() <= 1.0 + 1e-6:
                            rf = (rf * 255.0).clip(0, 255)
                        rf = rf.astype(np.uint8)
                    # MuseTalk VAE outputs RGB; convert to BGR for OpenCV blending
                    if rf.ndim == 3 and rf.shape[2] == 3:
                        rf = cv2.cvtColor(rf, cv2.COLOR_RGB2BGR)
                    res_frame_list.append(rf)

        # ── 3. Blend generated mouth crops back onto original frames ───────
        n_cycle = len(prep.frame_list_cycle)
        combined: list[np.ndarray] = []

        # Save raw VAE output for diagnostics (mid frame)
        try:
            mid_idx = len(res_frame_list) // 2
            if res_frame_list:
                cv2.imwrite("/tmp/musetalk_raw_vae.jpg", res_frame_list[mid_idx])
                # Also save the source crop at same bbox for comparison
                src_frame = prep.frame_list_cycle[0]
                x1, y1, x2, y2 = prep.coord_list_cycle[0]
                src_crop = cv2.resize(src_frame[y1:y2, x1:x2], (256, 256))
                cv2.imwrite("/tmp/musetalk_src_crop.jpg", src_crop)
                logger.info("MuseTalk: raw VAE output saved to /tmp/musetalk_raw_vae.jpg (max=%.1f min=%.1f)",
                            float(res_frame_list[mid_idx].max()), float(res_frame_list[mid_idx].min()))
        except Exception as _e:
            logger.warning("MuseTalk: could not save diagnostic frames: %s", _e)

        for i, res_frame in enumerate(res_frame_list):
            bbox = prep.coord_list_cycle[i % n_cycle]
            ori  = copy.deepcopy(prep.frame_list_cycle[i % n_cycle])
            x1, y1, x2, y2 = bbox
            # res_frame is a 256x256 full crop of the bbox region.
            # Resize it back to the original bbox dimensions.
            bh = y2 - y1
            bw = x2 - x1
            try:
                res_frame = cv2.resize(
                    res_frame.astype(np.uint8), (bw, bh),
                    interpolation=cv2.INTER_LANCZOS4,
                )
            except Exception:
                combined.append(ori)
                continue
            mask = prep.mask_list_cycle[i % n_cycle]
            mcb  = prep.mask_coords_list_cycle[i % n_cycle]
            # Color-correct the MuseTalk patch to match the source frame's
            # tone/brightness before blending — eliminates the visible seam
            # caused by the VAE output having slightly different color stats.
            src_region = ori[y1:y2, x1:x2]
            if src_region.shape == res_frame.shape:
                res_frame = _color_match(res_frame, src_region)
            if mask is None:
                # Fallback path — use our custom elliptical lip mask/blender
                combined.append(_fallback_blend(ori, res_frame, bbox))
            else:
                combined.append(get_image_blending(ori, res_frame, bbox, mask, mcb))

        logger.info(
            "MuseTalk synthesized %d frames in %.2fs",
            len(combined), time.monotonic() - t0,
        )
        # Save debug frames so we can visually verify blend quality
        try:
            if combined:
                cv2.imwrite("/tmp/musetalk_frame_000.jpg", combined[0])
                mid = len(combined) // 2
                cv2.imwrite("/tmp/musetalk_frame_mid.jpg", combined[mid])
                logger.info("MuseTalk: debug frames saved to /tmp/musetalk_frame_000.jpg and /tmp/musetalk_frame_mid.jpg")
        except Exception:
            pass
        if not combined:
            _last_synthesize_reason = "pipeline completed but produced 0 blended frames"
        else:
            _last_synthesize_reason = ""
        return combined

    except Exception as exc:
        _last_synthesize_reason = str(exc)
        logger.warning("MuseTalk synthesize failed: %s", exc, exc_info=True)
        return []

    finally:
        os.chdir(orig_cwd)


def get_last_synthesize_reason() -> str:
    return _last_synthesize_reason
