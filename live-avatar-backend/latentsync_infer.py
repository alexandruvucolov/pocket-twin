"""latentsync_infer.py — thin programmatic wrapper around LatentSync v1.6.

Exposes the same public API as musetalk_infer.py so main.py can swap
between backends with zero changes beyond the import name:

    prepare_avatar(source_frame_bgr, avatar_id, work_dir, bbox_shift=0)  →  AvatarPrep | None
    synthesize(prep, audio_path, fps=25)                                  →  list[np.ndarray] (BGR)

Graceful degradation: if LatentSync is not installed at LATENTSYNC_DIR
both functions return None / [] and main.py falls back to TPS warp.

LATENTSYNC_DIR defaults to /workspace/LatentSync (RunPod standard location)
but can be overridden via the LATENTSYNC_DIR environment variable.

Setup on the pod
----------------
  git clone https://github.com/bytedance/LatentSync /workspace/LatentSync
  cd /workspace/LatentSync
  pip install -r requirements.txt
  python -c "
    from huggingface_hub import snapshot_download
    snapshot_download('ByteDance/LatentSync-1.6', local_dir='checkpoints')
  "
  # In pod .env: LATENTSYNC_DIR=/workspace/LatentSync
"""
from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Path to the cloned LatentSync repository
# ---------------------------------------------------------------------------
LATENTSYNC_DIR = Path(os.environ.get("LATENTSYNC_DIR", "/workspace/LatentSync"))

# ---------------------------------------------------------------------------
# Global model cache — loaded once, reused for every synthesis call
# ---------------------------------------------------------------------------
_pipeline: Optional[Any] = None       # LipsyncPipeline instance
_models_available: Optional[bool] = None   # None = not yet probed
_models_load_lock = threading.Lock()       # prevent concurrent load attempts
_synthesis_lock = threading.Lock()         # only one synthesis at a time (pipeline is not thread-safe)

# Width / height expected by the loaded config ( set during _load_models )
_infer_width: int = 512
_infer_height: int = 512
_num_frames: int = 16              # from config.data.num_frames
_audio_feat_length: list = [2, 2]  # from config.data.audio_feat_length (must be a list)

_last_synthesize_reason: str = ""

# ---------------------------------------------------------------------------
# AvatarPrep — returned by prepare_avatar, passed to synthesize()
# ---------------------------------------------------------------------------

@dataclass
class AvatarPrep:
    """Holds the per-avatar state needed by LatentSync.

    Unlike MuseTalk the heavy GPU work happens at synthesis time, so prep
    only stores the looping source video path.
    """
    avatar_video_path: str        # short looping .mp4 built from source image
    source_frame_bgr: np.ndarray  # kept for possible future use


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _add_latentsync_to_path() -> None:
    """Add LATENTSYNC_DIR to sys.path so its packages are importable."""
    ls_str = str(LATENTSYNC_DIR)
    if ls_str not in sys.path:
        sys.path.insert(0, ls_str)


def _create_looping_video(
    source_frame_bgr: np.ndarray,
    out_path: str,
    fps: int = 25,
    duration_secs: float = 4.0,
) -> bool:
    """Write a short looping .mp4 from a single frame.

    LatentSync takes a video as input and loops/trims it to match the audio.
    A ~4-second clip is more than enough — the pipeline handles the rest.
    Returns True on success.
    """
    num_frames = max(1, int(fps * duration_secs))
    h, w = source_frame_bgr.shape[:2]

    # Resize to pipeline expected dimensions
    frame_resized = cv2.resize(
        source_frame_bgr, (_infer_width, _infer_height), interpolation=cv2.INTER_LANCZOS4
    )

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(out_path, fourcc, fps, (_infer_width, _infer_height))
    if not out.isOpened():
        logger.warning("LatentSync: cv2.VideoWriter failed to open %s", out_path)
        return False

    for _ in range(num_frames):
        out.write(frame_resized)
    out.release()
    logger.info("LatentSync: created looping video %s (%d frames @ %d fps)", out_path, num_frames, fps)
    return True


# ---------------------------------------------------------------------------
# _load_models
# ---------------------------------------------------------------------------

