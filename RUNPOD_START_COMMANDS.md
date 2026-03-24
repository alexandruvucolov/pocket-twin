# RunPod Start Commands

## New pod - one command cold start (LatentSync)

After creating a **new** pod (RTX 4090, PyTorch 2.4 / CUDA 12.4 template):

```bash
curl -fsSL https://raw.githubusercontent.com/alexandruvucolov/pocket-twin/main/live-avatar-backend/start_new_pod.sh | bash
```

Or if you prefer to clone first:

```bash
git clone https://github.com/alexandruvucolov/pocket-twin.git /workspace/pocket-twin
bash /workspace/pocket-twin/live-avatar-backend/start_new_pod.sh
```

This script does **everything** automatically:
1. Clones pocket-twin (or pulls latest)
2. Writes `.env` with all credentials
3. Clones LatentSync repo
4. Installs LatentSync + ML dependencies
5. Downloads all checkpoints (~5 GB from HuggingFace)
6. Creates backend venv + installs requirements
7. Starts the server on port 8000

Total time on a fresh pod: ~10-15 minutes (mostly checkpoint download).

---

## Existing pod - restart server (everything already installed)

```bash
cd /workspace/pocket-twin && git pull && pkill -f uvicorn; sleep 1 && cd live-avatar-backend && source .venv/bin/activate && set -a && source .env && set +a && uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## Pod URL

After the server starts, the backend is available at:

```
https://<POD_ID>-8000.proxy.runpod.net
```

Set this in your app `.env`:

```
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=https://<POD_ID>-8000.proxy.runpod.net
```

---

## Credentials reference

| Variable | Value |
|---|---|
| `ELEVENLABS_API_KEY` | `sk_e2c9fabaa0bbe746f5e9eacba9644d6eed7cdb7ad45a955a` |
| `ELEVENLABS_VOICE_ID` | `PIGsltMj3gFMR34aFDI3` |
| `LIVE_AVATAR_METERED_DOMAIN` | `pocket_twin.metered.live` |
| `LIVE_AVATAR_METERED_API_KEY` | `480fc4fe2da0fbfa5ef46a3aaf650ca386f2` |
| `LIVE_AVATAR_METERED_INSECURE_TLS` | `true` |
| `LATENTSYNC_DIR` | `/workspace/LatentSync` |
