"""RunPod serverless handler for LatentSync lip-sync generation.

Input schema
------------
{
  "source_image_url":       str   (public URL of avatar image)
  "source_image_base64":    str   (base64-encoded image, alternative to URL)
  "source_image_mime_type": str   (default "image/jpeg")
  "audio_base64":           str   (base64-encoded MP3/WAV)
  "audio_url":              str   (public URL of audio file, alternative to base64)
  "num_inference_steps":    int   (default 10)
  "bbox_shift":             int   (default 0, use -15 for tighter crop)
}

Output schema
-------------
{ "video_url": "<public URL of lip-sync MP4>" }

The output video has audio muxed in.
Upload is done via tmpfiles.org (free, no auth, 60 min expiry).
"""
from __future__ import annotations

import base64
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import requests
import runpod

# ---------------------------------------------------------------------------
# LatentSync location — matches the persistent-pod convention
# ---------------------------------------------------------------------------
LATENTSYNC_DIR = Path(os.environ.get("LATENTSYNC_DIR", "/workspace/LatentSync"))


def _add_to_path() -> None:
    ls_str = str(LATENTSYNC_DIR)
    if ls_str not in sys.path:
        sys.path.insert(0, ls_str)


# ---------------------------------------------------------------------------
# Lazy model singleton (warmed once per worker process)
# ---------------------------------------------------------------------------
_pipeline = None
_models_loaded = False


def _ensure_models_loaded() -> None:
    global _pipeline, _models_loaded
    if _models_loaded:
        return
    _add_to_path()

    # latentsync_infer.py lives alongside handler.py in the same directory
    # so we can import directly and call its private loader.
    import latentsync_infer as lsi  # type: ignore[import-untyped]
    ok = lsi._load_models()
    if not ok:
        reason = lsi.get_last_synthesize_reason() or "unknown — check worker logs"
        raise RuntimeError(f"LatentSync model loading failed: {reason}")
    _pipeline = lsi._pipeline
    _models_loaded = True


# ---------------------------------------------------------------------------
# Upload helper — tmpfiles.org (free, 60-min expiry, 1 GB limit)
# ---------------------------------------------------------------------------

def _upload_video(video_path: str) -> str:
    """Upload video and return a public direct-download URL."""
    with open(video_path, "rb") as f:
        resp = requests.post(
            "https://tmpfiles.org/api/v1/upload",
            files={"file": (Path(video_path).name, f, "video/mp4")},
            timeout=120,
        )
    resp.raise_for_status()
    data = resp.json()
    # Response: {"status": "success", "data": {"url": "https://tmpfiles.org/123/file.mp4"}}
    url: str = data["data"]["url"]
    # Convert browse URL to direct-download URL
    url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)
    return url


# ---------------------------------------------------------------------------
# Main handler
# ---------------------------------------------------------------------------

