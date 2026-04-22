# Runpod + LivePortrait setup

This app can generate a selfie preview clip with Runpod Serverless + LivePortrait.

## Livestream-only answer

If your goal is only a live streaming avatar experience, the required path is:

- Runpod Po;d or equivalent always-on GPU service
- your own HTTPS signaling backend
- WebRTC
- a realtime-capable LivePortrait serving layer
- TTS plus an audio-to-motion or viseme layer

You do not need the async Runpod Serverless endpoint for that core live experience.

Serverless remains optional for:
- onboarding preview clips
- fallback rendered videos
- cached intro animations

### Minimum things to set for livestream

In the app, the key required env is:

```dotenv
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=
```

Optional if your backend expects a public token:

```dotenv
EXPO_PUBLIC_LIVE_AVATAR_PUBLIC_TOKEN=
```

### Minimum external services to prepare

1. Runpod Pod
2. Live backend deployed on that pod
3. TURN/STUN provider
4. TTS provider
5. audio-to-motion or viseme layer

### Do not rely on this for live mode

Do not use queue-style Runpod Serverless `/run` and `/status` as the main live-stream transport.

## Important constraint

Official LivePortrait is not audio-driven.

It expects:
- a source portrait image, and
- a driving video or motion template

That means:
- good fit for avatar creation or canned preview animation
- not a full replacement for a talking-head pipeline driven directly by TTS audio

If you want spoken video replies later, use either:
- a custom worker that converts audio to motion first, or
- a separate audio-driven talking-head model

## Lip-only retargeting

LivePortrait can be driven in a lip-focused mode where only the mouth motion is transferred while head pose, gaze, and most other expression channels stay fixed.

This repo now supports passing lip-only hints through the live avatar session contract and backend Runpod request.

Backend envs:

```dotenv
LIVE_AVATAR_LIVEPORTRAIT_MODE=lips-only
LIVE_AVATAR_LIVEPORTRAIT_MOTION_TEMPLATE_URL=
LIVE_AVATAR_LIVEPORTRAIT_PRESERVE_HEAD_POSE=true
LIVE_AVATAR_LIVEPORTRAIT_PRESERVE_EYE_GAZE=true
LIVE_AVATAR_LIVEPORTRAIT_NORMALIZE_LIPS=true
```

If your Runpod worker expects different parameter names, set them through:

```dotenv
LIVE_AVATAR_LIVEPORTRAIT_DEFAULT_INPUT_JSON={"retarget_module":"R_lip","animation_region":"lips"}
```

That raw JSON is merged into the Runpod `input` payload, so you can map to the exact worker schema without changing app code again.

If you do not already have a worker-side normalization layer, use the reference shim in [liveportrait-runpod-worker/README.md](liveportrait-runpod-worker/README.md).

## Realtime streaming with WebRTC

Yes, realtime streaming is possible, but the architecture is different from the async preview flow.

For realtime:
- the mobile app uses WebRTC
- a persistent GPU service runs on Runpod
- that service generates frames continuously
- a media server or custom signaling layer sends video back to the phone

Important:
- queue-based Runpod Serverless endpoints are not a good fit for low-latency live avatar streaming
- they are request/job based and better for async generation
- for realtime streaming, prefer a persistent Runpod Pod or a Runpod load-balancing endpoint backed by long-running workers

### Recommended realtime architecture

1. User uploads selfie
2. Backend prepares the LivePortrait source portrait and warm model state
3. Mobile app opens a WebRTC session
4. Backend receives audio chunks, viseme signals, or driving signals
5. Realtime LivePortrait service renders frames on the GPU
6. Backend streams frames back over WebRTC

### Realtime signaling contract expected by the app

The mobile app now expects your live backend to expose these HTTP endpoints:

#### Create session

`POST /api/live-avatar/sessions`

Request body:

```json
{
  "avatarId": "123",
  "avatarName": "Sophie",
  "sourceImageUrl": "https://..."
}
```

or, if the image is only local on-device:

```json
{
  "avatarId": "123",
  "avatarName": "Sophie",
  "sourceImageBase64": "...",
  "sourceImageMimeType": "image/jpeg"
}
```

Response body:

```json
{
  "sessionId": "session_abc",
  "offer": {
    "type": "offer",
    "sdp": "..."
  },
  "iceServers": [
    {
      "urls": ["stun:stun.l.google.com:19302"]
    }
  ]
}
```

