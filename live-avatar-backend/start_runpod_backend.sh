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
# Clean-reinstall a known-good MuseTalk stack in SYSTEM Python.
# This avoids mixed/partial upgrades that break imports like
# "Could not import module 'PreTrainedModel'".
python3 -m pip uninstall -y transformers tokenizers diffusers accelerate huggingface-hub 2>/dev/null || true
python3 -m pip install -q --upgrade \
  "huggingface-hub==0.24.7" \
  "transformers==4.48.0" \
  "diffusers==0.30.3" \
  "accelerate==0.34.2"

# Validate torchvision custom ops (nms). If missing, install the official
# matching PyTorch/cu124 wheels into SYSTEM Python once.
if ! python3 - <<'PY'
import torch
ok = hasattr(torch.ops, "torchvision") and hasattr(torch.ops.torchvision, "nms")
raise SystemExit(0 if ok else 1)
PY
then
  echo "[start] torchvision::nms missing; installing matching torch/torchvision cu124 wheels..."
  python3 -m pip install -q --force-reinstall --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu124 \
    "torch==2.4.1+cu124" "torchvision==0.19.1+cu124"
fi

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
# Remove MuseTalk-related packages from the venv — they must live in system
# Python alongside torch/torchvision so all C extensions share the same process.
# pip uninstall is a no-op if already absent, so this is always safe.
pip uninstall -y torch torchvision torchaudio diffusers accelerate huggingface-hub transformers tokenizers 2>/dev/null || true
pip install -r requirements.txt
set -a
source .env
set +a
exec uvicorn main:app --host 0.0.0.0 --port 8000