def handler(job: dict[str, Any]) -> dict[str, Any]:
    """Entry point called by RunPod for each request."""
    job_input: dict[str, Any] = job.get("input", {})

    source_image_url: str | None = job_input.get("source_image_url")
    source_image_base64: str | None = job_input.get("source_image_base64")
    source_image_mime_type: str = job_input.get("source_image_mime_type", "image/jpeg")
    audio_base64: str | None = job_input.get("audio_base64")
    audio_url: str | None = job_input.get("audio_url")
    num_inference_steps: int = int(job_input.get("num_inference_steps", 6))
    bbox_shift: int = int(job_input.get("bbox_shift", 0))

    if not source_image_url and not source_image_base64:
        return {"error": "Missing source image. Provide source_image_url or source_image_base64."}
    if not audio_base64 and not audio_url:
        return {"error": "Missing audio. Provide audio_base64 or audio_url."}

    try:
        _ensure_models_loaded()
    except Exception as exc:
        print(f"[Handler] Model loading failed: {exc}")
        return {"error": f"Model loading failed: {exc}"}

    with tempfile.TemporaryDirectory() as tmpdir_str:
        tmpdir = Path(tmpdir_str)

        # ── Decode / download source image ─────────────────────────────────
        image_ext = ".png" if "png" in source_image_mime_type else ".jpg"
        image_path = tmpdir / f"source{image_ext}"

        if source_image_url:
            r = requests.get(source_image_url, timeout=30)
            r.raise_for_status()
            image_path.write_bytes(r.content)
        else:
            image_path.write_bytes(base64.b64decode(source_image_base64))  # type: ignore[arg-type]

        # ── Decode / download audio ─────────────────────────────────────────
        audio_path = tmpdir / "audio.mp3"

        if audio_url:
            r = requests.get(audio_url, timeout=30)
            r.raise_for_status()
            audio_path.write_bytes(r.content)
        else:
            audio_path.write_bytes(base64.b64decode(audio_base64))  # type: ignore[arg-type]

        # ── Run LatentSync inference ────────────────────────────────────────
        _add_to_path()
        import cv2  # type: ignore[import-untyped]
        import numpy as np  # type: ignore[import-untyped]
        import latentsync_infer as lsi  # type: ignore[import-untyped]

        # Override inference steps for faster results
        original_steps = None
        try:
            import latentsync_infer as lsi_mod
            if hasattr(lsi_mod, "_pipeline") and lsi_mod._pipeline is not None:
                original_steps = getattr(lsi_mod._pipeline, "num_inference_steps", None)
        except Exception:
            pass

        img_bgr = cv2.imread(str(image_path))
        if img_bgr is None:
            return {"error": "Failed to decode source image (cv2.imread returned None)."}

        work_dir = str(tmpdir / "work")
        os.makedirs(work_dir, exist_ok=True)

        prep = lsi.prepare_avatar(img_bgr, "serverless_job", work_dir, bbox_shift=bbox_shift)
        if prep is None:
            return {"error": "LatentSync prepare_avatar failed — models may not be loaded."}

        frames: list[np.ndarray] = lsi.synthesize(prep, str(audio_path), fps=25, num_inference_steps=num_inference_steps)
        if not frames:
            return {"error": "Synthesis returned no frames."}

        # ── Write raw video ─────────────────────────────────────────────────
        h, w = frames[0].shape[:2]
        raw_video_path = str(tmpdir / "raw.mp4")
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(raw_video_path, fourcc, 25, (w, h))
        for frame in frames:
            writer.write(frame)
        writer.release()

        # ── Mux audio into video ────────────────────────────────────────────
        final_path = str(tmpdir / "output.mp4")
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", raw_video_path,
                    "-i", str(audio_path),
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-crf", "23",
                    "-c:a", "aac",
                    "-b:a", "128k",
                    "-shortest",
                    final_path,
                ],
                check=True,
                capture_output=True,
                timeout=120,
            )
        except subprocess.CalledProcessError as e:
            # Fallback: return raw video without audio
            print(f"[Handler] ffmpeg mux failed: {e.stderr.decode()[:500]}; returning raw video")
            final_path = raw_video_path

        # ── Upload & return ─────────────────────────────────────────────────
        video_url = _upload_video(final_path)
        return {"video_url": video_url}


def _warmup_models_on_startup() -> None:
    """Best-effort model warmup at worker startup.

    This avoids charging the first request for model download/load time,
    which can trigger execution-time throttling on strict endpoints.
    """
    warmup_flag = os.environ.get("WARMUP_MODELS_ON_STARTUP", "0").strip().lower()
    if warmup_flag in {"0", "false", "no", "off"}:
        print("[Startup] Model warmup disabled via WARMUP_MODELS_ON_STARTUP")
        return

    try:
        print("[Startup] Warming LatentSync models...")
        _ensure_models_loaded()
        print("[Startup] Model warmup complete")
    except Exception as exc:
        print(f"[Startup] Model warmup failed (worker will stay up): {exc}")


_warmup_models_on_startup()
runpod.serverless.start({"handler": handler})
