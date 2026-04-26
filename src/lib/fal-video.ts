/**
 * fal-video.ts
 *
 * Client for fal.ai video generation.
 * Uses the fal.ai queue REST API — no extra SDK needed.
 *
 * Text-to-video : PixVerse C1  (fal-ai/pixverse/c1/text-to-video)
 * Image-to-video: Kling 1.6 Standard
 *
 * Required env var:
 *   EXPO_PUBLIC_FAL_API_KEY  ← your fal.ai API key
 */

const FAL_STORAGE_INITIATE = "https://rest.alpha.fal.ai/storage/upload/initiate";
const FAL_QUEUE_BASE = "https://queue.fal.run";

const POLL_INTERVAL_MS = 2_500;
const MAX_POLL_MS = 240_000; // 4 min

// Max dimension sent to fal.ai — larger images don't improve quality but slow
// upload significantly (a 24 MB phone photo → ~300 KB after resize)
const MAX_IMAGE_DIMENSION = 1024;

export type FalI2VModel = "fal-ai/kling-video/v1.6/standard/image-to-video";

export const FAL_DEFAULT_MODEL: FalI2VModel =
  "fal-ai/kling-video/v1.6/standard/image-to-video";

export interface FalI2VInput {
  /** Pure base64 string (no data URI prefix). */
  imageBase64: string;
  prompt: string;
  duration?: "5s" | "10s";
  width?: number;
  height?: number;
  model?: FalI2VModel;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function falApiKey(): string {
  const v = (process.env.EXPO_PUBLIC_FAL_API_KEY ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_FAL_API_KEY is not set.");
  return v;
}

export function isFalConfigured(): boolean {
  return Boolean((process.env.EXPO_PUBLIC_FAL_API_KEY ?? "").trim());
}

/** Decode a base64 string to a Uint8Array (works in React Native). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Resize + compress a base64 image so it's at most MAX_IMAGE_DIMENSION on its
 * longest side at JPEG quality 0.85. Returns the compressed base64 string.
 * Falls back to the original if expo-image-manipulator is unavailable.
 */
async function compressImage(base64: string): Promise<string> {
  try {
    const { manipulateAsync, SaveFormat } = await import("expo-image-manipulator");
    const FileSystem = await import("expo-file-system");

    // manipulateAsync requires a real file URI — data: URIs cause a hard crash
    const tmpUri = `${FileSystem.cacheDirectory}fal_upload_tmp.jpg`;
    await FileSystem.writeAsStringAsync(tmpUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const result = await manipulateAsync(
      tmpUri,
      [{ resize: { width: MAX_IMAGE_DIMENSION } }],
      { compress: 0.85, format: SaveFormat.JPEG, base64: true },
    );

    // Clean up temp file (best-effort)
    FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});

    return result.base64 ?? base64;
  } catch {
    return base64; // fallback — upload original
  }
}

/**
 * Upload a base64 image to fal.ai storage and return a public URL.
 * Two-step: initiate → get presigned PUT URL → upload binary → return file_url.
 */
async function uploadImageToFal(
  imageBase64: string,
  mimeType = "image/jpeg",
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();
  const ext = mimeType === "image/png" ? "png" : "jpg";

  // Step 1: initiate upload
  const initiateRes = await fetch(FAL_STORAGE_INITIATE, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content_type: mimeType, file_name: `image.${ext}` }),
    signal,
  });
  if (!initiateRes.ok) {
    const text = await initiateRes.text();
    throw new Error(`fal.ai storage initiate failed ${initiateRes.status}: ${text}`);
  }
  const { upload_url, file_url } = await initiateRes.json();

  // Step 2: PUT binary data to the presigned URL
  const bytes = base64ToBytes(imageBase64);
  const uploadRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
    signal,
  });
  if (!uploadRes.ok) {
    throw new Error(`fal.ai storage upload failed ${uploadRes.status}`);
  }

  return file_url as string;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run image-to-video on fal.ai.
 * Uploads the image, submits the job, polls until complete, returns video URL.
 * Calls `onProgress(0–100)` throughout.
 */
