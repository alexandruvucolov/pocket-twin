#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -r requirements.txt >/tmp/pocket-twin-a2f-pip.log 2>&1

if [[ ! -f .env ]]; then
  echo "Missing .env. Run ./write_runpod_env.sh first"
  exit 1
fi

pkill -f "uvicorn main:app --host 0.0.0.0 --port 8020" || true
nohup .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8020 > /tmp/pocket-twin-a2f-upstream.log 2>&1 &
sleep 3
curl -sS http://127.0.0.1:8020/health || true
