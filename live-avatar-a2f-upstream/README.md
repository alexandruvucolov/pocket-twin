# Pocket Twin NVIDIA Audio2Face upstream scaffold

This is the NVIDIA-only upstream service that sits behind [live-avatar-a2f-adapter/README.md](../live-avatar-a2f-adapter/README.md).

## Goal

This service is the place where real NVIDIA Audio2Face-3D SDK integration should live.

Planned flow:
1. receive session start
2. receive speak events
3. turn text into speech audio on the server side
4. convert audio into WAV/PCM chunks expected by NVIDIA Audio2Face
5. run Audio2Face streaming or low-latency executor
6. return motion data or rendered outputs to the adapter/backend pipeline

## What exists now

- REST contract for session lifecycle
- in-memory session tracking
- diagnostics for whether SDK paths are configured
- placeholder session states so integration can continue without blocking

## Endpoints

- `GET /health`
- `POST /sessions`
- `GET /sessions/{sessionId}`
- `POST /sessions/{sessionId}/speak`
- `POST /sessions/{sessionId}/close`

## Run locally

```bash
cd live-avatar-a2f-upstream
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8020
```

## Connect adapter to upstream

In [live-avatar-a2f-adapter/.env.example](../live-avatar-a2f-adapter/.env.example):

```dotenv
A2F_UPSTREAM_BASE_URL=http://YOUR_GPU_HOST:8020
A2F_UPSTREAM_API_KEY=
A2F_ENABLE_FAKE_MODE=false
```

## Connect live backend to adapter

In [live-avatar-backend/.env.example](../live-avatar-backend/.env.example):

```dotenv
LIVE_AVATAR_A2F_SERVICE_URL=http://YOUR_ADAPTER_HOST:8010
LIVE_AVATAR_A2F_API_KEY=
LIVE_AVATAR_A2F_AVATAR_ID=default-avatar
```

## What is still missing for real NVIDIA execution

You still need to implement:
- server-side TTS audio generation
- audio resampling to the format expected by Audio2Face samples
- SDK model loading using `NVIDIA_A2F_SDK_ROOT` and `NVIDIA_A2F_MODEL_PATH`
- streaming executor invocation
- turning blendshape / geometry output into rendered avatar frames or another consumable artifact

## Practical note

This scaffold is the clean NVIDIA-only direction.
It avoids driving-video logic entirely.
