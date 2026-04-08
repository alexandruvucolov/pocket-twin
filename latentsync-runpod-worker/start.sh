#!/bin/bash
# start.sh -- container entrypoint for the LatentSync serverless worker.
# CI trigger: keep this file touched when forcing a rebuild (v2/v3/latest tags).
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

# -- 1. Configure cache path -----------------------------------------------------
if [ -d "/runpod-volume" ]; then
    export HF_HOME="/runpod-volume/hf-cache"
    mkdir -p "$HF_HOME"
    echo "[start.sh] Volume mounted. HF_HOME=$HF_HOME"
else
    export HF_HOME="/tmp/hf-cache"
    mkdir -p "$HF_HOME"
    echo "[start.sh] WARNING: /runpod-volume is not mounted. Using ephemeral cache: $HF_HOME"
fi

# -- 2. Checkpoints must be present ----------------------------------------------
echo "[start.sh] Checking for checkpoints at $VOLUME_CHECKPOINTS ..."
if [ ! -d "$VOLUME_CHECKPOINTS" ] || [ -z "$(ls -A "$VOLUME_CHECKPOINTS" 2>/dev/null)" ]; then
    echo "[start.sh] WARNING: No checkpoints at $VOLUME_CHECKPOINTS."
    echo "[start.sh] Run download_checkpoints.sh on a GPU pod with this volume"
    echo "[start.sh] attached to populate it (one-time, ~6 GB). Worker will start anyway."
else
    echo "[start.sh] Checkpoints found:"
    ls -1 "$VOLUME_CHECKPOINTS"
fi

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

echo "[start.sh] Startup checks complete."

# -- 4. Auto-download checkpoints if missing ------------------------------------
HF_BASE="https://huggingface.co/ByteDance/LatentSync-1.6/resolve/main"

_download_ckpt() {
    local dest="$1" url="$2" label="$3"
    if [ -f "$dest" ] && [ -s "$dest" ]; then
        echo "[start.sh] $label already present: $(du -h "$dest" | cut -f1)"
        return 0
    fi
    echo "[start.sh] $label missing. Downloading from HuggingFace ..."
    mkdir -p "$(dirname "$dest")"
    if command -v wget &>/dev/null; then
        wget -q --show-progress -O "${dest}.tmp" "$url"
    else
        curl -L --progress-bar -o "${dest}.tmp" "$url"
    fi
    if [ $? -ne 0 ] || [ ! -s "${dest}.tmp" ]; then
        echo "[start.sh] FATAL: Could not download $label. Aborting."
        rm -f "${dest}.tmp"
        exit 1
    fi
    mv "${dest}.tmp" "$dest"
    echo "[start.sh] $label download complete: $(du -h "$dest" | cut -f1)"
}

# UNet (main LatentSync model, ~6 GB)
_download_ckpt "$VOLUME_CHECKPOINTS/latentsync_unet.pt" \
               "$HF_BASE/latentsync_unet.pt" \
               "UNet (latentsync_unet.pt)"

# Whisper audio encoder (~150 MB)
_download_ckpt "$VOLUME_CHECKPOINTS/whisper/tiny.pt" \
               "$HF_BASE/whisper/tiny.pt" \
               "Whisper (whisper/tiny.pt)"

# VAE — download via huggingface_hub into the volume hf-cache so it is never
# re-downloaded on subsequent cold starts (AutoencoderKL.from_pretrained uses
# HF_HOME which we already pointed at /runpod-volume/hf-cache above).
VAE_MARKER="$HF_HOME/hub/models--stabilityai--sd-vae-ft-mse/blobs"
if [ -d "$VAE_MARKER" ] && [ -n "$(ls -A "$VAE_MARKER" 2>/dev/null)" ]; then
    echo "[start.sh] VAE already cached at $HF_HOME"
else
    echo "[start.sh] VAE not yet cached. Pre-downloading stabilityai/sd-vae-ft-mse ..."
    python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('stabilityai/sd-vae-ft-mse')
print('[start.sh] VAE download complete.')
" || echo "[start.sh] WARNING: VAE pre-download failed — will retry at inference time."
fi

# -- 5. Launch handler -----------------------------------------------------------
echo "[start.sh] Launching handler..."
exec python -u /app/handler.py
