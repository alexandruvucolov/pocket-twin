# Audio2Face setup

This project now supports an optional Audio2Face adapter layer.

## What is implemented now

The live backend in [live-avatar-backend/main.py](live-avatar-backend/main.py):
- creates and manages WebRTC sessions
- can forward `session started`, `speak`, and `close` events to an external Audio2Face adapter service
- keeps the current in-backend visual fallback if the Audio2Face service is absent

The adapter client lives in [live-avatar-backend/audio2face.py](live-avatar-backend/audio2face.py).

## Why an adapter service is needed

NVIDIA Audio2Face-3D SDK is not a simple hosted REST API in this project.
A practical architecture is:

1. Pocket Twin live backend receives `/sessions` and `/speak`
2. backend forwards those events to a separate Audio2Face adapter service
3. adapter service runs on a GPU machine with NVIDIA Audio2Face-3D SDK / ACE assets
4. adapter service turns audio-driven speech into facial motion data or rendered frames
5. live backend either:
   - consumes rendered clips / frame outputs, or
   - keeps using fallback visuals until the renderer is connected

## Current adapter contract

The live backend expects the adapter service to expose:

### Start session

`POST /sessions`

```json
{
  "sessionId": "session_123",
  "avatarId": "avatar_1",
  "avatarName": "Sophie",
  "sourceImageUrl": "https://...",
  "avatarProfileId": "default-avatar"
}
```

### Speak

`POST /sessions/:sessionId/speak`

```json
{
  "sessionId": "session_123",
  "avatarProfileId": "default-avatar",
  "text": "Hello there"
}
```

### Close session

`POST /sessions/:sessionId/close`

```json
{
  "sessionId": "session_123"
}
```

## Env vars for the live backend

Set these in Runpod `live-avatar-backend/.env` only when the adapter exists:

```dotenv
LIVE_AVATAR_A2F_SERVICE_URL=
LIVE_AVATAR_A2F_API_KEY=
LIVE_AVATAR_A2F_AVATAR_ID=default-avatar
```

## Full target architecture

For a real Audio2Face path, the adapter service will also need:

- ElevenLabs or another TTS provider on the server side
- WAV/PCM conversion for the generated audio
- NVIDIA Audio2Face-3D SDK models and runtime
- a renderer that converts blendshapes / geometry into a video stream or frames

## Recommended next implementation step

Build a small GPU-side Audio2Face adapter service with these responsibilities:

1. accept text or audio for a session
2. generate or receive 16k speech audio
3. run Audio2Face streaming inference
4. return either:
   - blendshape frames, or
   - a rendered MP4 / frame sequence
5. expose a REST contract matching this document

## Important note

What is done here is only the backend scaffolding for Audio2Face integration.
The actual NVIDIA inference service still needs to be deployed separately.
