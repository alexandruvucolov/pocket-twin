# RunPod Serverless Setup — LatentSync Lip-sync Worker

This replaces the persistent GPU pod with a **pay-per-use serverless endpoint**.
The GPU only runs when a message is sent (~14-30 s per response, ~$0.003-0.006 per call on an RTX 3090).

---

## 1. Prerequisites

- RunPod account at https://runpod.io
- Docker Hub account (free) — to push the worker image
- Docker installed locally

---

## 2. Build & Push the Worker Image

**Build from the project root** (not from inside `latentsync-runpod-worker/`):

```bash
cd "/path/to/Pocket Twin"

docker build \
  -f latentsync-runpod-worker/Dockerfile \
  -t your-dockerhub-username/pocket-twin-latentsync:latest \
  .
```

> The build downloads ~5 GB of LatentSync checkpoints into the image.
> This takes 20-40 minutes on first build; subsequent builds use the cache.

Push to Docker Hub:

```bash
docker push your-dockerhub-username/pocket-twin-latentsync:latest
```

---

## 3. Create the Serverless Endpoint on RunPod

1. Go to **RunPod → Serverless → + New Endpoint**
2. **Container image**: `your-dockerhub-username/pocket-twin-latentsync:latest`
3. **Container disk**: 40 GB (checkpoints + model cache)
4. **GPU**: RTX 3090 or RTX 4090
5. **Min workers**: 0 (cheapest — cold starts ~30 s)
   - Set to 1 if you need instant responses (flat hourly cost applies)
6. **Max workers**: 3 (adjust to taste)
7. Click **Deploy**

After deployment, copy the **Endpoint ID** (looks like `abc123def456`).

---

## 4. Configure the App

Add these to your app `.env` (same file as all other `EXPO_PUBLIC_` vars):

```env
EXPO_PUBLIC_RUNPOD_API_KEY=your_runpod_api_key_here
EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID=abc123def456
```

Get your RunPod API key at: **Account → API Keys → + API Key**

Restart Expo after adding env vars:

```bash
npx expo start -c
```

---

## 5. Test the Endpoint

Send a test job from the RunPod dashboard:

**Endpoint → Send Test Job** with this payload:

```json
{
  "input": {
    "source_image_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gatto_europeo4.jpg/200px-Gatto_europeo4.jpg",
    "audio_url": "https://www2.cs.uic.edu/~i101/SoundFiles/BabyElephantWalk60.wav"
  }
}
```

Expected output (after ~20-30 s):
```json
{ "video_url": "https://tmpfiles.org/dl/12345/output.mp4" }
```

---

## 6. How It Works (App Flow)

```
User sends message
       ↓
AI generates text reply (~1-2 s)
       ↓
ElevenLabs TTS → audio base64 (~1 s)
       ↓
RunPod job submitted → IN_QUEUE → IN_PROGRESS
       ↓  (phone shows blurred avatar + % progress)
LatentSync generates lip-sync video (~14-25 s)
       ↓
Video uploaded to tmpfiles.org → URL returned
       ↓
App plays video with audio unmuted (avatar speaks)
       ↓
Idle loop / static image restored
```

---

## 7. Cost Estimate

| Scenario | Cost per response |
|---|---|
| Cold start (worker was idle) | ~$0.01-0.02 (includes ~30 s warm-up) |
| Warm worker (min_workers=1) | ~$0.003-0.006 |
| Always-on (min_workers=1, RTX 3090) | ~$0.28/hr flat |
| Persistent pod (old approach) | ~$0.74/hr flat (RTX 4090) |

---

## 8. Fallback

If `EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID` is not set, the app falls back to local TTS audio only (no lip-sync video). The chat still works — the avatar stays static.

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Job stays IN_QUEUE forever | Check endpoint is deployed; check GPU availability in your selected region |
| `video_url` missing from output | Check worker logs in RunPod dashboard for Python errors |
| Cold start > 2 minutes | Set `min_workers=1` to keep a warm worker |
| Checkpoints download on every cold start | They're baked into the Docker image — should not re-download |
| Docker build fails | Make sure you're building from project root, not from inside `latentsync-runpod-worker/` |
