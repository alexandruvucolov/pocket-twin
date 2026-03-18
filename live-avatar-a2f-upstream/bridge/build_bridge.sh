#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${1:-${NVIDIA_A2F_SDK_ROOT:-}}"

if [[ -z "$SDK_ROOT" ]]; then
  echo "Missing SDK root. Usage: $0 /root/Audio2Face-3D-SDK"
  exit 1
fi

"$SCRIPT_DIR/install_into_sdk.sh" "$SDK_ROOT"

BUILD_DIR="$SDK_ROOT/_build/release"
cmake -S "$SDK_ROOT" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --target pocket-twin-a2f-bridge -j

echo "Built: $SDK_ROOT/_build/release/audio2face-sdk/bin/pocket-twin-a2f-bridge"
