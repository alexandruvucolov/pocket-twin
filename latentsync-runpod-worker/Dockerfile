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
# NOTE: Checkpoints are NOT baked in — they live on a RunPod Network Volume
#       mounted at /runpod-volume. The start.sh script creates a symlink at
#       /workspace/LatentSync/checkpoints → /runpod-volume/LatentSync-checkpoints
#       Run latentsync-runpod-worker/download_checkpoints.sh ONCE on a GPU pod
#       that has the volume attached to populate the volume.

ENV LATENTSYNC_DIR=/workspace/LatentSync

# ─── Worker code ──────────────────────────────────────────────────────────────
# Build context must be the PROJECT ROOT so we can access both directories:
#   docker build -f latentsync-runpod-worker/Dockerfile -t pocket-twin-latentsync .
WORKDIR /app

COPY latentsync-runpod-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY latentsync-runpod-worker/handler.py .
COPY latentsync-runpod-worker/start.sh .
# Copy the shared inference wrapper from the backend directory
COPY live-avatar-backend/latentsync_infer.py .

RUN chmod +x /app/start.sh

# ─── Start ────────────────────────────────────────────────────────────────────
CMD ["/app/start.sh"]
