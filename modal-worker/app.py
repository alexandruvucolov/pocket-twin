"""
Pocket Twin – Modal Serverless Worker
Handles: text_to_image (FLUX.1-schnell) | text_to_video (Wan2.1 T2V 14B) | image_to_video (Wan2.1 I2V 14B 480P)

Deploy:
    modal deploy modal-worker/app.py

Endpoints after deploy:
    Image  → https://alexandru-vucolov--pocket-twin-image.modal.run   (A10G, cheap)
    Video  → https://alexandru-vucolov--pocket-twin-video.modal.run   (H100, fast)

Secrets required in Modal dashboard:
    FIREBASE_STORAGE_BUCKET   e.g. your-app.firebasestorage.app
"""

import io, os, uuid, base64, time, logging
from typing import Literal

import modal

# ─── Container image ──────────────────────────────────────────────────────────

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "fastapi[standard]>=0.115.0",
        "torch>=2.4.0",
        "torchvision",
        "diffusers>=0.33.0",
        "transformers>=4.46.0",
        "accelerate>=0.34.0",
        "huggingface_hub>=0.24.0",
        "imageio[ffmpeg]>=2.34.0",
        "Pillow>=10.0.0",
        "numpy>=1.26.0",
        "requests>=2.31.0",
        "sentencepiece",
        "ftfy",
        index_url="https://download.pytorch.org/whl/cu124",
        extra_options="--extra-index-url https://pypi.org/simple",
    )
)

# ─── Persistent volume for model weights ─────────────────────────────────────

volume = modal.Volume.from_name("pocket-twin-models", create_if_missing=True)
VOLUME_PATH = "/models"
HF_HOME = f"{VOLUME_PATH}/hf_cache"

# ─── App ──────────────────────────────────────────────────────────────────────

app = modal.App("pocket-twin-create", image=image)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("modal-worker")

FPS = 8

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _duration_to_frames(duration_str: str) -> int:
    seconds = int(duration_str.replace("s", ""))
    raw = seconds * FPS
    frames = ((raw - 1) // 4) * 4 + 1
    return max(frames, 17)


def _upload_to_firebase(data: bytes, filename: str, content_type: str) -> str:
    import requests as req
    bucket = os.environ["FIREBASE_STORAGE_BUCKET"]
    url = (
        f"https://firebasestorage.googleapis.com/v0/b/"
        f"{bucket}/o?uploadType=media&name=generated%2F{filename}"
    )
    resp = req.post(url, data=data, headers={"Content-Type": content_type}, timeout=120)
    resp.raise_for_status()
    token = resp.json().get("downloadTokens", "")
    encoded_name = f"generated%2F{filename}"
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket}/o/"
        f"{encoded_name}?alt=media&token={token}"
    )


# ─── Model loading (module-level cache, stays alive in scaledown_window) ──────

_flux_pipe = None
_flux_img2img_pipe = None
_t2v_pipe = None
_i2v_pipe = None


def _get_flux():
    global _flux_pipe
    if _flux_pipe is None:
        import torch
        from diffusers import FluxPipeline
        # expandable_segments reduces fragmentation during multi-step generation
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        log.info("[LOAD] FLUX.1-schnell …")
        t0 = time.time()
        _flux_pipe = FluxPipeline.from_pretrained(
            "black-forest-labs/FLUX.1-schnell",
            torch_dtype=torch.bfloat16,
        )
        # sequential offload moves individual transformer layers to GPU one at a time
        # — much lower peak VRAM than enable_model_cpu_offload() which loads the
        # whole transformer (~23 GB) at once and OOMs on 22 GB A10G
        _flux_pipe.enable_sequential_cpu_offload()
        _flux_pipe.vae.enable_slicing()
        _flux_pipe.vae.enable_tiling()
        log.info(f"[LOAD] FLUX ready in {time.time()-t0:.1f}s")
    return _flux_pipe


def _get_flux_img2img():
    global _flux_img2img_pipe
    if _flux_img2img_pipe is None:
        from diffusers import AutoPipelineForImage2Image
        log.info("[LOAD] FLUX img2img (reusing weights from text2image pipe)…")
        t0 = time.time()
        # from_pipe shares all the loaded weights — no extra VRAM
        _flux_img2img_pipe = AutoPipelineForImage2Image.from_pipe(_get_flux())
        log.info(f"[LOAD] FLUX img2img ready in {time.time()-t0:.1f}s")
    return _flux_img2img_pipe


