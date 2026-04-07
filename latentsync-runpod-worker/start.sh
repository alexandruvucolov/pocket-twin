#!/bin/bash
# start.sh — container entrypoint for the LatentSync serverless worker.
#
# Checkpoints live on a RunPod Network Volume mounted at /runpod-volume.
# If not present, downloads them automatically (first cold start only).
# HF_HOME is pointed at the volume so the VAE + other HF models are also cached.

# NOTE: do NOT use set -e — we handle errors explicitly so the worker never
# exits 1 due to a non-fatal setup issue.

VOLUME_CHECKPOINTS="/runpod-volume/LatentSync-checkpoints"
LATENTSYNC_CKPT_DIR="/workspace/LatentSync/checkpoints"

# Cache ALL HuggingFace downloads on the volume if it exists, else use /tmp
if [ -d "/runpod-volume" ]; then
    export HF_HOME="/runpod-volume/hf-cache"
    mkdir -p "$HF_HOME"
    echo "[start.sh] Volume mounted. HF_HOME=$HF_HOME"
else
    export HF_HOME="/tmp/hf-cache"
    mkdir -p "$HF_HOME"
    echo "[start.sh] WARNING: /runpod-volume not found — using ephemeral HF cache"
fi

echo "[start.sh] Checking for checkpoints..."

if [ ! -d "$VOLUME_CHECKPOINTS" ] || [ -z "$(ls -A "$VOLUME_CHECKPOINTS" 2>/dev/null)" ]; then
    echo "[start.sh] Checkpoints not found — downloading now (~5 GB, one-time)..."
    mkdir -p "$VOLUME_CHECKPOINTS" 2>/dev/null || mkdir -p "/tmp/LatentSync-checkpoints" && VOLUME_CHECKPOINTS="/tmp/LatentSync-checkpoints"
    pip install -q huggingface_hub
    python3 - <<PYEOF
from huggingface_hub import snapshot_download
import os
dest = "$VOLUME_CHECKPOINTS"
print(f"[start.sh] Downloading ByteDance/LatentSync-1.6 to {dest} ...")
snapshot_download(
    repo_id="ByteDance/LatentSync-1.6",
    local_dir=dest,
    local_dir_use_symlinks=False,
    token=os.environ.get("HF_TOKEN"),
)
print("[start.sh] Download complete!")
PYEOF
else
    echo "[start.sh] Checkpoints found: $(ls $VOLUME_CHECKPOINTS | tr '\n' ' ')"
fi

# Create symlink so LatentSync finds checkpoints at its expected path.
# The cloned repo may have an empty checkpoints/ dir — remove it so the symlink works.
if [ -L "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Symlink already exists: $(readlink $LATENTSYNC_CKPT_DIR)"
else
    # Remove empty dir from git clone (if present)
    if [ -d "$LATENTSYNC_CKPT_DIR" ] && [ -z "$(ls -A "$LATENTSYNC_CKPT_DIR" 2>/dev/null)" ]; then
        echo "[start.sh] Removing empty checkpoints dir from git clone..."
        rm -rf "$LATENTSYNC_CKPT_DIR"
    fi
    if [ ! -d "$LATENTSYNC_CKPT_DIR" ]; then
        echo "[start.sh] Creating symlink: $LATENTSYNC_CKPT_DIR -> $VOLUME_CHECKPOINTS"
        ln -s "$VOLUME_CHECKPOINTS" "$LATENTSYNC_CKPT_DIR"
    else
        echo "[start.sh] WARNING: checkpoints dir exists and is not empty — not symlinking"
    fi
fi

echo "[start.sh] Starting RunPod handler..."
exec python -u /app/handler.py

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
