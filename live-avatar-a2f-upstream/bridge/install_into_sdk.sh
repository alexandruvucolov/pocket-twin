#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${1:-${NVIDIA_A2F_SDK_ROOT:-}}"

if [[ -z "$SDK_ROOT" ]]; then
  echo "Missing SDK root. Usage: $0 /root/Audio2Face-3D-SDK"
  exit 1
fi

PATCH_ROOT="$SCRIPT_DIR/sdk-patch/audio2face-sdk/source/samples/pocket-twin-a2f-bridge"
TARGET_ROOT="$SDK_ROOT/audio2face-sdk/source/samples/pocket-twin-a2f-bridge"
SAMPLES_CMAKE="$SDK_ROOT/audio2face-sdk/source/samples/CMakeLists.txt"

mkdir -p "$TARGET_ROOT"
cp "$PATCH_ROOT/main.cpp" "$TARGET_ROOT/main.cpp"
cp "$PATCH_ROOT/CMakeLists.txt" "$TARGET_ROOT/CMakeLists.txt"

if ! grep -q 'add_subdirectory(pocket-twin-a2f-bridge)' "$SAMPLES_CMAKE"; then
  printf '\nadd_subdirectory(pocket-twin-a2f-bridge)\n' >> "$SAMPLES_CMAKE"
fi

echo "Installed Pocket Twin bridge source into $TARGET_ROOT"
