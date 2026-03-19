export LIVEPORTRAIT_INFERENCE_SCRIPT=/workspace/pocket-twin/liveportrait-runpod-worker/your_infer.py
export LIVEPORTRAIT_BASE_COMMAND="python /workspace/LivePortrait/inference.py"
export LIVEPORTRAIT_SOURCE_ARG=--source
export LIVEPORTRAIT_DRIVING_ARG=--driving
export LIVEPORTRAIT_MOTION_ARG=--motion-template
export LIVEPORTRAIT_OUTPUT_ARG=--output
export LIVEPORTRAIT_MODE_ARG=--mode
export LIVEPORTRAIT_PUBLIC_RESULTS_DIR=/workspace/liveportrait-results
export LIVEPORTRAIT_PUBLIC_BASE_URL=https://ukwj8sd7k5tutx-8000.proxy.runpod.net/results
export LIVEPORTRAIT_UPLOAD_COMMAND_TEMPLATE="python /workspace/pocket-twin/liveportrait-runpod-worker/examples/upload_result.py {output_video_path}"

export LIVE_AVATAR_PUBLIC_RESULTS_DIR=/workspace/liveportrait-results
export LIVE_AVATAR_LIVEPORTRAIT_MODE=lips-only
export LIVE_AVATAR_LIVEPORTRAIT_PRESERVE_HEAD_POSE=true
export LIVE_AVATAR_LIVEPORTRAIT_PRESERVE_EYE_GAZE=true
export LIVE_AVATAR_LIVEPORTRAIT_NORMALIZE_LIPS=true
export LIVE_AVATAR_LIVEPORTRAIT_DEFAULT_INPUT_JSON='{"retarget_module":"R_lip","animation_region":"lips"}'

# Fill these on the pod before starting services:
# export LIVE_AVATAR_RUNPOD_API_KEY=...
# export LIVE_AVATAR_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID=...
# export LIVE_AVATAR_A2F_SERVICE_URL=http://127.0.0.1:8010