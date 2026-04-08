# ─── Base image ───────────────────────────────────────────────────────────────
# CUDA 12.8.1 + PyTorch 2.7.1 — required for RTX 5090 (Blackwell / sm_100 kernels)
FROM runpod/pytorch:1.0.3-cu1281-torch271-ubuntu2204

# ─── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# ─── Clone LatentSync ─────────────────────────────────────────────────────────
RUN git clone https://github.com/bytedance/LatentSync /workspace/LatentSync
WORKDIR /workspace/LatentSync
RUN pip install --no-cache-dir -r requirements.txt
# LatentSync pins torch==2.5.1+cu121 which has no Blackwell (sm_100) kernels.
# Reinstall with cu128 to support RTX 5090 and other Blackwell GPUs.
RUN pip install --no-cache-dir --force-reinstall \
        torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 \
        --index-url https://download.pytorch.org/whl/cu128 && \
    python -c "import torch; print('torch', torch.__version__, 'CUDA', torch.version.cuda, 'sm_100 support:', any('sm_100' in a for a in torch.cuda.get_arch_list()) if torch.cuda.is_available() else 'build-only-check-skipped')"
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
