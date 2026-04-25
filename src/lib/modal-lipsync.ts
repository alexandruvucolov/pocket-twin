/**
 * modal-lipsync.ts
 *
 * Client for the Modal LatentSync lip-sync endpoint (create_lipsync).
 *
 * Required env var:
 *   EXPO_PUBLIC_MODAL_LIPSYNC_URL  – full URL of the pocket-twin-lipsync endpoint
 *                                    e.g. https://alexandru-vucolov--pocket-twin-lipsync.modal.run
 *
 * Exposes the same function signatures as the old latentsync-serverless.ts so
 * chat/[id].tsx only needs an import path change — no logic changes.
 *
 * Unlike the RunPod client (submit → poll loop), Modal endpoints are
 * synchronous HTTP: one POST that blocks until the video is ready.
 * We fake the submit/poll interface by kicking off the fetch immediately
 * on submit() and resolving it inside poll().
 */

const MODAL_LIPSYNC_URL = (
  process.env.EXPO_PUBLIC_MODAL_LIPSYNC_URL ?? ""
).trim();

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

export function isLatentSyncServerlessConfigured(): boolean {
  return Boolean(MODAL_LIPSYNC_URL);
}

/**
 * Fire a lightweight warmup POST to prevent the A10G from going cold.
 * Call this when the chat screen mounts. Safe to ignore errors.
 */
export async function warmupLatentSyncWorker(): Promise<void> {
  if (!isLatentSyncServerlessConfigured()) return;
  try {
    await fetch(MODAL_LIPSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "warmup" }),
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export interface LatentSyncJobInput {
  /** Public URL of the avatar image (preferred — avoids base64 overhead). */
  sourceImageUrl?: string;
  /** Base64-encoded image (fallback for local file URIs). */
  sourceImageBase64?: string;
  sourceImageMimeType?: string;
  /** Base64-encoded MP3/WAV audio from ElevenLabs. */
  audioBase64: string;
  /** Diffusion steps (default 10). Higher = better quality, slower. */
  numInferenceSteps?: number;
  /** BBox vertical shift in pixels (default 0). */
  bboxShift?: number;
}

// ---------------------------------------------------------------------------
// Pending job map — stores the in-flight Promise keyed by a fake job ID
// ---------------------------------------------------------------------------

const _pending = new Map<string, Promise<string>>();

/**
 * Start the lip-sync job immediately (non-blocking) and return a fake job ID.
 * The actual HTTP request runs in the background — call pollLatentSyncJob()
 * to await it and receive progress callbacks.
 */
export async function submitLatentSyncJob(
  params: LatentSyncJobInput,
): Promise<{ id: string }> {
  const id = Math.random().toString(36).slice(2, 10);
  _pending.set(id, _runJob(params));
  return { id };
}

async function _runJob(params: LatentSyncJobInput): Promise<string> {
  if (!MODAL_LIPSYNC_URL) throw new Error("EXPO_PUBLIC_MODAL_LIPSYNC_URL is not set.");

  const controller = new AbortController();
  // 5-minute hard timeout — LatentSync on A10G typically finishes in 15-60s
  const timeoutId = setTimeout(() => controller.abort(), 300_000);

  try {
    const res = await fetch(MODAL_LIPSYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        task: "lip_sync",
        source_image_url: params.sourceImageUrl,
        source_image_base64: params.sourceImageBase64,
        source_image_mime_type: params.sourceImageMimeType,
        audio_base64: params.audioBase64,
        num_inference_steps: params.numInferenceSteps ?? 4,
        bbox_shift: params.bboxShift ?? 0,
      }),
    });

    const body = await res.text();
    if (!res.ok)
      throw new Error(`Modal lipsync error (${res.status}): ${body}`);

    const data = JSON.parse(body) as { url?: string; error?: string };
    if (data.error) throw new Error(`Modal lipsync failed: ${data.error}`);
    if (!data.url) throw new Error("Modal lipsync: no video URL in response");
    return data.url;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Polling (progress simulation while awaiting the synchronous Modal response)
// ---------------------------------------------------------------------------

/**
 * Await the pending lip-sync job and call onProgress(0–100) at regular intervals.
 * Progress is simulated linearly up to 90%, then jumps to 100% on completion.
 *
 * Returns the public video URL.
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
  const promise = _pending.get(jobId);
  if (!promise) throw new Error(`Unknown job ID: ${jobId}`);

  const expectedMs = options?.expectedGenerationMs ?? 30_000;
  const startTime = Date.now();
  let done = false;

  // Tick every 500 ms, simulating progress linearly up to 90%
  const timer = setInterval(() => {
    if (done) return;
    const elapsed = Date.now() - startTime;
    const pct = Math.min(90, (elapsed / expectedMs) * 90);
    onProgress(pct);
  }, 500);

  try {
    const url = await promise;
    done = true;
    clearInterval(timer);
    onProgress(100);
    _pending.delete(jobId);
    return url;
  } catch (err) {
    done = true;
    clearInterval(timer);
    _pending.delete(jobId);
    throw err;
  }
}
