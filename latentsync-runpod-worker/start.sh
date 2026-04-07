#!/bin/bash
# start.sh — container entrypoint for the LatentSync serverless worker.
#
# Checkpoints live on a RunPod Network Volume mounted at /runpod-volume.
# This script creates a symlink so LatentSync finds them at its expected path,
# then hands off to the Python handler.

set -e

VOLUME_CHECKPOINTS="/runpod-volume/LatentSync-checkpoints"
LATENTSYNC_CKPT_DIR="/workspace/LatentSync/checkpoints"

echo "[start.sh] Checking for checkpoints on network volume..."

if [ ! -d "$VOLUME_CHECKPOINTS" ]; then
    echo "[start.sh] ERROR: Network volume not mounted or checkpoints not downloaded."
    echo "[start.sh]   Expected: $VOLUME_CHECKPOINTS"
    echo "[start.sh]   Run latentsync-runpod-worker/download_checkpoints.sh on a GPU pod"
    echo "[start.sh]   with this volume attached, then retry."
    exit 1
fi

# Create symlink if not already present
if [ ! -L "$LATENTSYNC_CKPT_DIR" ] && [ ! -d "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Creating symlink: $LATENTSYNC_CKPT_DIR -> $VOLUME_CHECKPOINTS"
    ln -s "$VOLUME_CHECKPOINTS" "$LATENTSYNC_CKPT_DIR"
elif [ -L "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Symlink already exists: $LATENTSYNC_CKPT_DIR -> $(readlink $LATENTSYNC_CKPT_DIR)"
else
    echo "[start.sh] Checkpoints directory already present at $LATENTSYNC_CKPT_DIR"
fi

echo "[start.sh] Starting RunPod handler..."
exec python -u /app/handler.py
