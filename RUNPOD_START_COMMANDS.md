# RunPod Start Commands

## Fresh pod — first-time setup

Run once after creating a new pod (GPU with MuseTalk/CUDA support).

### 1. Clone repo & create .env

```bash
cd /workspace
git clone https://github.com/alexandruvucolov/pocket-twin.git
cd pocket-twin/live-avatar-backend
nano .env
```

Required `.env` values:

```dotenv
ELEVENLABS_API_KEY=sk-...
ELEVENLABS_VOICE_ID=...          # default fallback voice
OPENAI_API_KEY=sk-...
LIVE_AVATAR_RUNPOD_API_KEY=...   # only if using RunPod LivePortrait
LIVE_AVATAR_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID=...
```

### 2. Create virtualenv & install deps

```bash
cd /workspace/pocket-twin/live-avatar-backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Daily start (existing pod, code already set up)

### Kill old server, pull latest code, start fresh

```bash
pkill -f uvicorn; pkill -f "python.*main"; sleep 2 && cd /workspace/pocket-twin && git pull && cd live-avatar-backend && source .venv/bin/activate && set -a && source .env && set +a && uvicorn main:app --host 0.0.0.0 --port 8000
```

Wait for this log line before using the app (~60 s):

```
MuseTalk v1.5 models loaded on cuda
```

Backend port: **8000**

---

## Update app .env after new pod

Pod URL changes every new pod. Update mobile app `.env`:

```
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=https://<new-pod-id>-8000.proxy.runpod.net
```

Then restart Expo: `npx expo start -c`

---

## Notes

- Never start with `python main.py` — it exits immediately. Always use `uvicorn main:app`.
- `git reset --hard` strips execute bits. Use the direct uvicorn command above instead of shell scripts.
- virtualenv is `.venv` (not `venv`).
- MuseTalk models preload at startup (~60 s). Wait for the log line before testing.

