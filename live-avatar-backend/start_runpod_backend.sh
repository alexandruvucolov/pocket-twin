#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing $SCRIPT_DIR/.env"
  echo "Create it from .env.runpod.example first."
  exit 1
fi

# Install MuseTalk dependencies into SYSTEM Python (same environment as
# torch/torchvision/mmcv/mmpose) so they all share the same C extensions and
# op registrations.  Installing these into the venv while torch stays in system
# causes torchvision::nms op-registration failures inside diffusers because the
# torchvision shared library is never linked into the venv Python process.
python3 -m pip install -q \
  "huggingface-hub>=1.0.0" \
  "diffusers>=0.30.0" \
  "accelerate>=0.34.0"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
set -a
source .env
set +a
exec uvicorn main:app --host 0.0.0.0 --port 8000