export async function runFalImageToVideo(
  input: FalI2VInput,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();
  const model = input.model ?? FAL_DEFAULT_MODEL;

  // 1. Compress + resize image before upload (24 MB → ~300 KB)
  onProgress(3);
  const compressedBase64 = await compressImage(input.imageBase64);

  // 2. Upload image to fal storage
  onProgress(5);
  const imageUrl = await uploadImageToFal(compressedBase64, "image/jpeg", signal);
  onProgress(15);

  // 2. Determine aspect ratio from width/height
  const w = input.width ?? 576;
  const h = input.height ?? 1024;
  const aspectRatio = w > h ? "16:9" : w === h ? "1:1" : "9:16";
  const duration = input.duration === "10s" ? "10" : "5"; // Kling uses numeric strings

  // 3. Build payload
  const payload: Record<string, unknown> = {
    image_url: imageUrl,
    prompt: input.prompt,
    duration,
    aspect_ratio: aspectRatio,
  };

  // 4. Submit to fal queue
  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(`fal.ai submit failed ${submitRes.status}: ${text}`);
  }
  const submitData = await submitRes.json();
  const { request_id, status_url, response_url } = submitData;
  if (!request_id) {
    throw new Error(`fal.ai submit returned no request_id: ${JSON.stringify(submitData)}`);
  }
  onProgress(20);

  // 5. Poll for completion using status_url from response (avoids URL construction issues)
  const pollUrl = status_url ?? `${FAL_QUEUE_BASE}/${model}/requests/${request_id}/status`;
  const resultUrl = response_url ?? `${FAL_QUEUE_BASE}/${model}/requests/${request_id}/response`;

  const startMs = Date.now();
  let consecutiveErrors = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (Date.now() - startMs > MAX_POLL_MS) {
      throw new Error("fal.ai timed out after 4 minutes");
    }

    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new Error("Cancelled");

    let statusData: any;
    try {
      const statusRes = await fetch(pollUrl, {
        headers: { Authorization: `Key ${apiKey}` },
        signal,
      });
      if (!statusRes.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          throw new Error(`fal.ai status polling failed ${statusRes.status} (${consecutiveErrors}x in a row)`);
        }
        continue;
      }
      consecutiveErrors = 0;
      statusData = await statusRes.json();
    } catch (e: any) {
      if (e.message === "Cancelled") throw e;
      consecutiveErrors++;
      if (consecutiveErrors >= 5) throw e;
      continue;
    }

    const { status } = statusData;

    if (status === "COMPLETED") {
      onProgress(95);
      break;
    }
    if (status === "FAILED") {
      const errMsg = statusData.error ?? `fal.ai job failed (request_id=${request_id})`;
      throw new Error(errMsg);
    }

    // Smooth progress:
    // IN_QUEUE: 20 → 30 (slowly, so user knows it's working)
    // IN_PROGRESS: 30 → 90
    const elapsed = Math.min((Date.now() - startMs) / MAX_POLL_MS, 1);
    if (status === "IN_PROGRESS") {
      onProgress(Math.round(30 + elapsed * 60));
    } else {
      // IN_QUEUE — slowly nudge forward so it doesn't look frozen
      onProgress(Math.round(20 + elapsed * 10));
    }
  }

  // 6. Fetch result using response_url from submit response
  const resultRes = await fetch(resultUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal,
  });
  if (!resultRes.ok) {
    throw new Error(`fal.ai result fetch failed ${resultRes.status}`);
  }
  const result = await resultRes.json();

  // Different models return the video URL under different keys
  const videoUrl: string =
    result?.video?.url ??
    result?.video_url ??
    result?.output?.video?.url ??
    result?.outputs?.[0]?.url;

  if (!videoUrl) {
    throw new Error(`fal.ai returned no video URL: ${JSON.stringify(result)}`);
  }

  onProgress(100);
  return videoUrl;
}

// ─── Text-to-video ────────────────────────────────────────────────────────────

const FAL_T2V_MODEL = "fal-ai/pixverse/c1/text-to-video";

export interface FalT2VInput {
  prompt: string;
  duration?: "5s" | "10s" | "15s";
  width?: number;
  height?: number;
}

/**
 * Run text-to-video on fal.ai using Kling 1.6 Standard.
 * Same duration / aspect-ratio logic as image-to-video.
 */
export async function runFalTextToVideo(
  input: FalT2VInput,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();
  const T2V_MAX_POLL_MS = 600_000; // 10 min — PixVerse C1 t2v, keep generous

  const w = input.width ?? 576;
  const h = input.height ?? 1024;
  const aspectRatio = w > h ? "16:9" : w === h ? "1:1" : "9:16";
  const duration = input.duration === "15s" ? 15 : input.duration === "10s" ? 10 : 5; // PixVerse C1 uses integer, not string

  onProgress(5);

  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${FAL_T2V_MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      duration,
      aspect_ratio: aspectRatio,
      resolution: "720p",
    }),
    signal,
  });
  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(`fal.ai submit failed ${submitRes.status}: ${text}`);
  }
  const submitData = await submitRes.json();
  const { request_id, status_url, response_url } = submitData;
  if (!request_id) {
    throw new Error(`fal.ai submit returned no request_id: ${JSON.stringify(submitData)}`);
  }
  onProgress(20);

  const pollUrl = status_url ?? `${FAL_QUEUE_BASE}/${FAL_T2V_MODEL}/requests/${request_id}/status`;
  const resultUrl = response_url ?? `${FAL_QUEUE_BASE}/${FAL_T2V_MODEL}/requests/${request_id}/response`;
  // PixVerse C1 result shape: { video: { url } } — same as the existing fallback chain

  const startMs = Date.now();
  let consecutiveErrors = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (Date.now() - startMs > T2V_MAX_POLL_MS) throw new Error("fal.ai timed out after 10 minutes");

    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new Error("Cancelled");

    let statusData: any;
    try {
      const statusRes = await fetch(pollUrl, {
        headers: { Authorization: `Key ${apiKey}` },
        signal,
      });
      if (!statusRes.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) throw new Error(`fal.ai polling failed ${statusRes.status} (${consecutiveErrors}x)`);
        continue;
      }
      consecutiveErrors = 0;
      statusData = await statusRes.json();
    } catch (e: any) {
      if (e.message === "Cancelled") throw e;
      consecutiveErrors++;
      if (consecutiveErrors >= 5) throw e;
      continue;
    }

    const { status } = statusData;
    if (status === "COMPLETED") { onProgress(95); break; }
    if (status === "FAILED") throw new Error(statusData.error ?? `fal.ai t2v failed (request_id=${request_id})`);

    const elapsed = Math.min((Date.now() - startMs) / T2V_MAX_POLL_MS, 1);
    onProgress(status === "IN_PROGRESS" ? Math.round(30 + elapsed * 60) : Math.round(20 + elapsed * 10));
  }

  const resultRes = await fetch(resultUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal,
  });
  if (!resultRes.ok) throw new Error(`fal.ai result fetch failed ${resultRes.status}`);
  const result = await resultRes.json();

  const videoUrl: string =
    result?.video?.url ??
    result?.video_url ??
    result?.output?.video?.url ??
    result?.outputs?.[0]?.url;

  if (!videoUrl) throw new Error(`fal.ai t2v returned no video URL: ${JSON.stringify(result)}`);

  onProgress(100);
  return videoUrl;
}