def _load_models() -> bool:
    """Load LatentSync pipeline (once).  Thread-safe via _models_load_lock.

    Returns True if models are loaded and ready, False otherwise.
    Must be called from inside LATENTSYNC_DIR context (cwd) because the
    LatentSync codebase resolves 'configs/' and 'checkpoints/' relative to CWD.
    """
    global _pipeline, _models_available, _infer_width, _infer_height  # type: ignore[misc]
    global _num_frames, _audio_feat_length
    global _last_synthesize_reason

    # Fast path — already known
    if _models_available is True:
        return True
    if _models_available is False:
        return False

    with _models_load_lock:
        if _models_available is not None:
            return _models_available is True

        orig_cwd = os.getcwd()
        try:
            if not LATENTSYNC_DIR.is_dir():
                _last_synthesize_reason = f"LATENTSYNC_DIR not found: {LATENTSYNC_DIR}"
                logger.warning(
                    "LatentSync: directory not found: %s — set LATENTSYNC_DIR env var",
                    LATENTSYNC_DIR,
                )
                _models_available = False
                return False

            _add_latentsync_to_path()
            os.chdir(LATENTSYNC_DIR)

            # ── Imports ────────────────────────────────────────────────────
            import torch  # noqa: PLC0415
            from omegaconf import OmegaConf  # noqa: PLC0415
            from diffusers import AutoencoderKL, DDIMScheduler  # noqa: PLC0415

            try:
                from latentsync.models.unet import UNet3DConditionModel  # noqa: PLC0415
                from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline  # noqa: PLC0415
                from latentsync.whisper.audio2feature import Audio2Feature  # noqa: PLC0415
            except ImportError as exc:
                _last_synthesize_reason = f"LatentSync package import failed: {exc}"
                logger.warning("LatentSync package not importable: %s", exc)
                _models_available = False
                return False

            # ── Config ─────────────────────────────────────────────────────
            config_path = LATENTSYNC_DIR / "configs" / "unet" / "stage2_512.yaml"
            if not config_path.exists():
                _last_synthesize_reason = f"Missing config file: {config_path}"
                logger.warning("LatentSync: config not found: %s", config_path)
                _models_available = False
                return False

            config = OmegaConf.load(str(config_path))
            _infer_width  = int(getattr(config.data, "resolution", 512))
            _infer_height = _infer_width
            _num_frames   = int(getattr(config.data, "num_frames", 16))
            _audio_feat_length_raw = getattr(config.data, "audio_feat_length", [2, 2])
            # audio_feat_length must be kept as a list — Audio2Feature does self.audio_feat_length[0]
            if hasattr(_audio_feat_length_raw, "__iter__"):
                _audio_feat_length = [int(v) for v in _audio_feat_length_raw]
            else:
                _audio_feat_length = [int(_audio_feat_length_raw)]
            dtype = torch.float16

            logger.info(
                "LatentSync: config loaded — resolution=%d num_frames=%d audio_feat_length=%s",
                _infer_width, _num_frames, _audio_feat_length,
            )

            # ── Scheduler ──────────────────────────────────────────────────
            scheduler = DDIMScheduler.from_pretrained(str(LATENTSYNC_DIR / "configs"))

            # ── Whisper audio encoder ──────────────────────────────────────
            cross_attn_dim = int(
                OmegaConf.to_container(config.model, resolve=True)
                .get("cross_attention_dim", 384)
            )
            preferred_whisper = "tiny.pt" if cross_attn_dim <= 384 else "small.pt"
            whisper_dir = LATENTSYNC_DIR / "checkpoints" / "whisper"
            preferred_path = whisper_dir / preferred_whisper

            if preferred_path.exists():
                whisper_path = str(preferred_path)
            else:
                fallback = None
                if whisper_dir.is_dir():
                    for candidate in ("small.pt", "tiny.pt"):
                        candidate_path = whisper_dir / candidate
                        if candidate_path.exists():
                            fallback = candidate_path
                            break
                    if fallback is None:
                        for candidate_path in sorted(whisper_dir.glob("*.pt")):
                            fallback = candidate_path
                            break

                if fallback is None:
                    # Auto-heal missing whisper checkpoints by downloading from HF.
                    try:
                        from huggingface_hub import hf_hub_download  # noqa: PLC0415

                        whisper_dir.mkdir(parents=True, exist_ok=True)
                        download_candidates = [preferred_whisper, "small.pt", "tiny.pt"]
                        seen = set()
                        for candidate in download_candidates:
                            if candidate in seen:
                                continue
                            seen.add(candidate)
                            try:
                                downloaded_path = hf_hub_download(
                                    repo_id="ByteDance/LatentSync-1.6",
                                    filename=f"whisper/{candidate}",
                                    local_dir=str(LATENTSYNC_DIR / "checkpoints"),
                                )
                                if Path(downloaded_path).exists():
                                    fallback = Path(downloaded_path)
                                    logger.warning(
                                        "LatentSync: downloaded missing whisper checkpoint %s",
                                        downloaded_path,
                                    )
                                    break
                            except Exception as dl_exc:
                                logger.warning(
                                    "LatentSync: failed to download whisper/%s: %s",
                                    candidate,
                                    dl_exc,
                                )
                    except Exception as import_exc:
                        logger.warning(
                            "LatentSync: huggingface_hub unavailable for whisper download: %s",
                            import_exc,
                        )

                if fallback is None:
                    _last_synthesize_reason = (
                        f"Missing whisper checkpoint: {preferred_path}"
                    )
                    logger.warning(
                        "LatentSync: whisper checkpoint not found: %s", preferred_path
                    )
                    _models_available = False
                    return False

                whisper_path = str(fallback)
                logger.warning(
                    "LatentSync: preferred whisper %s missing, falling back to %s",
                    preferred_whisper,
                    whisper_path,
                )

            audio_encoder = Audio2Feature(
                model_path=whisper_path,
                device="cuda",
                num_frames=_num_frames,
                audio_feat_length=_audio_feat_length,
            )

            # ── VAE ────────────────────────────────────────────────────────
            vae = AutoencoderKL.from_pretrained(
                "stabilityai/sd-vae-ft-mse", torch_dtype=dtype
            )
            vae.config.scaling_factor = 0.18215
            vae.config.shift_factor = 0

            # ── UNet ───────────────────────────────────────────────────────
            ckpt_path = str(LATENTSYNC_DIR / "checkpoints" / "latentsync_unet.pt")
            if not Path(ckpt_path).exists():
                _last_synthesize_reason = f"Missing UNet checkpoint: {ckpt_path}"
                logger.warning("LatentSync: UNet checkpoint not found: %s", ckpt_path)
                _models_available = False
                return False

            unet, _ = UNet3DConditionModel.from_pretrained(
                OmegaConf.to_container(config.model, resolve=True),
                ckpt_path,
                device="cpu",
            )
            unet = unet.to(dtype=dtype)

            # ── Assemble pipeline ──────────────────────────────────────────
            pipe = LipsyncPipeline(
                vae=vae,
                audio_encoder=audio_encoder,
                unet=unet,
                scheduler=scheduler,
            ).to("cuda")

            # ── Optional DeepCache for ~2× inference speed ─────────────────
            try:
                from deepcache import DeepCacheSDHelper  # noqa: PLC0415

                helper = DeepCacheSDHelper(pipe=pipe)
                helper.set_params(cache_interval=3, cache_branch_id=0)
                helper.enable()
                logger.info("LatentSync: DeepCache enabled")
            except Exception as dc_exc:
                logger.info("LatentSync: DeepCache not available (%s), skipping", dc_exc)

            # ── xformers memory-efficient attention (~20% faster per step) ──
            try:
                pipe.enable_xformers_memory_efficient_attention()
                logger.info("LatentSync: xformers memory-efficient attention enabled")
            except Exception as xf_exc:
                logger.info("LatentSync: xformers not available (%s), skipping", xf_exc)


            _pipeline = pipe
            _models_available = True
            _last_synthesize_reason = ""
            logger.info("LatentSync: pipeline loaded successfully")
            return True

        except Exception as exc:
            _last_synthesize_reason = f"Model loading exception: {exc}"
            logger.warning("LatentSync: model loading failed: %s", exc, exc_info=True)
            _models_available = False
            return False

        finally:
            os.chdir(orig_cwd)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def prepare_avatar(
    source_frame_bgr: np.ndarray,
    avatar_id: str,
    work_dir: str = "/tmp/latentsync_avatars",
    bbox_shift: int = 0,  # accepted for API compat with musetalk_infer, ignored
) -> "AvatarPrep | None":
    """One-time preparation for a source portrait.

    Saves a short looping video built from ``source_frame_bgr`` to disk and
    returns an ``AvatarPrep`` dataclass that is passed to every
    ``synthesize()`` call for this avatar.

    The ``bbox_shift`` parameter is accepted for API compatibility with the
    MuseTalk backend but is ignored by LatentSync.

    Returns ``None`` if LatentSync is unavailable.
    Takes <1 s (just writing video frames), unlike MuseTalk's 2-5 s GPU prep.
    """
    # Trigger model load on first call (warm-up).  Even if models are still
    # loading we can still create the video file — the actual GPU work happens
    # in synthesize().
    if not _load_models():
        return None

    try:
        avatar_dir = Path(work_dir) / avatar_id
        avatar_dir.mkdir(parents=True, exist_ok=True)

        video_path = str(avatar_dir / "source_loop.mp4")
        ok = _create_looping_video(source_frame_bgr, video_path, fps=25, duration_secs=4.0)
        if not ok:
            logger.warning("LatentSync: failed to create looping video for avatar %s", avatar_id)
            return None

        logger.info("LatentSync: avatar '%s' prepared — video: %s", avatar_id, video_path)
        return AvatarPrep(
            avatar_video_path=video_path,
            source_frame_bgr=source_frame_bgr.copy(),
        )

    except Exception as exc:
        logger.warning("LatentSync: prepare_avatar failed: %s", exc)
        return None


