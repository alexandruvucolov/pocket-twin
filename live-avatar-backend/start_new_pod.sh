#!/usr/bin/env bash
# ============================================================
# start_new_pod.sh — full cold-start for a new RunPod GPU pod
# Run once after pod creation:
#   bash /workspace/start_new_pod.sh
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/alexandruvucolov/pocket-twin.git"
REPO_DIR="/workspace/pocket-twin"
BACKEND_DIR="$REPO_DIR/live-avatar-backend"
LATENTSYNC_DIR="/workspace/LatentSync"

echo "======================================================"
echo " Pocket Twin — New Pod Bootstrap"
echo "======================================================"

# ── 1. Clone pocket-twin ───────────────────────────────────
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "[1/6] Cloning pocket-twin..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "[1/6] pocket-twin already cloned — pulling latest..."
  cd "$REPO_DIR" && git pull
fi

# ── 2. Write .env ──────────────────────────────────────────
echo "[2/6] Writing .env..."
cat > "$BACKEND_DIR/.env" << 'EOF'
# === Pocket Twin live-avatar-backend ===

# TURN / ICE
LIVE_AVATAR_ICE_SERVERS_JSON=
LIVE_AVATAR_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
LIVE_AVATAR_TURN_URLS=
LIVE_AVATAR_TURN_USERNAME=
LIVE_AVATAR_TURN_CREDENTIAL=
LIVE_AVATAR_METERED_DOMAIN=pocket_twin.metered.live
LIVE_AVATAR_METERED_API_KEY=480fc4fe2da0fbfa5ef46a3aaf650ca386f2
LIVE_AVATAR_METERED_INSECURE_TLS=true

# ElevenLabs TTS
ELEVENLABS_API_KEY=sk_e2c9fabaa0bbe746f5e9eacba9644d6eed7cdb7ad45a955a
ELEVENLABS_VOICE_ID=PIGsltMj3gFMR34aFDI3

# LatentSync
LATENTSYNC_DIR=/workspace/LatentSync
EOF
echo "    .env written."

# ── 3. Clone LatentSync ────────────────────────────────────
if [[ ! -d "$LATENTSYNC_DIR/.git" ]]; then
  echo "[3/6] Cloning LatentSync..."
  git clone https://github.com/bytedance/LatentSync "$LATENTSYNC_DIR"
else
  echo "[3/6] LatentSync already cloned — skipping."
fi

# ── 4. Install LatentSync + shared deps into system Python ─
echo "[4/6] Installing LatentSync dependencies into system Python..."
cd "$LATENTSYNC_DIR"

# Shared ML stack must live in system Python (same process as torch/torchvision)
python3 -m pip install -q --upgrade \
  "huggingface-hub==0.24.7" \
  "transformers==4.48.0" \
  "diffusers==0.30.3" \
  "accelerate==0.34.2"

# LatentSync's own requirements
pip install -q -r requirements.txt || true

# ffmpeg symlink (imageio_ffmpeg ships a binary, make it available system-wide)
if ! command -v ffmpeg &>/dev/null; then
  FFMPEG_BIN=$(python3 -c "import imageio_ffmpeg, os; print(imageio_ffmpeg.get_ffmpeg_exe())" 2>/dev/null || true)
  if [[ -n "$FFMPEG_BIN" && -f "$FFMPEG_BIN" ]]; then
    ln -sf "$FFMPEG_BIN" /usr/local/bin/ffmpeg
    echo "    ffmpeg symlinked from $FFMPEG_BIN"
  fi
fi

# ── 5. Download LatentSync checkpoints ────────────────────
CKPT_DIR="$LATENTSYNC_DIR/checkpoints"
UNET_FILE="$CKPT_DIR/latentsync_unet.pt"

if [[ ! -f "$UNET_FILE" ]]; then
  echo "[5/6] Downloading LatentSync checkpoints (5+ GB, this takes a few minutes)..."
  python3 - << 'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    "ByteDance/LatentSync-1.6",
    local_dir="/workspace/LatentSync/checkpoints",
    local_dir_use_symlinks=False,
)
print("Checkpoints downloaded.")
PY
else
  echo "[5/6] LatentSync checkpoints already present — skipping download."
fi

# ── 6. Install backend requirements & start server ────────
echo "[6/6] Installing backend requirements..."
cd "$BACKEND_DIR"

# Backend venv
python3 -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip
# Remove packages that must stay in system Python
pip uninstall -y torch torchvision torchaudio diffusers accelerate \
  huggingface-hub transformers tokenizers 2>/dev/null || true
pip install -q -r requirements.txt

echo ""
echo "======================================================"
echo " Bootstrap complete! Starting server on port 8000..."
echo "======================================================"

set -a
source .env
set +a

exec uvicorn main:app --host 0.0.0.0 --port 8000
