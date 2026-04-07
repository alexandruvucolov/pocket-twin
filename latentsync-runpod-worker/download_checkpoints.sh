#!/bin/bash
# download_checkpoints.sh
# Run this ONCE on a RunPod GPU pod that has your Network Volume attached.
#
# Steps:
#   1. On RunPod → Storage → Create a Network Volume (10 GB, same datacenter as your endpoint)
#   2. On RunPod → Pods → New Pod → attach the volume → mount path: /runpod-volume
#      (any GPU is fine, even the cheapest A40 — you only need CUDA for the actual inference)
#   3. SSH into the pod and run:
#        bash /workspace/download_checkpoints.sh
#   4. Done — terminate the pod. The volume keeps the checkpoints forever.
#   5. Attach the volume to your serverless endpoint (Endpoint settings → Network Volume).

set -e

DEST="/runpod-volume/LatentSync-checkpoints"

echo "=== LatentSync checkpoint downloader ==="
echo "Destination: $DEST"

if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    echo "Checkpoints already present at $DEST — skipping download."
    echo "Contents:"
    ls -lh "$DEST"
    exit 0
fi

mkdir -p "$DEST"

echo "Installing huggingface_hub..."
pip install -q huggingface_hub

echo "Downloading ByteDance/LatentSync-1.6 checkpoints (~5 GB)..."
python3 - <<'PYEOF'
from huggingface_hub import snapshot_download
import os

dest = "/runpod-volume/LatentSync-checkpoints"
print(f"Downloading to {dest} ...")
snapshot_download(
    repo_id="ByteDance/LatentSync-1.6",
    local_dir=dest,
    local_dir_use_symlinks=False,
)
print("Download complete!")
PYEOF

echo ""
echo "=== Done ==="
echo "Checkpoint files:"
ls -lh "$DEST"
echo ""
echo "You can now terminate this GPU pod and attach the volume to your serverless endpoint."
