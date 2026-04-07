# ─── Base image ───────────────────────────────────────────────────────────────
# RunPod's official PyTorch image with CUDA 12.4 (matches the persistent-pod setup)
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

# ─── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# ─── Clone LatentSync ─────────────────────────────────────────────────────────
RUN git clone https://github.com/bytedance/LatentSync /workspace/LatentSync
WORKDIR /workspace/LatentSync
RUN pip install --no-cache-dir -r requirements.txt

# ─── Download LatentSync 1.6 checkpoints (~5 GB, cached in the image) ─────────
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('ByteDance/LatentSync-1.6', local_dir='checkpoints')"

ENV LATENTSYNC_DIR=/workspace/LatentSync

# ─── Worker code ──────────────────────────────────────────────────────────────
# Build context must be the PROJECT ROOT so we can access both directories:
#   docker build -f latentsync-runpod-worker/Dockerfile -t pocket-twin-latentsync .
WORKDIR /app

COPY latentsync-runpod-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY latentsync-runpod-worker/handler.py .
# Copy the shared inference wrapper from the backend directory
COPY live-avatar-backend/latentsync_infer.py .

# ─── Start ────────────────────────────────────────────────────────────────────
CMD ["python", "-u", "handler.py"]
