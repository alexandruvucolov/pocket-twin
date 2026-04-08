# ─── Base image ───────────────────────────────────────────────────────────────
# CUDA 12.8.1 + PyTorch 2.6.0 — required for RTX 5090 (Blackwell / sm_100 kernels)
# New RunPod tag format: 1.0.3-cu{cuda}-torch{ver}-ubuntu{os}
FROM runpod/pytorch:1.0.3-cu1281-torch260-ubuntu2204

# ─── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ffmpeg libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

# ─── Clone LatentSync ─────────────────────────────────────────────────────────
RUN mkdir -p /workspace && \
    git clone https://github.com/bytedance/LatentSync /workspace/LatentSync
WORKDIR /workspace/LatentSync
# Install LatentSync deps but skip torch/torchvision/torchaudio lines to avoid
# downgrading from the base image's cu128 build to LatentSync's pinned cu121 build.
# Also patch packages that don't have Python 3.12 wheels at their pinned version:
#   mediapipe==0.10.11 → >=0.10.13  (first release with py3.12 wheels)
#   decord==0.6.0      → >=0.6.0    (no-pin to pick up any newer py3.12 build)
RUN grep -vE "^torch(vision|audio)?[=><!]|^--extra-index-url|^mediapipe|^decord" \
            requirements.txt \
        > /tmp/latentsync_requirements_notorch.txt && \
    echo "mediapipe>=0.10.13" >> /tmp/latentsync_requirements_notorch.txt && \
    echo "decord>=0.6.0" >> /tmp/latentsync_requirements_notorch.txt && \
    pip install --no-cache-dir -r /tmp/latentsync_requirements_notorch.txt
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
