"""
Pocket Twin – Modal Serverless Worker
Handles:
  text_to_image  (FLUX.1-schnell)               → A10G
  text_to_video  (HunyuanVideo T2V ~40 GB)      → H100
  image_to_video (CogVideoX-5b-I2V ~18 GB)      → H100
  lip_sync       (LatentSync 1.6)               → A100-40GB

Deploy:
    modal deploy modal-worker/app.py

Download LatentSync models (once):
    modal run modal-worker/app.py::download_latentsync_models

Endpoints after deploy:
    Image   → https://alexandru-vucolov--pocket-twin-image.modal.run
    Video   → https://alexandru-vucolov--pocket-twin-video.modal.run
    Lipsync → https://alexandru-vucolov--pocket-twin-lipsync.modal.run

Secrets required in Modal dashboard (secret name: pocket-twin):
    FIREBASE_STORAGE_BUCKET   e.g. your-app.firebasestorage.app
    HF_TOKEN                  HuggingFace token (for gated models)
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

# ─── Video image — HunyuanVideo weights loaded from volume at runtime ───────────
# Model is ~40 GB — too large to bake into the container image.
# Populate the volume once with: modal run modal-worker/app.py::download_models

video_image = image

# ─── LatentSync container image ───────────────────────────────────────────────
# Separate from the main image to keep LatentSync's many deps isolated.
# Clones the LatentSync repo at build time so inference code is always present.

LATENTSYNC_DIR = "/workspace/LatentSync"

lipsync_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install(
        "git", "ffmpeg",
        "build-essential", "clang",
        "libgl1-mesa-glx", "libglib2.0-0",
        "libsm6", "libxext6", "libxrender1",
    )
    .pip_install(
        "torch>=2.4.0",
        "torchvision",
        "torchaudio",
        index_url="https://download.pytorch.org/whl/cu124",
        extra_options="--extra-index-url https://pypi.org/simple",
    )
    .run_commands(
        # Clone the LatentSync repo
        f"git clone https://github.com/bytedance/LatentSync {LATENTSYNC_DIR}",
        # Install LatentSync's requirements, excluding torch (already installed above).
        # Also pin mediapipe and decord to versions with Python 3.11 wheels.
        f'grep -vE "^torch(vision|audio)?[=><!]|^--extra-index-url|^mediapipe|^decord" '
        f'  {LATENTSYNC_DIR}/requirements.txt > /tmp/ls_reqs.txt && '
        f'echo "mediapipe>=0.10.13" >> /tmp/ls_reqs.txt && '
        f'echo "decord>=0.6.0" >> /tmp/ls_reqs.txt && '
        f'pip install --no-cache-dir -r /tmp/ls_reqs.txt',
    )
    .pip_install(
        "requests>=2.31.0",
        "opencv-python-headless>=4.8.0",
        "huggingface_hub>=0.24.0",
        "numpy>=1.26.0",
        "fastapi[standard]>=0.115.0",
    )
    .env({"LATENTSYNC_DIR": LATENTSYNC_DIR, "PYTHONPATH": "/app", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"})
    # Embed the inference wrapper so it's importable at /app/latentsync_infer.py
    .add_local_file(
        "live-avatar-backend/latentsync_infer.py",
        "/app/latentsync_infer.py",
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

HUNYUAN_FPS = 8    # 8 fps — 3× fewer frames to VAE-decode, prevents hang

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _duration_to_frames(duration_str: str) -> int:
    """Convert '6s'/'10s' to a frame count valid for HunyuanVideo.
    HunyuanVideo requires: (num_frames - 1) % 4 == 0
    Since HUNYUAN_FPS=24 is divisible by 4, seconds*24+1 always satisfies this.
    e.g. 6s → 145, 10s → 241 — both valid.
    """
    seconds = int(duration_str.replace("s", ""))
    return max(9, seconds * HUNYUAN_FPS + 1)


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
_hunyuan_t2v_pipe = None
_hunyuan_i2v_pipe = None  # CogVideoX-5b-I2V — loaded on first I2V request

# LatentSync — lives in lipsync_image containers only
_ls_infer = None          # latentsync_infer module reference
_ls_loaded = False        # True once _load_models() succeeded

# Avatar prep cache: image URL → AvatarPrep (looping video lives in /tmp/avatar_cache)
# Since max_containers=1 the same container handles all requests, so this persists
# across turns for the full scaledown_window (5 min).  Saves re-downloading the
# avatar image (~3-5 s) and re-creating the looping video (~1 s) every turn.
_AVATAR_CACHE_DIR = "/tmp/avatar_cache"
_avatar_prep_cache: dict = {}  # cache_key → AvatarPrep


def _ensure_lipsync_loaded() -> tuple[bool, str]:
    """Symlink checkpoints, load the LatentSync pipeline, cache globally.
    Safe to call multiple times — no-op after the first successful load.
    Returns (ok, error_reason).
    """
    import sys
    if "/app" not in sys.path:
        sys.path.insert(0, "/app")
    import latentsync_infer as lsi

    global _ls_infer, _ls_loaded
    if _ls_loaded:
        return True, ""

    ckpt_volume_path = f"{VOLUME_PATH}/latentsync"
    ckpt_link_path   = f"{LATENTSYNC_DIR}/checkpoints"

    os.makedirs(ckpt_volume_path, exist_ok=True)
    if os.path.islink(ckpt_link_path):
        pass  # already linked
    elif os.path.isdir(ckpt_link_path) and not os.listdir(ckpt_link_path):
        os.rmdir(ckpt_link_path)
        os.symlink(ckpt_volume_path, ckpt_link_path)
    elif not os.path.exists(ckpt_link_path):
        os.symlink(ckpt_volume_path, ckpt_link_path)

    prev_cwd = os.getcwd()
    os.chdir(LATENTSYNC_DIR)
    ok = lsi._load_models()
    os.chdir(prev_cwd)

    if not ok:
        reason = getattr(lsi, "_last_synthesize_reason", "unknown")
        return False, reason

    _ls_infer  = lsi
    _ls_loaded = True
    return True, ""


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


def _get_hunyuan_t2v():
    global _hunyuan_t2v_pipe
    if _hunyuan_t2v_pipe is None:
        import torch
        from diffusers import HunyuanVideoPipeline
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        log.info("[LOAD] HunyuanVideo T2V …")
        t0 = time.time()
        _hunyuan_t2v_pipe = HunyuanVideoPipeline.from_pretrained(
            "hunyuanvideo-community/HunyuanVideo",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        _hunyuan_t2v_pipe.vae.enable_slicing()
        _hunyuan_t2v_pipe.vae.enable_tiling()
        log.info(f"[LOAD] HunyuanVideo T2V ready in {time.time()-t0:.1f}s")
    return _hunyuan_t2v_pipe


# ─── Download functions (run once to pre-populate volume) ─────────────────────

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
    print("=== Downloading HunyuanVideo T2V (~40 GB) ===")
    snapshot_download("hunyuanvideo-community/HunyuanVideo")
    print("=== Downloading CogVideoX-5b-I2V (~18 GB) ===")
    snapshot_download("THUDM/CogVideoX-5b-I2V")

    volume.commit()
    print("=== All models downloaded and committed to volume ===")


@app.function(
    volumes={VOLUME_PATH: volume},
    image=lipsync_image,
    gpu="A10G",
    timeout=3600,
    secrets=[modal.Secret.from_name("pocket-twin")],
)
def download_latentsync_models():
    """
    Pre-downloads LatentSync 1.6 checkpoints to the Modal volume.
    Run once with: modal run modal-worker/app.py::download_latentsync_models
    """
    from huggingface_hub import snapshot_download
    from pathlib import Path

    os.environ["HF_HOME"] = HF_HOME
    os.environ["HUGGINGFACE_HUB_TOKEN"] = os.environ.get("HF_TOKEN", "")

    ckpt_path = f"{VOLUME_PATH}/latentsync"
    Path(ckpt_path).mkdir(parents=True, exist_ok=True)

    print("=== Downloading ByteDance/LatentSync-1.6 checkpoints (~6 GB) ===")
    snapshot_download(
        "ByteDance/LatentSync-1.6",
        local_dir=ckpt_path,
        local_dir_use_symlinks=False,
    )
    print("=== Downloading stabilityai/sd-vae-ft-mse (VAE) ===")
    snapshot_download("stabilityai/sd-vae-ft-mse")

    volume.commit()
    print("=== LatentSync models downloaded and committed to volume ===")



# ─── IMAGE endpoint — A10G (~$0.60/hr, 6× cheaper than H100) ─────────────────
#     FLUX.1-schnell fits comfortably in 24 GB A10G VRAM
#     scaledown_window=300 keeps it warm for 5 min to amortize cold starts

@app.function(
    volumes={VOLUME_PATH: volume},
    image=image,
    gpu="A10G",
    timeout=300,
    scaledown_window=300,
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


# ─── VIDEO endpoint — A100-80GB (HunyuanVideo ~40 GB, loaded from volume) ────────────

@app.function(
    image=video_image,
    volumes={VOLUME_PATH: volume},
    gpu="H100",
    timeout=600,
    scaledown_window=600,
    max_containers=1,
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


# ─── LIPSYNC endpoint — A100-40GB (LatentSync 1.6) ───────────────────────────
#     Receives source image + audio, returns Firebase video URL with audio muxed.
#     max_containers=1  → prevents a 2nd container from spawning when warmup
#                          is still loading models; new requests queue instead.
#     scaledown_window=300 → stays warm 5 min between chat turns.

@app.function(
    volumes={VOLUME_PATH: volume},
    image=lipsync_image,
    gpu="H100",
    timeout=300,
    scaledown_window=300,
    max_containers=1,
    secrets=[modal.Secret.from_name("pocket-twin")],
)
@modal.fastapi_endpoint(method="POST", label="pocket-twin-lipsync")
def create_lipsync(body: dict) -> dict:
    os.environ["HF_HOME"] = HF_HOME
    os.environ["HUGGINGFACE_HUB_TOKEN"] = os.environ.get("HF_TOKEN", "")

    task: str = body.get("task", "")

    if task == "warmup":
        # Start model loading in a background thread so this request returns
        # immediately (< 1 s). The container stays alive and handles the next
        # real request — which blocks briefly on _models_load_lock until the
        # background load finishes.  If we loaded synchronously here the HTTP
        # connection would stay open for ~60 s and Modal would spin up a second
        # container for the first real request, defeating the warmup entirely.
        import threading
        threading.Thread(target=_ensure_lipsync_loaded, daemon=True).start()
        return {"status": "warming"}

    if task != "lip_sync":
        return {"error": f"This endpoint handles lip_sync, got: {task}"}

    try:
        return _handle_lip_sync(body)
    except Exception as e:
        log.exception("[ERROR] lip_sync")
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
    steps     = int(body.get("num_inference_steps", 20))
    guidance  = float(body.get("guidance_scale", 3.5))
    # strength: 0=keep original, 1=ignore original. 0.9 = strong modification
    strength  = float(body.get("strength", 0.9))
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
    import torch

    prompt   = body["prompt"]
    duration = body.get("duration", "6s")
    width    = int(body.get("width", 320))
    height   = int(body.get("height", 576))  # portrait default
    steps    = int(body.get("num_inference_steps", 20))
    guidance = float(body.get("guidance_scale", 6.0))
    seed     = body.get("seed")

    # HunyuanVideo requires width/height divisible by 16
    width  = max(16, (width  // 16) * 16)
    height = max(16, (height // 16) * 16)

    num_frames = _duration_to_frames(duration)
    pipe = _get_hunyuan_t2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    torch.cuda.empty_cache()
    log.info(f"[T2V] {duration} → {num_frames} frames @ {width}x{height} steps={steps}")
    t0 = time.time()
    output = pipe(
        prompt=prompt,
        num_frames=num_frames,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[T2V] Done in {time.time()-t0:.1f}s")
    return _export_video(output.frames[0], "text_to_video")


def _get_hunyuan_i2v():
    global _hunyuan_i2v_pipe
    if _hunyuan_i2v_pipe is None:
        import torch
        from diffusers import CogVideoXImageToVideoPipeline
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        log.info("[LOAD] CogVideoX-5b-I2V …")
        t0 = time.time()
        _hunyuan_i2v_pipe = CogVideoXImageToVideoPipeline.from_pretrained(
            "THUDM/CogVideoX-5b-I2V",
            torch_dtype=torch.bfloat16,
        ).to("cuda")
        _hunyuan_i2v_pipe.vae.enable_slicing()
        _hunyuan_i2v_pipe.vae.enable_tiling()
        log.info(f"[LOAD] CogVideoX-5b-I2V ready in {time.time()-t0:.1f}s")
    return _hunyuan_i2v_pipe




def _handle_image_to_video(body: dict) -> dict:
    import torch
    from PIL import Image as PILImage

    prompt    = body["prompt"]
    image_b64 = body["image"]
    duration  = body.get("duration", "6s")
    steps     = int(body.get("num_inference_steps", 20))
    guidance  = float(body.get("guidance_scale", 6.0))
    seed      = body.get("seed")

    # CogVideoX-5b-I2V only supports its exact training resolution — 720×480 (landscape)
    COG_W, COG_H = 720, 480

    ref_image = (
        PILImage.open(io.BytesIO(base64.b64decode(image_b64)))
        .convert("RGB")
        .resize((COG_W, COG_H))
    )

    # CogVideoX-5b-I2V natively generates 49 frames
    num_frames = 49
    pipe = _get_hunyuan_i2v()
    generator = torch.Generator("cuda").manual_seed(seed) if seed is not None else None

    torch.cuda.empty_cache()
    log.info(f"[I2V] {duration} → {num_frames} frames @ {COG_W}x{COG_H} steps={steps}")
    t0 = time.time()
    output = pipe(
        image=ref_image,
        prompt=prompt,
        num_frames=num_frames,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    log.info(f"[I2V] Done in {time.time()-t0:.1f}s")
    return _export_video(output.frames[0], "image_to_video")


def _export_video(frames, task_name: str) -> dict:
    import imageio, numpy as np

    def to_uint8(f) -> np.ndarray:
        a = np.array(f)
        if a.dtype != np.uint8:
            a = (a * 255).clip(0, 255).astype(np.uint8) if a.max() <= 1.0 else a.clip(0, 255).astype(np.uint8)
        return a

    tmp = f"/tmp/{uuid.uuid4()}.mp4"
    writer = imageio.get_writer(tmp, fps=HUNYUAN_FPS, codec="libx264", quality=8)
    for frame in frames:
        writer.append_data(to_uint8(frame))
    writer.close()

    with open(tmp, "rb") as f:
        video_bytes = f.read()
    os.remove(tmp)

    url = _upload_to_firebase(video_bytes, f"{uuid.uuid4()}.mp4", "video/mp4")
    return {"url": url, "task": task_name, "frames": len(frames)}


def _handle_lip_sync(body: dict) -> dict:
    """
    LatentSync lip-sync inference.
    Input:  source_image_url | source_image_base64, audio_base64 | audio_url
    Output: { "url": "<Firebase video URL>" }

    Avatar prep (image download + looping video creation) is cached in
    _avatar_prep_cache keyed by image URL / content hash.  Saves ~5 s per
    request after the first one for a given avatar on a warm container.
    """
    import base64, hashlib, subprocess, tempfile, time as _time
    import cv2
    from pathlib import Path
    import requests as req

    source_image_url    = body.get("source_image_url")
    source_image_base64 = body.get("source_image_base64")
    source_image_mime   = body.get("source_image_mime_type", "image/jpeg")
    audio_base64        = body.get("audio_base64")
    audio_url           = body.get("audio_url")
    num_steps           = int(body.get("num_inference_steps", 2))
    bbox_shift          = int(body.get("bbox_shift", 0))

    if not source_image_url and not source_image_base64:
        return {"error": "Missing source image. Provide source_image_url or source_image_base64."}
    if not audio_base64 and not audio_url:
        return {"error": "Missing audio. Provide audio_base64 or audio_url."}

    # ── Load models (cached — no-op on warm container) ────────────────────────
    ok, reason = _ensure_lipsync_loaded()
    if not ok:
        return {"error": f"LatentSync model loading failed: {reason}"}

    import sys
    if "/app" not in sys.path:
        sys.path.insert(0, "/app")
    import latentsync_infer as lsi

    t_total = _time.monotonic()

    # ── Avatar prep cache key ─────────────────────────────────────────────────
    # Strip Firebase token from URL so the key is stable across token rotations.
    if source_image_url:
        url_stable = source_image_url.split("?")[0]
    else:
        # Hash first 512 bytes of base64 payload — fast, stable identifier
        url_stable = hashlib.md5(source_image_base64[:512].encode()).hexdigest()
    cache_key = f"{url_stable}:{bbox_shift}"

    global _avatar_prep_cache
    prep = _avatar_prep_cache.get(cache_key)

    if prep is None:
        log.info("[LIPSYNC] avatar prep cache miss — downloading image and preparing")
        os.makedirs(_AVATAR_CACHE_DIR, exist_ok=True)
        avatar_hash = hashlib.md5(cache_key.encode()).hexdigest()

        ext = ".png" if "png" in source_image_mime else ".jpg"
        img_path = f"{_AVATAR_CACHE_DIR}/{avatar_hash}{ext}"

        if source_image_url:
            r = req.get(source_image_url, timeout=30)
            r.raise_for_status()
            with open(img_path, "wb") as f:
                f.write(r.content)
        else:
            with open(img_path, "wb") as f:
                f.write(base64.b64decode(source_image_base64))

        img_bgr = cv2.imread(img_path)
        if img_bgr is None:
            return {"error": "Failed to decode source image (cv2.imread returned None)."}

        # write looping video to persistent path so it survives across requests
        prev_cwd = os.getcwd()
        os.chdir(LATENTSYNC_DIR)
        try:
            prep = lsi.prepare_avatar(img_bgr, avatar_hash, _AVATAR_CACHE_DIR, bbox_shift=bbox_shift)
        finally:
            os.chdir(prev_cwd)

        if prep is None:
            return {"error": "LatentSync prepare_avatar failed."}

        _avatar_prep_cache[cache_key] = prep
        log.info(f"[LIPSYNC] avatar prep cached ({len(_avatar_prep_cache)} entries)")
    else:
        log.info("[LIPSYNC] avatar prep cache hit — skipping image download + prepare")

    # ── Decode audio + run synthesis ──────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir_str:
        tmpdir = Path(tmpdir_str)

        audio_path = tmpdir / "audio.mp3"
        if audio_url:
            r = req.get(audio_url, timeout=30)
            r.raise_for_status()
            audio_path.write_bytes(r.content)
        else:
            audio_path.write_bytes(base64.b64decode(audio_base64))

        # ── Hard cap: trim audio to 8 s so LatentSync never processes more than
        # ~12 windows regardless of how long the TTS reply is.  This bounds the
        # worst-case inference time to ~35 s on a warm A10G.
        MAX_AUDIO_SECS = 8
        trimmed_path = tmpdir / "audio_trimmed.mp3"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", str(audio_path),
                    "-t", str(MAX_AUDIO_SECS),
                    "-c:a", "copy",
                    str(trimmed_path),
                ],
                check=True, capture_output=True, timeout=15,
            )
            audio_path = trimmed_path
        except subprocess.CalledProcessError:
            pass  # if trim fails just use original

        prev_cwd = os.getcwd()
        os.chdir(LATENTSYNC_DIR)
        raw_video_path = None
        try:
            raw_video_path = lsi.synthesize_to_path(
                prep, str(audio_path), fps=25, num_inference_steps=num_steps
            )
        finally:
            os.chdir(prev_cwd)

        if not raw_video_path:
            reason = getattr(lsi, "_last_synthesize_reason", "")
            return {"error": f"Synthesis failed. {reason}"}

        log.info("[LIPSYNC] inference complete")

        # ── Mux audio into video with ffmpeg ──────────────────────────────────
        # Try -c:v copy first (zero re-encode). Fall back to ultrafast transcode.
        final_path = str(tmpdir / "output.mp4")
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", raw_video_path,
                    "-i", str(audio_path),
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "128k",
                    "-shortest",
                    final_path,
                ],
                check=True, capture_output=True, timeout=60,
            )
        except subprocess.CalledProcessError as e:
            log.warning(f"[LIPSYNC] ffmpeg copy failed, retranscoding: {e.stderr.decode()[:200]}")
            try:
                subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-i", raw_video_path,
                        "-i", str(audio_path),
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                        "-c:a", "aac", "-b:a", "128k",
                        "-shortest",
                        final_path,
                    ],
                    check=True, capture_output=True, timeout=120,
                )
            except subprocess.CalledProcessError as e2:
                log.warning(f"[LIPSYNC] ffmpeg transcode failed: {e2.stderr.decode()[:200]}; using raw video")
                final_path = raw_video_path

        # ── Upload to Firebase ────────────────────────────────────────────────
        with open(final_path, "rb") as f:
            video_bytes = f.read()

    # Clean up the raw inference output (lives outside tmpdir)
    if raw_video_path and raw_video_path != final_path:
        try:
            os.unlink(raw_video_path)
        except OSError:
            pass

    url = _upload_to_firebase(video_bytes, f"{uuid.uuid4()}.mp4", "video/mp4")
    log.info(f"[LIPSYNC] Done in {_time.monotonic()-t_total:.1f}s → {url}")
    return {"url": url}

