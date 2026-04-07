#!/bin/bash
# start.sh -- container entrypoint for the LatentSync serverless worker.
#
# REQUIREMENTS:
#   1. A RunPod Network Volume must be attached, mounted at /runpod-volume
#   2. The volume must already contain checkpoints at:
#        /runpod-volume/LatentSync-checkpoints/
#      (run download_checkpoints.sh ONCE on a pod with the volume attached)
#
# HF_HOME is pointed at the volume so the VAE (stabilityai/sd-vae-ft-mse)
# is also cached there after the first cold start.

VOLUME_CHECKPOINTS="/runpod-volume/LatentSync-checkpoints"
LATENTSYNC_CKPT_DIR="/workspace/LatentSync/checkpoints"

echo "[start.sh] ===== LatentSync worker start ====="

# -- 1. Volume must be mounted ---------------------------------------------------
if [ ! -d "/runpod-volume" ]; then
    echo "[start.sh] FATAL: /runpod-volume is not mounted."
    echo "[start.sh] Attach the latentsync-checkpoints network volume to this"
    echo "[start.sh] endpoint: RunPod UI -> Endpoint -> Edit -> Network Volume."
    exit 1
fi

export HF_HOME="/runpod-volume/hf-cache"
mkdir -p "$HF_HOME"
echo "[start.sh] Volume mounted. HF_HOME=$HF_HOME"

# -- 2. Checkpoints must be present ----------------------------------------------
echo "[start.sh] Checking for checkpoints at $VOLUME_CHECKPOINTS ..."
if [ ! -d "$VOLUME_CHECKPOINTS" ] || [ -z "$(ls -A "$VOLUME_CHECKPOINTS" 2>/dev/null)" ]; then
    echo "[start.sh] FATAL: No checkpoints at $VOLUME_CHECKPOINTS."
    echo "[start.sh] Run download_checkpoints.sh on a GPU pod with this volume"
    echo "[start.sh] attached to populate it (one-time, ~6 GB)."
    exit 1
fi

echo "[start.sh] Checkpoints found:"
ls -1 "$VOLUME_CHECKPOINTS"

# -- 3. Symlink so LatentSync finds checkpoints at its expected path -------------
if [ -L "$LATENTSYNC_CKPT_DIR" ]; then
    echo "[start.sh] Symlink already exists: $(readlink "$LATENTSYNC_CKPT_DIR")"
else
    # git clone creates an empty checkpoints/ dir -- remove it so symlink works
    if [ -d "$LATENTSYNC_CKPT_DIR" ] && [ -z "$(ls -A "$LATENTSYNC_CKPT_DIR" 2>/dev/null)" ]; then
        echo "[start.sh] Removing empty git-clone checkpoints/ dir..."
        rm -rf "$LATENTSYNC_CKPT_DIR"
    fi
    if [ ! -e "$LATENTSYNC_CKPT_DIR" ]; then
        echo "[start.sh] Creating symlink: $LATENTSYNC_CKPT_DIR -> $VOLUME_CHECKPOINTS"
        ln -s "$VOLUME_CHECKPOINTS" "$LATENTSYNC_CKPT_DIR"
    else
        echo "[start.sh] WARNING: $LATENTSYNC_CKPT_DIR exists and is non-empty -- skipping symlink"
        ls -lh "$LATENTSYNC_CKPT_DIR"
    fi
fi

echo "[start.sh] Symlink state:"
ls -la /workspace/LatentSync/ | grep checkpoints

# -- 4. Launch handler -----------------------------------------------------------
echo "[start.sh] Launching handler..."
exec python -u /app/handler.py
