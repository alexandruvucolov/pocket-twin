#!/usr/bin/env bash
set -euo pipefail

SDK_ROOT="${NVIDIA_A2F_SDK_ROOT:?NVIDIA_A2F_SDK_ROOT is required}"
BIN="$SDK_ROOT/_build/release/audio2face-sdk/bin/pocket-twin-a2f-bridge"
RUNNER="$SDK_ROOT/run_sample.sh"

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
