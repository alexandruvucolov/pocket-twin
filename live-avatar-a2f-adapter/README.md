# Pocket Twin Audio2Face adapter service

This service sits between the live avatar backend and a future NVIDIA Audio2Face / ACE deployment.

## What it does now

- exposes REST endpoints expected by [live-avatar-backend/audio2face.py](../live-avatar-backend/audio2face.py)
- stores session state in memory
- forwards requests to an optional upstream Audio2Face-facing service
- works in `fake` mode if no upstream is configured

## Endpoints

- `GET /health`
- `POST /sessions`
- `GET /sessions/{sessionId}`
- `POST /sessions/{sessionId}/speak`
- `POST /sessions/{sessionId}/close`

## Run locally

```bash
cd live-avatar-a2f-adapter
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8010
```

## Fake mode

When `A2F_UPSTREAM_BASE_URL` is empty, the adapter works in fake mode.
It accepts events and keeps session state, but does not call a real NVIDIA service.

## Upstream mode

If you later build a true GPU-side NVIDIA service, point the adapter at it:

```dotenv
A2F_UPSTREAM_BASE_URL=http://YOUR-GPU-SERVICE:PORT
A2F_UPSTREAM_API_KEY=
A2F_ENABLE_FAKE_MODE=false
```

Expected upstream endpoints:

- `POST /sessions`
- `POST /sessions/{sessionId}/speak`
- `POST /sessions/{sessionId}/close`

## Connect it to the live backend

In the Runpod backend `.env` for [live-avatar-backend/main.py](../live-avatar-backend/main.py):

```dotenv
LIVE_AVATAR_A2F_SERVICE_URL=http://YOUR-ADAPTER-HOST:8010
LIVE_AVATAR_A2F_API_KEY=
LIVE_AVATAR_A2F_AVATAR_ID=default-avatar
```

## Important note

This adapter is the scaffold only.
It does not run NVIDIA Audio2Face inference by itself.
The real next step is implementing or deploying the GPU-side upstream service that turns speech audio into facial motion or rendered frames.
