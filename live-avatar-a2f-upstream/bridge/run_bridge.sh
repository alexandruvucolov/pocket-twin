#!/usr/bin/env bash
set -euo pipefail

SDK_ROOT="${NVIDIA_A2F_SDK_ROOT:?NVIDIA_A2F_SDK_ROOT is required}"
CUDA_PATH="${CUDA_PATH:-/usr/local/cuda-12.8}"
TENSORRT_ROOT_DIR="${TENSORRT_ROOT_DIR:-/opt/tensorrt}"
BIN="$SDK_ROOT/_build/release/audio2face-sdk/bin/pocket-twin-a2f-bridge"
RUNNER="$SDK_ROOT/run_sample.sh"

export CUDA_PATH
export TENSORRT_ROOT_DIR
export LD_LIBRARY_PATH="$CUDA_PATH/lib64:$TENSORRT_ROOT_DIR/lib:${LD_LIBRARY_PATH:-}"

if [[ ! -x "$RUNNER" ]]; then
  echo "Missing runner: $RUNNER"
  exit 1
fi

if [[ ! -x "$BIN" ]]; then
  echo "Missing bridge binary: $BIN"
  echo "Build it first with: ./bridge/build_bridge.sh $SDK_ROOT"
  exit 1
fi

exec "$RUNNER" "$BIN" "$@"
