# Runpod start commands

These commands are tailored for the current Pocket Twin Runpod layout:

- repo: `/workspace/pocket-twin`
- backend public URL: `https://ukwj8sd7k5tutx-8000.proxy.runpod.net`

## 1. Prepare backend env

Backend env file:

- [live-avatar-backend/.env](live-avatar-backend/.env)

Fill these before start:

- `LIVE_AVATAR_RUNPOD_API_KEY`
- `LIVE_AVATAR_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID`
- TURN values if needed

## 2. Start Audio2Face adapter

From the pod:

```bash
cd /workspace/pocket-twin/live-avatar-a2f-adapter
chmod +x start_runpod_adapter.sh
./start_runpod_adapter.sh
```

Adapter port:
- `8010`

## 3. Start live avatar backend

From another shell:

```bash
cd /workspace/pocket-twin/live-avatar-backend
chmod +x start_runpod_backend.sh
./start_runpod_backend.sh
```

Backend port:
- `8000`

Static rendered files will be served from:
- `https://ukwj8sd7k5tutx-8000.proxy.runpod.net/results/...`

## 4. Run worker locally on the pod for testing

```bash
cd /workspace/pocket-twin/liveportrait-runpod-worker
chmod +x start_local_worker.sh
./start_local_worker.sh
```

This uses:
- [liveportrait-runpod-worker/examples/current-runpod.exports.sh](liveportrait-runpod-worker/examples/current-runpod.exports.sh)

## 5. Use for Serverless env packaging

Use these files as the source of truth:

- [liveportrait-runpod-worker/examples/current-runpod.exports.sh](liveportrait-runpod-worker/examples/current-runpod.exports.sh)
- [liveportrait-runpod-worker/examples/pocket-twin-runpod.env.example](liveportrait-runpod-worker/examples/pocket-twin-runpod.env.example)
- [live-avatar-backend/.env](live-avatar-backend/.env)

For the Serverless worker entrypoint, use:

```bash
python /workspace/pocket-twin/liveportrait-runpod-worker/handler.py
```

## 6. App setting

Mobile app backend URL is already set to:

```dotenv
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=https://ukwj8sd7k5tutx-8000.proxy.runpod.net
```
