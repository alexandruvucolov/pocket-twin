/**
 * latentsync-serverless.ts
 *
 * Client for the LatentSync RunPod serverless endpoint.
 *
 * Required env vars:
 *   EXPO_PUBLIC_RUNPOD_API_KEY                   – RunPod API key
 *   EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID    – serverless endpoint ID
 *
 * Optional:
 *   EXPO_PUBLIC_RUNPOD_BASE_URL  (default: https://api.runpod.ai/v2)
 */

const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const v = (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_RUNPOD_API_KEY is not set.");
  return v;
}

function getEndpointId(): string {
  const v = (
    process.env.EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID ?? ""
  ).trim();
  if (!v)
    throw new Error("EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID is not set.");
  return v;
}

function getBaseUrl(): string {
  return (process.env.EXPO_PUBLIC_RUNPOD_BASE_URL ?? RUNPOD_BASE_URL).trim();
}

export function isLatentSyncServerlessConfigured(): boolean {
  return Boolean(
    (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim() &&
    (process.env.EXPO_PUBLIC_RUNPOD_LATENTSYNC_ENDPOINT_ID ?? "").trim(),
  );
}

// ---------------------------------------------------------------------------
// Job submission
// ---------------------------------------------------------------------------

export interface LatentSyncJobInput {
  /** Public URL of the avatar image (preferred — no base64 overhead). */
  sourceImageUrl?: string;
  /** Base64-encoded image (fallback for local files). */
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
  /** Base64-encoded MP3/WAV audio from ElevenLabs. */
  audioBase64: string;
  /** Number of diffusion inference steps (default 10). */
  numInferenceSteps?: number;
  /** BBox vertical shift in pixels (default 0). */
  bboxShift?: number;
}

export async function submitLatentSyncJob(
  params: LatentSyncJobInput,
): Promise<{ id: string }> {
  const res = await fetch(`${getBaseUrl()}/${getEndpointId()}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        source_image_url: params.sourceImageUrl,
        source_image_base64: params.sourceImageBase64,
        source_image_mime_type: params.sourceImageMimeType,
        audio_base64: params.audioBase64,
        num_inference_steps: params.numInferenceSteps ?? 10,
        bbox_shift: params.bboxShift ?? 0,
      },
    }),
  });

  const body = await res.text();
  if (!res.ok)
    throw new Error(`RunPod job submission failed (${res.status}): ${body}`);

  const data = JSON.parse(body) as { id: string };
  return { id: data.id };
}

// ---------------------------------------------------------------------------
// Job polling with simulated progress
// ---------------------------------------------------------------------------

type RunpodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | string;

interface RunpodJobState {
  id: string;
  status: RunpodStatus;
  output?: unknown;
  error?: string;
}

/**
 * Poll until COMPLETED, calling `onProgress(0-100)` at each tick.
 * Progress is estimated:
 *   IN_QUEUE:      0–10 %  (based on wait time, up to 20 s queue wait)
 *   IN_PROGRESS:  10–90 %  (based on elapsed time, assuming ~25 s generation)
 *   COMPLETED:    100 %
 *
 * Returns the public video URL from the job output.
 */
export async function pollLatentSyncJob(
  jobId: string,
  onProgress: (percent: number) => void,
  options?: {
    maxWaitMs?: number;
    pollIntervalMs?: number;
    /** Expected total generation time in ms (used for progress simulation). */
    expectedGenerationMs?: number;
  },
): Promise<string> {
  const endpointId = getEndpointId();
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();

  const maxWaitMs = options?.maxWaitMs ?? 300_000; // 5 min hard cap
  const pollIntervalMs = options?.pollIntervalMs ?? 1_500;
  const expectedMs = options?.expectedGenerationMs ?? 30_000;

  const startTime = Date.now();
  let inProgressSince: number | null = null;

  while (Date.now() - startTime < maxWaitMs) {
    const res = await fetch(`${baseUrl}/${endpointId}/status/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.text();
    if (!res.ok)
      throw new Error(`RunPod status check failed (${res.status}): ${body}`);

    const state = JSON.parse(body) as RunpodJobState;
    const elapsed = Date.now() - startTime;

    switch (state.status) {
      case "IN_QUEUE": {
        // 0–10 % while queued (assumes max 20 s queue wait)
        const pct = Math.min(10, Math.round((elapsed / 20_000) * 10));
        onProgress(pct);
        break;
      }

      case "IN_PROGRESS": {
        if (inProgressSince === null) inProgressSince = Date.now();
        const genElapsed = Date.now() - inProgressSince;
        // 10–90 % while running
        const pct =
          10 + Math.min(80, Math.round((genElapsed / expectedMs) * 80));
        onProgress(pct);
        break;
      }

      case "COMPLETED": {
        onProgress(100);
        const videoUrl = _extractVideoUrl(state.output);
        if (!videoUrl)
          throw new Error(
            "RunPod job completed but output contained no video URL. " +
              "Check worker logs.",
          );
        return videoUrl;
      }

      case "FAILED":
        throw new Error(`RunPod job failed: ${state.error ?? "unknown error"}`);

      case "CANCELLED":
        throw new Error("RunPod job was cancelled.");

      default:
        break;
    }

    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`RunPod job ${jobId} timed out after ${maxWaitMs / 1000} s.`);
}

// ---------------------------------------------------------------------------
// Internal: extract video URL from various output shapes
// ---------------------------------------------------------------------------

function _extractVideoUrl(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const rec = output as Record<string, unknown>;

  for (const key of [
    "video_url",
    "videoUrl",
    "url",
    "result_url",
    "resultUrl",
    "mp4_url",
    "mp4Url",
  ]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  for (const nested of [rec.output, rec.result, rec.data]) {
    const found = _extractVideoUrl(nested);
    if (found) return found;
  }

  return null;
}
