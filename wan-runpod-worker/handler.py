"""
Pocket Twin – WAN 2.1 + FLUX RunPod Serverless Handler
Routes:
  task = "text_to_image"   → FLUX.1-schnell
  task = "text_to_video"   → Wan2.1 T2V 14B
  task = "image_to_video"  → Wan2.1 I2V 14B 480P
Output: uploads result to Firebase Storage, returns download URL.
"""

import os, io, time, base64, tempfile, uuid, logging
import runpod
import requests
import torch
import numpy as np

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("wan-worker")

VOLUME = os.environ.get("VOLUME_PATH", "/runpod-volume")
HF_HOME = os.environ.get("HF_HOME", f"{VOLUME}/hf_cache")
os.environ["HF_HOME"] = HF_HOME

FIREBASE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "")  # e.g. your-app.appspot.com

# ──────────────────────────────────────────────
# Lazy model cache
# ──────────────────────────────────────────────
_flux_pipe = None
_t2v_pipe  = None
_i2v_pipe  = None

def _get_flux():
    global _flux_pipe
    if _flux_pipe is None:
        from diffusers import FluxPipeline
        log.info("[LOAD] Loading FLUX.1-schnell …")
        t0 = time.time()
        _flux_pipe = FluxPipeline.from_pretrained(
            "black-forest-labs/FLUX.1-schnell",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        _flux_pipe.enable_model_cpu_offload()
        log.info(f"[LOAD] FLUX ready in {time.time()-t0:.1f}s")
    return _flux_pipe

def _get_t2v():
    global _t2v_pipe
    if _t2v_pipe is None:
        from diffusers import WanPipeline
        log.info("[LOAD] Loading Wan2.1 T2V 14B …")
        t0 = time.time()
        _t2v_pipe = WanPipeline.from_pretrained(
            "Wan-AI/Wan2.1-T2V-14B",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log.info(f"[LOAD] Wan T2V ready in {time.time()-t0:.1f}s")
    return _t2v_pipe

def _get_i2v():
    global _i2v_pipe
    if _i2v_pipe is None:
        from diffusers import WanImageToVideoPipeline
        from transformers import CLIPVisionModelWithProjection
        log.info("[LOAD] Loading Wan2.1 I2V 14B-480P …")
        t0 = time.time()
        image_encoder = CLIPVisionModelWithProjection.from_pretrained(
            "Wan-AI/Wan2.1-I2V-14B-480P",
            subfolder="image_encoder",
            torch_dtype=torch.float32,
        )
        _i2v_pipe = WanImageToVideoPipeline.from_pretrained(
            "Wan-AI/Wan2.1-I2V-14B-480P",
            image_encoder=image_encoder,
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log.info(f"[LOAD] Wan I2V ready in {time.time()-t0:.1f}s")
    return _i2v_pipe

# ──────────────────────────────────────────────
# Firebase Storage upload helper
# ──────────────────────────────────────────────
def _upload_to_firebase(data: bytes, filename: str, content_type: str) -> str:
    """Upload bytes to Firebase Storage, return public download URL."""
    if not FIREBASE_BUCKET:
        raise ValueError("FIREBASE_STORAGE_BUCKET env var not set")
    url = (
        f"https://firebasestorage.googleapis.com/v0/b/"
        f"{FIREBASE_BUCKET}/o?uploadType=media&name=generated%2F{filename}"
    )
    resp = requests.post(url, data=data, headers={"Content-Type": content_type}, timeout=120)
    resp.raise_for_status()
    token = resp.json().get("downloadTokens", "")
    encoded_name = f"generated%2F{filename}"
    download_url = (
        f"https://firebasestorage.googleapis.com/v0/b/{FIREBASE_BUCKET}/o/"
        f"{encoded_name}?alt=media&token={token}"
    )
    return download_url

# ──────────────────────────────────────────────
# Duration → frame count helper (Wan uses 16fps)
# ──────────────────────────────────────────────
FPS = 16
def _duration_to_frames(duration_str: str) -> int:
    seconds = int(duration_str.replace("s", ""))
    # Wan requires frames = k*4+1
    raw = seconds * FPS
    frames = ((raw - 1) // 4) * 4 + 1
    return max(frames, 17)  # minimum 17 (≈1s)

# ──────────────────────────────────────────────
# Task handlers
# ──────────────────────────────────────────────
def handle_text_to_image(job_input: dict) -> dict:
    prompt    = job_input["prompt"]
    negative  = job_input.get("negative_prompt", "blurry, low quality, distorted")
    width     = int(job_input.get("width", 1024))
    height    = int(job_input.get("height", 1024))
    steps     = int(job_input.get("num_inference_steps", 4))
    guidance  = float(job_input.get("guidance_scale", 0.0))
    seed      = job_input.get("seed", None)

    pipe = _get_flux()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    log.info(f"[IMAGE] Generating {width}x{height} steps={steps} …")
    t0 = time.time()
    result = pipe(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    img = result.images[0]
    log.info(f"[IMAGE] Done in {time.time()-t0:.1f}s")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    filename = f"{uuid.uuid4()}.png"
    url = _upload_to_firebase(buf.read(), filename, "image/png")
    return {"url": url, "task": "text_to_image"}


def handle_text_to_video(job_input: dict) -> dict:
    prompt    = job_input["prompt"]
    negative  = job_input.get("negative_prompt", "low quality, blurry, distorted, watermark")
    duration  = job_input.get("duration", "6s")
    width     = int(job_input.get("width", 832))
    height    = int(job_input.get("height", 480))
    steps     = int(job_input.get("num_inference_steps", 30))
    guidance  = float(job_input.get("guidance_scale", 5.0))
    seed      = job_input.get("seed", None)

    num_frames = _duration_to_frames(duration)
    pipe = _get_t2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    log.info(f"[T2V] {duration} = {num_frames} frames, {width}x{height} steps={steps} …")
    t0 = time.time()
    output = pipe(
        prompt=prompt,
        negative_prompt=negative,
        num_frames=num_frames,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[T2V] Inference done in {time.time()-t0:.1f}s")

    frames = output.frames[0]  # list of PIL images
    return _export_video(frames, "text_to_video")


def handle_image_to_video(job_input: dict) -> dict:
    from PIL import Image as PILImage

    prompt       = job_input["prompt"]
    negative     = job_input.get("negative_prompt", "low quality, blurry, distorted, watermark")
    image_b64    = job_input["image"]  # base64-encoded image
    duration     = job_input.get("duration", "6s")
    width        = int(job_input.get("width", 832))
    height       = int(job_input.get("height", 480))
    steps        = int(job_input.get("num_inference_steps", 30))
    guidance     = float(job_input.get("guidance_scale", 5.0))
    seed         = job_input.get("seed", None)

    # Decode reference image
    img_bytes = base64.b64decode(image_b64)
    ref_image = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
    ref_image = ref_image.resize((width, height))

    num_frames = _duration_to_frames(duration)
    pipe = _get_i2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    log.info(f"[I2V] {duration} = {num_frames} frames, {width}x{height} steps={steps} …")
    t0 = time.time()
    output = pipe(
        image=ref_image,
        prompt=prompt,
        negative_prompt=negative,
        num_frames=num_frames,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[I2V] Inference done in {time.time()-t0:.1f}s")

    frames = output.frames[0]
    return _export_video(frames, "image_to_video")


def _export_video(frames, task_name: str) -> dict:
    import imageio
    filename = f"{uuid.uuid4()}.mp4"
    tmp_path = f"/tmp/{filename}"

    log.info(f"[EXPORT] Writing {len(frames)} frames to {tmp_path} …")
    t0 = time.time()
    writer = imageio.get_writer(tmp_path, fps=FPS, codec="libx264", quality=8)
    for frame in frames:
        writer.append_data(np.array(frame))
    writer.close()
    log.info(f"[EXPORT] Done in {time.time()-t0:.1f}s")

    with open(tmp_path, "rb") as f:
        video_bytes = f.read()

    url = _upload_to_firebase(video_bytes, filename, "video/mp4")
    os.remove(tmp_path)
    return {"url": url, "task": task_name, "frames": len(frames)}


# ──────────────────────────────────────────────
# RunPod entrypoint
# ──────────────────────────────────────────────
def handler(job):
    job_input = job.get("input", {})

    # Warmup ping
    if job_input.get("warmup"):
        return {"status": "warmed"}

    task = job_input.get("task")
    if not task:
        return {"error": "Missing 'task' field. Use: text_to_image | text_to_video | image_to_video"}

    try:
        if task == "text_to_image":
            return handle_text_to_image(job_input)
        elif task == "text_to_video":
            return handle_text_to_video(job_input)
        elif task == "image_to_video":
            return handle_image_to_video(job_input)
        else:
            return {"error": f"Unknown task: {task}"}
    except Exception as e:
        log.exception(f"[ERROR] Task {task} failed")
        return {"error": str(e)}


runpod.serverless.start({"handler": handler})
