#!/bin/bash
set -e

VOLUME="${VOLUME_PATH:-/runpod-volume}"
HF_CACHE="${HF_HOME:-$VOLUME/hf_cache}"

echo "[START] Volume: $VOLUME"
echo "[START] HF cache: $HF_CACHE"
mkdir -p "$HF_CACHE"

# Download checkpoints if not already present
FLUX_MARKER="$HF_CACHE/models--black-forest-labs--FLUX.1-schnell"
WAN_T2V_MARKER="$HF_CACHE/models--Wan-AI--Wan2.1-T2V-14B"

if [ ! -d "$FLUX_MARKER" ] || [ ! -d "$WAN_T2V_MARKER" ]; then
    echo "[START] Checkpoints not found, downloading..."
    /app/download_checkpoints.sh
else
    echo "[START] Checkpoints already cached, skipping download."
fi

echo "[START] Starting RunPod handler..."
exec python3 -u /app/handler.py