#### Submit answer

`POST /api/live-avatar/sessions/:sessionId/answer`

```json
{
  "answer": {
    "type": "answer",
    "sdp": "..."
  }
}
```

#### Submit ICE candidate

`POST /api/live-avatar/sessions/:sessionId/ice`

```json
{
  "candidate": "candidate:...",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```

#### Speak text

`POST /api/live-avatar/sessions/:sessionId/speak`

```json
{
  "text": "Hello!"
}
```

#### Delete session

`DELETE /api/live-avatar/sessions/:sessionId`

### What WebRTC is for here

WebRTC is the transport layer for:
- low-latency video back to the app
- optional microphone audio up to the backend
- connection management for a continuous live session

WebRTC is not what makes LivePortrait realtime by itself. It only carries the media.

### What makes LivePortrait realtime

You need a realtime-capable LivePortrait serving layer, for example:
- a custom persistent Python service around LivePortrait
- a faster community variant such as FasterLivePortrait
- or a hybrid pipeline that converts audio to driving motion, then renders with LivePortrait continuously

### Best Runpod choice

Use:
- Runpod Pod, or
- Runpod load-balancing endpoint for custom HTTP or streaming services

Avoid relying on queue-style Serverless `/run` and `/status` for true live sessions.

Those are still useful for:
- selfie preview generation
- precomputing intro animations
- offline reply videos

## Recommended worker contract

The mobile app submits this input shape to your Runpod Serverless endpoint:

```json
{
  "input": {
    "source_image_url": "https://...",
    "driving_video_url": "https://...",
    "output_format": "mp4"
  }
}
```

The app expects the completed worker result to contain a public video URL in one of these fields:

```json
{
  "video_url": "https://.../result.mp4"
}
```

or nested under `output.video_url`.

## Required env vars

Add these to your local env:

```dotenv
EXPO_PUBLIC_RUNPOD_API_KEY=
EXPO_PUBLIC_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID=
EXPO_PUBLIC_LIVEPORTRAIT_DRIVING_VIDEO_URL=
EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL=
```

Optional:

```dotenv
EXPO_PUBLIC_RUNPOD_BASE_URL=https://api.runpod.ai/v2
EXPO_PUBLIC_LIVE_AVATAR_PUBLIC_TOKEN=
```

If your goal is live streaming now, yes — you should set the live backend URL.

- `EXPO_PUBLIC_RUNPOD_*` values are for async preview generation and worker communication
- `EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL` is the important value for realtime WebRTC signaling
- `EXPO_PUBLIC_LIVE_AVATAR_PUBLIC_TOKEN` is optional if your signaling backend expects a public bearer token

## Security note

`EXPO_PUBLIC_*` values are bundled into the client app.

For local testing, direct client calls are acceptable.

For production, do not expose your real Runpod API key in the mobile app. Use a secure backend or proxy that:
- stores the Runpod key server-side
- accepts a request from the app
- forwards the job to Runpod
- returns the result URL

## What is wired today

- avatar creation can call LivePortrait after the selfie is uploaded
- the generated mp4 becomes the avatar’s `videoUrl`
- the chat screen can already display that `videoUrl`
- this is async generation, not realtime streaming

## Suggested production architecture

1. Mobile app uploads selfie to Firebase Storage
2. Backend/proxy submits Runpod LivePortrait job
3. Worker returns `video_url`
4. App stores that URL on the avatar record
5. Chat uses the saved mp4 as the avatar preview clip

## Suggested production architecture for live mode

1. Mobile app creates or selects selfie avatar
2. Backend stores the source portrait and initializes the realtime avatar session
3. App connects with WebRTC using `react-native-webrtc`
4. Backend service on Runpod Pod renders frames continuously
5. WebRTC returns the live video stream to the app
6. Optional TTS or microphone input drives animation through a custom motion layer

## Runpod endpoint notes

Use the async job flow:
- `POST /run`
- `GET /status/{jobId}`

This app polls until status becomes `COMPLETED`.

## Current limitation in this codebase

The new Runpod integration is currently used for avatar creation preview generation.

The conversation reply path is still separate because LivePortrait alone does not accept raw reply audio as input.

The app now uses the custom live avatar backend for realtime WebRTC replies.