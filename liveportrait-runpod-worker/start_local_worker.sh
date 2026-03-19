#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

if [[ -f "$SCRIPT_DIR/examples/current-runpod.exports.sh" ]]; then
  set -a
  source "$SCRIPT_DIR/examples/current-runpod.exports.sh"
  set +a
fi

exec python handler.py