def _get_t2v():
    global _t2v_pipe
    if _t2v_pipe is None:
        import torch
        from diffusers import AutoencoderKLWan, WanPipeline
        log.info("[LOAD] Wan2.1 T2V 14B …")
        t0 = time.time()
        vae = AutoencoderKLWan.from_pretrained(
            "Wan-AI/Wan2.1-T2V-14B-Diffusers",
            subfolder="vae",
            torch_dtype=torch.float32,
        )
        _t2v_pipe = WanPipeline.from_pretrained(
            "Wan-AI/Wan2.1-T2V-14B-Diffusers",
            vae=vae,
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log.info(f"[LOAD] Wan T2V ready in {time.time()-t0:.1f}s")
    return _t2v_pipe


def _get_i2v():
    global _i2v_pipe
    if _i2v_pipe is None:
        import torch
        from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
        from transformers import CLIPVisionModel
        log.info("[LOAD] Wan2.1 I2V 14B-480P …")
        t0 = time.time()
        vae = AutoencoderKLWan.from_pretrained(
            "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
            subfolder="vae",
            torch_dtype=torch.float32,
        )
        image_encoder = CLIPVisionModel.from_pretrained(
            "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
            subfolder="image_encoder",
            torch_dtype=torch.float32,
        )
        _i2v_pipe = WanImageToVideoPipeline.from_pretrained(
            "Wan-AI/Wan2.1-I2V-14B-480P-Diffusers",
            vae=vae,
            image_encoder=image_encoder,
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        log.info(f"[LOAD] Wan I2V ready in {time.time()-t0:.1f}s")
    return _i2v_pipe


# ─── Download function (run once to pre-populate volume) ─────────────────────

@app.function(
    volumes={VOLUME_PATH: volume},
    image=image,
    gpu="H100",
    timeout=7200,
    secrets=[modal.Secret.from_name("pocket-twin")],
)
def download_models():
    """
    Pre-downloads all model weights to the Modal volume.
    Run once with: modal run modal-worker/app.py::download_models
    """
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HUGGINGFACE_HUB_TOKEN"] = os.environ.get("HF_TOKEN", "")
    from huggingface_hub import snapshot_download

    print("=== Downloading FLUX.1-schnell ===")
    snapshot_download("black-forest-labs/FLUX.1-schnell", ignore_patterns=["*.gguf"])
    print("=== Downloading Wan2.1-T2V-14B-Diffusers ===")
    snapshot_download("Wan-AI/Wan2.1-T2V-14B-Diffusers")
    print("=== Downloading Wan2.1-I2V-14B-480P-Diffusers ===")
    snapshot_download("Wan-AI/Wan2.1-I2V-14B-480P-Diffusers")

    volume.commit()
    print("=== All models downloaded and committed to volume ===")


# ─── IMAGE endpoint — A10G (~$0.60/hr, 6× cheaper than H100) ─────────────────
#     FLUX.1-schnell fits comfortably in 24 GB A10G VRAM
#     scaledown_window=600 keeps it warm for 10 min to amortize cold starts

@app.function(
    volumes={VOLUME_PATH: volume},
    image=image,
    gpu="A10G",
    timeout=300,
    scaledown_window=600,
    secrets=[modal.Secret.from_name("pocket-twin")],
)
@modal.fastapi_endpoint(method="POST", label="pocket-twin-image")
def create_image(body: dict) -> dict:
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HUGGINGFACE_HUB_TOKEN"] = os.environ.get("HF_TOKEN", "")

    task: str = body.get("task", "")

    if task == "warmup":
        return {"status": "warmed"}

    if task not in ("text_to_image", "image_to_image"):
        return {"error": f"This endpoint handles text_to_image | image_to_image, got: {task}"}

    try:
        if task == "image_to_image":
            return _handle_image_to_image(body)
        return _handle_text_to_image(body)
    except Exception as e:
        log.exception(f"[ERROR] {task}")
        return {"error": str(e)}


# ─── VIDEO endpoint — H100 (required for Wan2.1 14B models) ──────────────────

@app.function(
    volumes={VOLUME_PATH: volume},
    image=image,
    gpu="H100",
    timeout=1800,
    scaledown_window=300,
    secrets=[modal.Secret.from_name("pocket-twin")],
)
@modal.fastapi_endpoint(method="POST", label="pocket-twin-video")
def create_video(body: dict) -> dict:
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HUGGINGFACE_HUB_TOKEN"] = os.environ.get("HF_TOKEN", "")

    task: str = body.get("task", "")

    if task == "warmup":
        return {"status": "warmed"}

    try:
        if task == "text_to_video":
            return _handle_text_to_video(body)
        elif task == "image_to_video":
            return _handle_image_to_video(body)
        else:
            return {"error": f"This endpoint handles text_to_video | image_to_video, got: {task}"}
    except Exception as e:
        log.exception(f"[ERROR] task={task}")
        return {"error": str(e)}


# ─── Task implementations ─────────────────────────────────────────────────────

def _handle_text_to_image(body: dict) -> dict:
    import torch

    prompt   = body["prompt"]
    width    = int(body.get("width", 768))
    height   = int(body.get("height", 768))
    steps    = int(body.get("num_inference_steps", 4))
    guidance = float(body.get("guidance_scale", 0.0))
    seed     = body.get("seed")

    pipe = _get_flux()
    generator = torch.Generator("cpu").manual_seed(seed) if seed is not None else None

    torch.cuda.empty_cache()
    log.info(f"[IMAGE] {width}x{height} steps={steps}")
    t0 = time.time()
    result = pipe(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[IMAGE] Done in {time.time()-t0:.1f}s")

    buf = io.BytesIO()
    result.images[0].save(buf, format="PNG")
    # Return base64 directly — no Firebase needed for images (~2-4 MB)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return {"base64": b64, "task": "text_to_image"}


def _handle_image_to_image(body: dict) -> dict:
    import torch
    from PIL import Image as PILImage

    prompt    = body["prompt"]
    image_b64 = body["image"]
    width     = int(body.get("width", 768))
    height    = int(body.get("height", 768))
    # More steps than t2i because strength reduces effective steps
    steps     = int(body.get("num_inference_steps", 8))
    guidance  = float(body.get("guidance_scale", 0.0))
    # strength: 0=keep original, 1=ignore original. 0.75 = strong modification
    strength  = float(body.get("strength", 0.75))
    seed      = body.get("seed")

    ref_image = (
        PILImage.open(io.BytesIO(base64.b64decode(image_b64)))
        .convert("RGB")
        .resize((width, height))
    )

    pipe = _get_flux_img2img()
    generator = torch.Generator("cpu").manual_seed(seed) if seed is not None else None

    torch.cuda.empty_cache()
    log.info(f"[IMG2IMG] strength={strength} steps={steps} {width}x{height}")
    t0 = time.time()
    result = pipe(
        prompt=prompt,
        image=ref_image,
        strength=strength,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[IMG2IMG] Done in {time.time()-t0:.1f}s")

    buf = io.BytesIO()
    result.images[0].save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return {"base64": b64, "task": "image_to_image"}


def _handle_text_to_video(body: dict) -> dict:
    import torch, numpy as np

    prompt   = body["prompt"]
    negative = body.get("negative_prompt", "low quality, blurry, distorted, watermark")
    duration = body.get("duration", "6s")
    width    = int(body.get("width", 832))
    height   = int(body.get("height", 480))
    steps    = int(body.get("num_inference_steps", 20))
    guidance = float(body.get("guidance_scale", 5.0))
    seed     = body.get("seed")

    num_frames = _duration_to_frames(duration)
    pipe = _get_t2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    log.info(f"[T2V] {duration} → {num_frames} frames")
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
    log.info(f"[T2V] Done in {time.time()-t0:.1f}s")
    return _export_video(output.frames[0], "text_to_video")


def _handle_image_to_video(body: dict) -> dict:
    import torch, numpy as np
    from PIL import Image as PILImage

    prompt    = body["prompt"]
    negative  = body.get("negative_prompt", "low quality, blurry, distorted, watermark")
    image_b64 = body["image"]
    duration  = body.get("duration", "6s")
    width     = int(body.get("width", 832))
    height    = int(body.get("height", 480))
    steps     = int(body.get("num_inference_steps", 20))
    guidance  = float(body.get("guidance_scale", 5.0))
    seed      = body.get("seed")

    ref_image = PILImage.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB").resize((width, height))

    num_frames = _duration_to_frames(duration)
    pipe = _get_i2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    log.info(f"[I2V] {duration} → {num_frames} frames")
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
    log.info(f"[I2V] Done in {time.time()-t0:.1f}s")
    return _export_video(output.frames[0], "image_to_video")


def _export_video(frames, task_name: str) -> dict:
    import imageio, numpy as np

    tmp = f"/tmp/{uuid.uuid4()}.mp4"
    writer = imageio.get_writer(tmp, fps=FPS, codec="libx264", quality=8)
    for frame in frames:
        writer.append_data(np.array(frame))
    writer.close()

    with open(tmp, "rb") as f:
        video_bytes = f.read()
    os.remove(tmp)

    url = _upload_to_firebase(video_bytes, f"{uuid.uuid4()}.mp4", "video/mp4")
    return {"url": url, "task": task_name, "frames": len(frames)}

