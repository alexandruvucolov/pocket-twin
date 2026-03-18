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
- WAV artifact preparation for each `speak` call
- execution manifest generation per utterance
- optional shell-command bridge into a real NVIDIA runner
- optional ElevenLabs TTS for real 16k WAV output
- tone fallback when TTS is not configured

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

You still need a real NVIDIA bridge executable or script.

What now exists:
- per-utterance `.wav`
- per-utterance `request.json`
- optional automatic execution through `NVIDIA_A2F_RUN_COMMAND`
- captured `stdout.log`, `stderr.log`, and `result.json`

That means this service can now hand off real work to a compiled Audio2Face runner as soon as you provide one.

## Current practical progress

This upstream now prepares a `.wav` artifact for each `speak` call and can invoke a real bridge command. The next NVIDIA-only step is:

1. build a small Audio2Face bridge executable against the NVIDIA SDK
2. point `NVIDIA_A2F_RUN_COMMAND` at that bridge
3. have the bridge write blendshape / geometry outputs into the utterance output folder
4. connect those outputs back to the live avatar renderer

## Practical note

This scaffold is the clean NVIDIA-only direction.
It avoids driving-video logic entirely.

## Execution bridge contract

For each `speak`, the service creates an output folder like:

- `outputs/<sessionId>/utt-0001/request.json`
- `outputs/<sessionId>/utt-0001/stdout.log`
- `outputs/<sessionId>/utt-0001/stderr.log`
- `outputs/<sessionId>/utt-0001/result.json`

Your bridge command should read the request info and write any generated files into that same output folder.

Suggested bridge inputs:

- audio wav path
- model path
- output folder
- optional session id / utterance id

Suggested bridge outputs:

- `blendshapes.json`
- `geometry.json`
- `timings.json`

## Included bridge

This repo now includes a tiny SDK-side bridge in [live-avatar-a2f-upstream/bridge/README.md](bridge/README.md).

It currently validates the real NVIDIA path by:

- loading the selected `model.json`
- loading the prepared 16k wav
- running offline geometry execution
- writing `a2f-summary.json`

Recommended service env:

```dotenv
NVIDIA_A2F_ENABLE_EXECUTION=true
NVIDIA_A2F_RUN_COMMAND=./bridge/run_bridge.sh --audio {audio_path} --model {model_path} --output {output_dir} --session {session_id} --utterance {utterance}
```

## Fast Runpod setup

This repo now includes two helpers:

- [live-avatar-a2f-upstream/write_runpod_env.sh](write_runpod_env.sh)
- [live-avatar-a2f-upstream/start_upstream.sh](start_upstream.sh)
- [live-avatar-a2f-upstream/setup_runpod_sdk.sh](setup_runpod_sdk.sh)

Minimal Runpod flow:

1. build the bridge
2. write `.env`
3. start the upstream service

## One-shot Runpod bootstrap

If you want the full GPU-side setup from scratch on a fresh Runpod pod, use:

```bash
cd live-avatar-a2f-upstream
chmod +x setup_runpod_sdk.sh
sudo A2F_START_UPSTREAM=true ./setup_runpod_sdk.sh
```

What it does:

1. installs base Linux packages such as `git-lfs` and `ffmpeg`
2. clones `NVIDIA/Audio2Face-3D-SDK` into `/workspace/Audio2Face-3D-SDK`
3. builds the SDK
4. logs into Hugging Face and downloads the gated models
5. generates the required `audio2face-3d-v3.0/network.trt`
6. builds the Pocket Twin bridge
7. writes `.env`
8. optionally starts the upstream service

Notes:

- export `TENSORRT_ROOT_DIR` before running if TensorRT is not in `/opt/tensorrt`
- export `CUDA_PATH` before running if CUDA is not in `/usr/local/cuda-12.8`
- export `A2F_HF_TOKEN` to avoid the interactive Hugging Face login prompt
- set `A2F_RUN_FULL_GEN_TESTDATA=true` if you want the full SDK test-data generation instead of only the minimal `network.trt`

## Recommended env values on Runpod

Use:

```dotenv
NVIDIA_A2F_SDK_ROOT=/root/Audio2Face-3D-SDK
NVIDIA_A2F_MODEL_PATH=/root/Audio2Face-3D-SDK/_data/audio2face-models/audio2face-3d-v3.0/model.json
```