def synthesize(
    prep: "AvatarPrep",
    audio_path: str,
    fps: int = 25,
) -> list[np.ndarray]:
    """Generate lip-synced frames for the given audio file.

    Parameters
    ----------
    prep       : AvatarPrep returned by ``prepare_avatar()``
    audio_path : path to an audio file (MP3 or WAV)
    fps        : output frames-per-second (default 25)

    Returns a list of BGR ``np.ndarray`` frames ready to stream via WebRTC.
    Returns ``[]`` on any failure so the caller can fall back to TPS warp.
    """
    global _last_synthesize_reason

    if prep is None:
        _last_synthesize_reason = "avatar prep is None"
        return []
    if not _load_models():
        _last_synthesize_reason = "models unavailable"
        return []
    if _pipeline is None:
        _last_synthesize_reason = "pipeline is None after load"
        return []

    orig_cwd = os.getcwd()
    tmp_out = None

    try:
        import torch  # noqa: PLC0415

        # LatentSync uses relative paths internally during inference too
        _add_latentsync_to_path()
        os.chdir(LATENTSYNC_DIR)

        t0 = time.monotonic()

        # ── Write output to a temp file ────────────────────────────────────
        tmp_fd, tmp_out = tempfile.mkstemp(suffix=".mp4", dir="/tmp")
        os.close(tmp_fd)

        # ── Run LatentSync pipeline ────────────────────────────────────────
        # Acquire lock: pipeline is a global singleton and not thread-safe.
        # A second session calling synthesize() concurrently would corrupt both.
        with _synthesis_lock:
            _pipeline(
                video_path=prep.avatar_video_path,
                audio_path=audio_path,
                video_out_path=tmp_out,
                num_inference_steps=10,
                guidance_scale=1.5,
                weight_dtype=torch.float16,
                width=_infer_width,
                height=_infer_height,
            )

        # ── Extract frames from output video ──────────────────────────────
        cap = cv2.VideoCapture(tmp_out)
        if not cap.isOpened():
            _last_synthesize_reason = "failed to open output video"
            logger.warning("LatentSync: could not open output video %s", tmp_out)
            return []

        frames: list[np.ndarray] = []
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            # LatentSync outputs RGB — convert to BGR for WebRTC track
            # (cv2.VideoCapture already reads BGR, so no conversion needed)
            frames.append(frame)
        cap.release()

        if not frames:
            _last_synthesize_reason = "output video contained 0 frames"
            logger.warning("LatentSync: output video had 0 frames")
            return []

        # Save a diagnostic frame for debugging
        try:
            mid = len(frames) // 2
            cv2.imwrite("/tmp/latentsync_frame_000.jpg", frames[0])
            cv2.imwrite("/tmp/latentsync_frame_mid.jpg", frames[mid])
            logger.info(
                "LatentSync: debug frames saved to /tmp/latentsync_frame_000.jpg"
            )
        except Exception:
            pass

        elapsed = time.monotonic() - t0
        logger.info(
            "LatentSync: synthesized %d frames in %.2fs (%.1f fps)",
            len(frames), elapsed, len(frames) / max(elapsed, 1e-3),
        )
        _last_synthesize_reason = ""
        return frames

    except Exception as exc:
        _last_synthesize_reason = str(exc)
        logger.warning("LatentSync: synthesize failed: %s", exc, exc_info=True)
        return []

    finally:
        os.chdir(orig_cwd)
        if tmp_out:
            try:
                os.unlink(tmp_out)
            except OSError:
                pass


def get_last_synthesize_reason() -> str:
    """Return a diagnostic string explaining why the last synthesize() returned [].

    Returns '' if the last call succeeded.
    """
    return _last_synthesize_reason
