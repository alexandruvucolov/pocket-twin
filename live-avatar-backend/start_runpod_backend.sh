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

# Ensure SD-VAE weights exist for MuseTalk (models/sd-vae/config.json + bin).
if [[ ! -f "$SCRIPT_DIR/../MuseTalk/MuseTalk/models/sd-vae/config.json" && ! -f "/workspace/MuseTalk/MuseTalk/models/sd-vae/config.json" && ! -f "/workspace/MuseTalk/MuseTalk/models/sd-vae-ft-mse/config.json" ]]; then
  echo "[start] sd-vae weights missing; downloading stabilityai/sd-vae-ft-mse..."
  python3 - <<'PY'
from pathlib import Path
from huggingface_hub import hf_hub_download

root = Path("/workspace/MuseTalk/MuseTalk/models/sd-vae")
root.mkdir(parents=True, exist_ok=True)

for filename in ("config.json", "diffusion_pytorch_model.bin"):
    src = hf_hub_download(
        repo_id="stabilityai/sd-vae-ft-mse",
        filename=filename,
    )
    dst = root / filename
    dst.write_bytes(Path(src).read_bytes())

print(f"Downloaded SD-VAE weights to {root}")
PY
fi

# Ensure MuseTalk v1.5 UNet files exist.
if [[ ! -f "/workspace/MuseTalk/MuseTalk/models/musetalkV15/musetalk.json" || ! -f "/workspace/MuseTalk/MuseTalk/models/musetalkV15/unet.pth" ]]; then
  echo "[start] musetalkV15 files missing; downloading from TMElyralab/MuseTalk..."
  python3 - <<'PY'
from pathlib import Path
from huggingface_hub import hf_hub_download

root = Path("/workspace/MuseTalk/MuseTalk/models/musetalkV15")
root.mkdir(parents=True, exist_ok=True)

files = {
  "musetalkV15/musetalk.json": "musetalk.json",
  "musetalkV15/unet.pth": "unet.pth",
}

for remote_name, local_name in files.items():
  src = hf_hub_download(
    repo_id="TMElyralab/MuseTalk",
    filename=remote_name,
  )
  dst = root / local_name
  dst.write_bytes(Path(src).read_bytes())

print(f"Downloaded MuseTalk v1.5 files to {root}")
PY
fi

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
