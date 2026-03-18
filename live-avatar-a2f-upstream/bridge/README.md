# Pocket Twin Audio2Face bridge

This folder contains a tiny C++ bridge binary for NVIDIA Audio2Face.

## What it does

The bridge:
- loads a `model.json`
- loads a 16k WAV file
- adds default zero emotion
- runs offline Audio2Face geometry execution
- writes `a2f-summary.json` into the output folder

Current output is intentionally minimal:
- frame count
- timestamps
- geometry output sizes
- elapsed time

That is enough to validate the SDK path and wire the service end-to-end.

## Files

- `sdk-patch/.../main.cpp` — bridge source to compile inside the NVIDIA SDK tree
- `install_into_sdk.sh` — copies source into the SDK samples tree and patches sample CMake
- `build_bridge.sh` — installs and builds the bridge in the SDK build
- `run_bridge.sh` — runs the built bridge through NVIDIA's `run_sample.sh`

## Build on Runpod

```bash
cd ~/repo/live-avatar-a2f-upstream
chmod +x bridge/*.sh
./bridge/build_bridge.sh /root/Audio2Face-3D-SDK
```

## Manual run

```bash
cd ~/repo/live-avatar-a2f-upstream
NVIDIA_A2F_SDK_ROOT=/root/Audio2Face-3D-SDK \
./bridge/run_bridge.sh \
  --audio /tmp/test.wav \
  --model /root/Audio2Face-3D-SDK/_data/audio2face-models/audio2face-3d-v3.0/model.json \
  --output /tmp/a2f-out
```

## Use from the upstream service

Set:

```dotenv
NVIDIA_A2F_ENABLE_EXECUTION=true
NVIDIA_A2F_RUN_COMMAND=./bridge/run_bridge.sh --audio {audio_path} --model {model_path} --output {output_dir} --session {session_id} --utterance {utterance}
```

Then each `speak` request will call the bridge automatically.
