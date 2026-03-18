#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SDK_ROOT="${1:-${NVIDIA_A2F_SDK_ROOT:-}}"

if [[ -z "$SDK_ROOT" ]]; then
  echo "Missing SDK root. Usage: $0 /root/Audio2Face-3D-SDK"
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  echo "Missing dependency: cmake"
  echo "Install it with: apt-get update && apt-get install -y cmake build-essential"
  exit 1
fi

CMAKE_VERSION="$(cmake --version | head -n 1 | awk '{print $3}')"
if ! python3 - "$CMAKE_VERSION" <<'PY'
import sys

def parse(value: str) -> tuple[int, ...]:
  return tuple(int(part) for part in value.split('.'))

current = parse(sys.argv[1])
minimum = parse("3.24")
raise SystemExit(0 if current >= minimum else 1)
PY
then
  echo "Installed cmake is too old: $CMAKE_VERSION"
  echo "Audio2Face SDK requires cmake >= 3.24"
  echo "Upgrade with: python3 -m pip install -U cmake"
  exit 1
fi

if ! command -v c++ >/dev/null 2>&1; then
  echo "Missing dependency: C++ compiler"
  echo "Install it with: apt-get update && apt-get install -y build-essential"
  exit 1
fi

"$SCRIPT_DIR/install_into_sdk.sh" "$SDK_ROOT"

BUILD_DIR="$SDK_ROOT/_build/release"
cmake -S "$SDK_ROOT" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" --target pocket-twin-a2f-bridge -j

echo "Built: $SDK_ROOT/_build/release/audio2face-sdk/bin/pocket-twin-a2f-bridge"
