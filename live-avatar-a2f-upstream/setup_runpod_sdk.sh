#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

WORKSPACE_ROOT="${A2F_WORKSPACE_ROOT:-/workspace}"
SDK_ROOT="${NVIDIA_A2F_SDK_ROOT:-$WORKSPACE_ROOT/Audio2Face-3D-SDK}"
MODEL_DIR="$SDK_ROOT/_data/audio2face-models/audio2face-3d-v3.0"
MODEL_JSON="$MODEL_DIR/model.json"
MODEL_ONNX="$MODEL_DIR/network.onnx"
MODEL_TRT="$MODEL_DIR/network.trt"
CUDA_PATH_VALUE="${CUDA_PATH:-}"
TENSORRT_ROOT_VALUE="${TENSORRT_ROOT_DIR:-}"
RUN_FULL_GEN_TESTDATA="${A2F_RUN_FULL_GEN_TESTDATA:-false}"
START_UPSTREAM="${A2F_START_UPSTREAM:-false}"
PYTHON_BIN="${A2F_PYTHON_BIN:-}"
HF_TOKEN="${A2F_HF_TOKEN:-}"

log() {
  printf '\n[%s] %s\n' "setup_runpod_sdk" "$*"
}

fail() {
  printf '\n[%s] ERROR: %s\n' "setup_runpod_sdk" "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

find_python() {
  if [[ -n "$PYTHON_BIN" ]]; then
    echo "$PYTHON_BIN"
    return 0
  fi

  local candidate
  for candidate in python3.10 python3.9 python3.8; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done

  if command -v python3 >/dev/null 2>&1; then
    local major_minor
    major_minor="$(python3 - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY
)"
    case "$major_minor" in
      3.8|3.9|3.10)
        echo python3
        return 0
        ;;
    esac
  fi

  return 1
}

ensure_linux() {
  [[ "$(uname -s)" == "Linux" ]] || fail "This script is intended for the Linux Runpod host"
}

ensure_apt_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found; skipping OS package installation"
    return 0
  fi

  log "Installing required OS packages"
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    git-lfs \
    pkg-config

  git lfs install --skip-repo
}

ensure_cmake() {
  local cmake_ok=0
  if command -v cmake >/dev/null 2>&1; then
    if python3 - "$(cmake --version | head -n 1 | awk '{print $3}')" <<'PY'
import sys
parts = tuple(int(p) for p in sys.argv[1].split('.'))
raise SystemExit(0 if parts >= (3, 24) else 1)
PY
    then
      cmake_ok=1
    fi
  fi

  if [[ "$cmake_ok" -eq 1 ]]; then
    return 0
  fi

  local python_for_tools
  python_for_tools="$(find_python)" || fail "Python 3.8-3.10 is required to install cmake"
  log "Installing newer cmake and ninja with $python_for_tools"
  "$python_for_tools" -m pip install --upgrade pip
  "$python_for_tools" -m pip install --upgrade cmake ninja
  export PATH="$HOME/.local/bin:$PATH"
  command -v cmake >/dev/null 2>&1 || fail "cmake still not available after installation"
}

resolve_cuda_path() {
  if [[ -n "$CUDA_PATH_VALUE" ]]; then
    return 0
  fi

  local candidate
  for candidate in /usr/local/cuda-12.9 /usr/local/cuda-12.8 /usr/local/cuda; do
    if [[ -d "$candidate" ]]; then
      CUDA_PATH_VALUE="$candidate"
      export CUDA_PATH="$candidate"
      return 0
    fi
  done

  fail "CUDA_PATH is not set and no CUDA installation was found under /usr/local"
}

resolve_tensorrt_root() {
  if [[ -n "$TENSORRT_ROOT_VALUE" ]]; then
    return 0
  fi

  local candidate
  for candidate in /opt/tensorrt /usr/src/tensorrt /usr/lib/x86_64-linux-gnu; do
    if [[ -d "$candidate" ]]; then
      TENSORRT_ROOT_VALUE="$candidate"
      export TENSORRT_ROOT_DIR="$candidate"
      return 0
    fi
  done

  fail "TENSORRT_ROOT_DIR is not set. Export it before running this script. Example: export TENSORRT_ROOT_DIR=/opt/tensorrt"
}

