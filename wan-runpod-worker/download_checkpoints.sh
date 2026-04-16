#!/bin/bash
# Downloads all model checkpoints to the RunPod volume so cold starts are fast.
# Run this once manually on a pod that has the volume mounted, or let start.sh call it.

set -e

VOLUME="${VOLUME_PATH:-/runpod-volume}"
HF_CACHE="${HF_HOME:-$VOLUME/hf_cache}"
mkdir -p "$HF_CACHE"

export HF_HOME="$HF_CACHE"
export HUGGINGFACE_HUB_VERBOSITY=info

echo "=== Downloading FLUX.1-schnell ==="
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('black-forest-labs/FLUX.1-schnell', ignore_patterns=['*.gguf'])
print('FLUX.1-schnell done')
"

echo "=== Downloading Wan2.1-T2V-14B ==="
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Wan-AI/Wan2.1-T2V-14B')
print('Wan2.1 T2V done')
"

echo "=== Downloading Wan2.1-I2V-14B-480P ==="
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Wan-AI/Wan2.1-I2V-14B-480P')
print('Wan2.1 I2V done')
"

echo "=== All checkpoints downloaded ==="
du -sh "$HF_CACHE"
