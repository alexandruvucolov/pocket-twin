# Pocket Twin live avatar backend

This is the bootstrap backend for the mobile app's live avatar WebRTC contract.

## What it gives you

- `/health`
- `/api/live-avatar/sessions`
- `/api/live-avatar/sessions/:sessionId/answer`
- `/api/live-avatar/sessions/:sessionId/ice`
- `/api/live-avatar/sessions/:sessionId/speak`
- `/api/live-avatar/sessions/:sessionId`

It is a placeholder scaffold only.
The SDP offer is still fake and must be replaced with real `aiortc` session code.

## Run locally on the pod

```bash
cd ~/live-avatar-backend
python -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Test

```bash
curl http://127.0.0.1:8000/health
```

Expected:

```json
{"ok": true}
```

## Public URL for the app

After you expose port `8000` in Runpod, the public base URL for that port becomes:

- `EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL`

Use the proxy base URL only, without `/health`.

Example:

```dotenv
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=https://YOUR-POD-8000.proxy.runpod.net
```

## Next required step

Replace the fake offer in `main.py` with a real `aiortc` WebRTC implementation.