clone_sdk() {
  mkdir -p "$WORKSPACE_ROOT"
  if [[ ! -d "$SDK_ROOT/.git" ]]; then
    log "Cloning NVIDIA Audio2Face-3D-SDK into $SDK_ROOT"
    git clone https://github.com/NVIDIA/Audio2Face-3D-SDK.git "$SDK_ROOT"
  else
    log "SDK repo already exists at $SDK_ROOT"
  fi

  cd "$SDK_ROOT"
  git lfs pull
}

build_sdk() {
  cd "$SDK_ROOT"
  log "Fetching SDK build dependencies"
  ./fetch_deps.sh release

  export CUDA_PATH="$CUDA_PATH_VALUE"
  export TENSORRT_ROOT_DIR="$TENSORRT_ROOT_VALUE"

  log "Building Audio2Face SDK"
  ./build.sh all release
}

prepare_model_env() {
  local python_sdk
  python_sdk="$(find_python)" || fail "Python 3.8-3.10 is required for the SDK model scripts"

  cd "$SDK_ROOT"
  if [[ ! -d venv ]]; then
    log "Creating SDK venv with $python_sdk"
    "$python_sdk" -m venv venv
  fi

  # shellcheck disable=SC1091
  source "$SDK_ROOT/venv/bin/activate"
  python -m pip install --upgrade pip
  python -m pip install -r deps/requirements.txt

  if [[ -n "$HF_TOKEN" ]]; then
    log "Logging into Hugging Face using A2F_HF_TOKEN"
    hf auth login --token "$HF_TOKEN"
  else
    log "Hugging Face login is required for gated model downloads"
    log "Run 'hf auth login' when prompted below"
    hf auth login
  fi

  log "Downloading SDK models"
  ./download_models.sh

  if [[ "$RUN_FULL_GEN_TESTDATA" == "true" ]]; then
    log "Running full gen_testdata.sh"
    ./gen_testdata.sh
  fi

  if [[ ! -f "$MODEL_JSON" ]]; then
    fail "Expected model.json not found at $MODEL_JSON"
  fi

  if [[ ! -f "$MODEL_TRT" ]]; then
    [[ -f "$MODEL_ONNX" ]] || fail "Expected ONNX model not found at $MODEL_ONNX"
    need_cmd trtexec
    log "Generating minimal TensorRT engine for audio2face-3d-v3.0"
    trtexec --onnx="$MODEL_ONNX" --saveEngine="$MODEL_TRT" --fp16
  else
    log "TensorRT engine already exists: $MODEL_TRT"
  fi

  deactivate || true
}

link_root_sdk() {
  if [[ "$SDK_ROOT" == /root/Audio2Face-3D-SDK ]]; then
    return 0
  fi

  if [[ ! -e /root/Audio2Face-3D-SDK ]]; then
    log "Linking /root/Audio2Face-3D-SDK -> $SDK_ROOT"
    ln -s "$SDK_ROOT" /root/Audio2Face-3D-SDK
  fi
}

build_pocket_twin_bridge() {
  log "Building Pocket Twin bridge against SDK"
  NVIDIA_A2F_SDK_ROOT="$SDK_ROOT" "$SCRIPT_DIR/bridge/build_bridge.sh" "$SDK_ROOT"
}

write_env_file() {
  log "Writing upstream .env"
  NVIDIA_A2F_SDK_ROOT="$SDK_ROOT" \
  NVIDIA_A2F_MODEL_PATH="$MODEL_JSON" \
  CUDA_PATH="$CUDA_PATH_VALUE" \
  TENSORRT_ROOT_DIR="$TENSORRT_ROOT_VALUE" \
  "$SCRIPT_DIR/write_runpod_env.sh"
}

start_upstream_if_requested() {
  if [[ "$START_UPSTREAM" != "true" ]]; then
    log "Skipping upstream start. Set A2F_START_UPSTREAM=true to launch it"
    return 0
  fi

  log "Starting upstream service"
  "$SCRIPT_DIR/start_upstream.sh"
}

print_summary() {
  cat <<EOF

Setup complete.

SDK root: $SDK_ROOT
Model json: $MODEL_JSON
TensorRT engine: $MODEL_TRT
Upstream env: $SCRIPT_DIR/.env

Next checks:
  1. curl http://127.0.0.1:8020/health
  2. POST /sessions
  3. POST /sessions/{sessionId}/speak

EOF
}

main() {
  ensure_linux
  ensure_apt_packages
  ensure_cmake
  resolve_cuda_path
  resolve_tensorrt_root
  clone_sdk
  build_sdk
  prepare_model_env
  link_root_sdk
  build_pocket_twin_bridge
  write_env_file
  start_upstream_if_requested
  print_summary
}

main "$@"
