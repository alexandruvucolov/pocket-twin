/**
 * create-serverless.ts
 *
 * Client for the Pocket Twin WAN 2.1 + FLUX Modal serverless endpoint.
 * Handles: text_to_image | text_to_video | image_to_video
 *
 * Required env var:
 *   EXPO_PUBLIC_MODAL_CREATE_URL   ← the web_endpoint URL from `modal deploy`
 *                                     e.g. https://pocket-twin-create--pocket-twin-create.modal.run
 */

// Two separate Modal endpoints — cheap A10G for images, H100 for video
const REQUEST_TIMEOUT_MS = 900_000; // 15 min (WAN 30s video can be slow)

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateTask = "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video";

export interface CreateJobStatus {
  phase: "queued" | "running" | "done" | "error";
  progress?: number; // 0–100, approximate
  url?: string;
  error?: string;
}

export interface TextToImageInput {
  task: "text_to_image";
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  num_inference_steps?: number;
  seed?: number;
  style?: string;
}

export interface ImageToImageInput {
  task: "image_to_image";
  prompt: string;
  image: string; // base64-encoded reference image
  negative_prompt?: string;
  width?: number;
  height?: number;
  num_inference_steps?: number;
  strength?: number; // 0–1, how much to modify the image (default 0.75)
  seed?: number;
}

export interface TextToVideoInput {
  task: "text_to_video";
  prompt: string;
  negative_prompt?: string;
  duration: "6s" | "10s";
  width?: number;
  height?: number;
  num_inference_steps?: number;
  seed?: number;
}

export interface ImageToVideoInput {
  task: "image_to_video";
  prompt: string;
  negative_prompt?: string;
  image: string; // base64-encoded image
  duration: "6s" | "10s";
  width?: number;
  height?: number;
  num_inference_steps?: number;
  seed?: number;
}

export type CreateInput =
  | TextToImageInput
  | ImageToImageInput
  | TextToVideoInput
  | ImageToVideoInput;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function imageUrl(): string {
  const v = (process.env.EXPO_PUBLIC_MODAL_IMAGE_URL ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_MODAL_IMAGE_URL is not set.");
  return v;
}

function videoUrl(): string {
  const v = (process.env.EXPO_PUBLIC_MODAL_VIDEO_URL ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_MODAL_VIDEO_URL is not set.");
  return v;
}

function endpointUrl(task: CreateTask): string {
  return task === "text_to_image" || task === "image_to_image"
    ? imageUrl()
    : videoUrl();
}

export function isCreateConfigured(): boolean {
  return (
    Boolean((process.env.EXPO_PUBLIC_MODAL_IMAGE_URL ?? "").trim()) &&
    Boolean((process.env.EXPO_PUBLIC_MODAL_VIDEO_URL ?? "").trim())
  );
}

// ─── Warmup ──────────────────────────────────────────────────────────────────

export async function warmupCreateWorker(): Promise<void> {
  if (!isCreateConfigured()) return;
  try {
    // Only warm the image endpoint (A10G) — video (H100) is too expensive to pre-warm
    await fetch(imageUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "warmup" }),
    });
  } catch (_) {
    // best-effort
  }
}

// ─── Main: run job with progress callback ────────────────────────────────────

/**
 * Submit a create job to Modal and wait for the result.
 * Calls `onStatus` with simulated progress while the request is in-flight.
 */
export async function runCreateJob(
  input: CreateInput,
  onStatus: (status: CreateJobStatus) => void,
  signal?: AbortSignal,
): Promise<string> {
  onStatus({ phase: "queued", progress: 5 });

  // Simulate progress while Modal processes the request
  let fakeProgress = 5;
  const progressTimer = setInterval(() => {
    fakeProgress = Math.min(fakeProgress + 2, 90);
    onStatus({ phase: "running", progress: fakeProgress });
  }, 3000);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = signal
      ? combineSignals(signal, controller.signal)
      : controller.signal;

    onStatus({ phase: "running", progress: 10 });

    const res = await fetch(endpointUrl(input.task), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: combinedSignal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Modal endpoint error ${res.status}: ${text}`);
    }

    const data = await res.json();

    if (data.error) {
      onStatus({ phase: "error", error: data.error });
      throw new Error(data.error);
    }

    // Images are returned as base64 to avoid Firebase Storage costs
    if (data.base64) {
      const dataUri = `data:image/png;base64,${data.base64}`;
      onStatus({ phase: "done", progress: 100, url: dataUri });
      return dataUri;
    }

    const url: string = data.url;
    if (!url) throw new Error("Modal returned no output URL");

    onStatus({ phase: "done", progress: 100, url });
    return url;
  } finally {
    clearInterval(progressTimer);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
