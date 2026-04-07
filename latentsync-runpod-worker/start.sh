#!/bin/bash
# start.sh — container entrypoint for the LatentSync serverless worker.
#
# Checkpoints live on a RunPod Network Volume mounted at /runpod-volume.
# If not present, downloads them automatically (first cold start only).
# Subsequent starts reuse the cached volume — no re-download.

set -e

VOLUME_CHECKPOINTS="/runpod-volume/LatentSync-checkpoints"
LATENTSYNC_CKPT_DIR="/workspace/LatentSync/checkpoints"

echo "[start.sh] Checking for checkpoints..."

if [ ! -d "$VOLUME_CHECKPOINTS" ] || [ -z "$(ls -A "$VOLUME_CHECKPOINTS" 2>/dev/null)" ]; then
    echo "[start.sh] Checkpoints not found on volume — downloading now (~5 GB, one-time)..."
    mkdir -p "$VOLUME_CHECKPOINTS"
    pip install -q huggingface_hub
    python3 - <<'PYEOF'
from huggingface_hub import snapshot_download
print("[start.sh] Downloading ByteDance/LatentSync-1.6 ...")
snapshot_download(
    repo_id="ByteDance/LatentSync-1.6",
    local_dir="/runpod-volume/LatentSync-checkpoints",
    local_dir_use_symlinks=False,
)
print("[start.sh] Download complete!")
PYEOF
else
    echo "[start.sh] Checkpoints found on volume: $(ls $VOLUME_CHECKPOINTS | tr '\n' ' ')"
fi

# Create symlink so LatentSync finds checkpoints at its expected relative path
if [ -L "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Symlink already exists: $LATENTSYNC_CKPT_DIR"
elif [ ! -d "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Creating symlink: $LATENTSYNC_CKPT_DIR -> $VOLUME_CHECKPOINTS"
    ln -s "$VOLUME_CHECKPOINTS" "$LATENTSYNC_CKPT_DIR"
else
    echo "[start.sh] Checkpoints directory already present at $LATENTSYNC_CKPT_DIR"
fi

echo "[start.sh] Starting RunPod handler..."
exec python -u /app/handler.py
