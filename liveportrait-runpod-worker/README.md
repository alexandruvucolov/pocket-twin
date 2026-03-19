# LivePortrait Runpod worker

This is a small Runpod Serverless worker shim for Pocket Twin.

It does two things:
- normalizes the app/backend request shape into a single LivePortrait input payload
- applies lip-only defaults when `live_portrait_mode` is `lips-only`

## What it supports

Input aliases accepted by the worker:
- `source_image_url`
- `sourceImageUrl`
- `source_image_base64`
- `sourceImageBase64`
- `driving_video_url`
- `drivingVideoUrl`
- `motion_template_url`
- `motionTemplateUrl`
- `live_portrait_mode`
- `livePortraitMode`
- `live_portrait_options`
- `livePortraitOptions`

When mode is `lips-only`, the worker fills these defaults unless already supplied:
- `animation_region=lips`
- `retarget_part=lips`
- `retarget_module=R_lip`
- `preserve_head_pose=true`
- `preserve_eye_gaze=true`
- `normalize_lips=true`

## How inference is delegated

The worker expects this env var:

```dotenv
LIVEPORTRAIT_INFERENCE_SCRIPT=/workspace/liveportrait-runpod-worker/example_infer.py
```

The script contract is:

```bash
python script.py <input.json> <output.json>
```

The script must write a JSON object to `output.json` with at least one of:
- `video_url`
- `url`
- `result_url`
- `mp4_url`

## Real inference integration

Replace [example_infer.py](example_infer.py) with your actual LivePortrait pipeline wrapper.

A ready-to-customize adapter skeleton is included at [your_infer.py](your_infer.py).

That wrapper should:
1. read the normalized input JSON
2. map fields to your local LivePortrait implementation
3. run inference
4. upload or expose the resulting mp4
5. write `{ "video_url": "https://..." }` to the output JSON

## Example Runpod env

```dotenv
LIVEPORTRAIT_INFERENCE_SCRIPT=/workspace/liveportrait-runpod-worker/your_infer.py
LIVEPORTRAIT_BASE_COMMAND=python /workspace/LivePortrait/inference.py
LIVEPORTRAIT_SOURCE_ARG=--source
LIVEPORTRAIT_DRIVING_ARG=--driving
LIVEPORTRAIT_MOTION_ARG=--motion-template
LIVEPORTRAIT_OUTPUT_ARG=--output
LIVEPORTRAIT_MODE_ARG=--mode
LIVEPORTRAIT_RESULT_URL_TEMPLATE=https://YOUR-HOST/results/{output_video_name}
```

Or use a fully custom command template:

```dotenv
LIVEPORTRAIT_INFER_COMMAND_TEMPLATE=python /workspace/LivePortrait/inference.py --source {source_image_path} --driving {driving_video_path} --output {output_video_path} --mode {live_portrait_mode}
```

If your output file must be uploaded after inference, set:

```dotenv
LIVEPORTRAIT_UPLOAD_COMMAND_TEMPLATE=python /workspace/upload_result.py {output_video_path}
```

The upload command must print the final public URL to stdout.

## Ready-made examples

Use one of these as a starting point:

- Official repo style env: [liveportrait-runpod-worker/examples/official-repo.env.example](examples/official-repo.env.example)
- Docker invocation env: [liveportrait-runpod-worker/examples/docker.env.example](examples/docker.env.example)
- Pocket Twin Runpod env: [liveportrait-runpod-worker/examples/pocket-twin-runpod.env.example](examples/pocket-twin-runpod.env.example)
- Current Runpod export block: [liveportrait-runpod-worker/examples/current-runpod.exports.sh](examples/current-runpod.exports.sh)
- Simple local copy uploader: [liveportrait-runpod-worker/examples/upload_result.py](examples/upload_result.py)
- Quick start notes: [liveportrait-runpod-worker/examples/runpod-start.txt](examples/runpod-start.txt)

### Official repo layout example

If your Runpod pod has a checkout like:

```text
/workspace/LivePortrait
/workspace/liveportrait-runpod-worker
```

then start from [examples/official-repo.env.example](examples/official-repo.env.example).

If your pod matches the Pocket Twin layout used during this project:

```text
/workspace/pocket-twin
/workspace/LivePortrait
```

start from [examples/pocket-twin-runpod.env.example](examples/pocket-twin-runpod.env.example).

### Docker example

If you run LivePortrait through a container image instead of a host checkout, start from [examples/docker.env.example](examples/docker.env.example).

The `LIVEPORTRAIT_INFER_COMMAND_TEMPLATE` placeholders are resolved by [your_infer.py](your_infer.py):

- `{source_image_path}`
- `{driving_video_path}`
- `{motion_template_path}`
- `{audio_path}`
- `{output_video_path}`
- `{output_video_name}`
- `{live_portrait_mode}`
- `{animation_region}`
- `{retarget_part}`
- `{retarget_module}`

## Why this exists

Your app/backend now sends lip-only hints, but the existing repo did not contain the actual Runpod LivePortrait worker code.

This folder provides the missing request-normalization layer so your endpoint can honor:
- `live_portrait_mode=lips-only`
- `retarget_module=R_lip`
- lip-only preservation flags

without changing the mobile app contract again.

For the exact Pocket Twin startup sequence on Runpod, see [RUNPOD_START_COMMANDS.md](../RUNPOD_START_COMMANDS.md).
