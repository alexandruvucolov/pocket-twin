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

const FAL_STORAGE_INITIATE =
  "https://rest.alpha.fal.ai/storage/upload/initiate";
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
  /** On-device file URI from the image picker — used by manipulateAsync directly. */
  imageUri?: string;
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
 * Crop + compress an image to the target aspect ratio for Kling I2V.
 * Accepts a file URI (preferred — no temp file needed) or falls back to base64.
 * Kling has no aspect_ratio param — output orientation = input image dimensions.
 *
 * Pass 1: resize to MAX_IMAGE_DIMENSION on the appropriate axis.
 *   Portrait (9:16) → resize by height so a landscape source is wide enough to crop.
 * Pass 2: center-crop to the exact target ratio, then compress to JPEG.
 */
async function compressImage(
  imageUri: string,
  targetAspectRatio?: "9:16" | "16:9" | "1:1",
): Promise<string> {
  try {
    const { manipulateAsync, SaveFormat } =
      await import("expo-image-manipulator");

    // Pass 1: resize — portrait target needs height-based resize
    const resizeByHeight = targetAspectRatio === "9:16";
    const resizeAction = resizeByHeight
      ? { resize: { height: MAX_IMAGE_DIMENSION } }
      : { resize: { width: MAX_IMAGE_DIMENSION } };

    const step1 = await manipulateAsync(imageUri, [resizeAction], {
      format: SaveFormat.JPEG,
    });
    const s1W = step1.width;
    const s1H = step1.height;

    // Pass 2: center-crop to target ratio (if needed), then compress
    let cropActions: Parameters<typeof manipulateAsync>[1] = [];
    if (targetAspectRatio) {
      const [arW, arH] = targetAspectRatio.split(":").map(Number);
      const targetRatio = arW / arH;
      const s1Ratio = s1W / s1H;
      if (Math.abs(s1Ratio - targetRatio) > 0.02) {
        let cropW: number, cropH: number;
        if (s1Ratio > targetRatio) {
          // too wide → crop left/right
          cropH = s1H;
          cropW = Math.round(s1H * targetRatio);
        } else {
          // too tall → crop top/bottom
          cropW = s1W;
          cropH = Math.round(s1W / targetRatio);
        }
        cropActions = [
          {
            crop: {
              originX: Math.round((s1W - cropW) / 2),
              originY: Math.round((s1H - cropH) / 2),
              width: cropW,
              height: cropH,
            },
          },
        ];
      }
    }

    const result = await manipulateAsync(step1.uri, cropActions, {
      compress: 0.85,
      format: SaveFormat.JPEG,
      base64: true,
    });

    return result.base64 ?? "";
  } catch (e) {
    console.error("[compressImage] failed:", e);
    return ""; // caller falls back to raw base64
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

  // Internal 60s timeout so a stalled connection can't hang forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const internalSignal = controller.signal;

  try {
    // Step 1: initiate upload
    const initiateRes = await fetch(FAL_STORAGE_INITIATE, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_type: mimeType, file_name: `image.${ext}` }),
      signal: internalSignal,
    });
    if (!initiateRes.ok) {
      const text = await initiateRes.text();
      throw new Error(
        `fal.ai storage initiate failed ${initiateRes.status}: ${text}`,
      );
    }
    const { upload_url, file_url } = await initiateRes.json();

    // Step 2: PUT binary data to the presigned URL
    const bytes = base64ToBytes(imageBase64);
    const uploadRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: bytes,
      signal: internalSignal,
    });
    if (!uploadRes.ok) {
      throw new Error(`fal.ai storage upload failed ${uploadRes.status}`);
    }

    return file_url as string;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
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

  // 1. Crop + compress image to target aspect ratio before upload
  // Kling I2V derives output orientation from the input image — must crop first.
  onProgress(3);
  const aspectRatio = (() => {
    const w = input.width ?? 576;
    const h = input.height ?? 1024;
    return w > h
      ? ("16:9" as const)
      : w === h
        ? ("1:1" as const)
        : ("9:16" as const);
  })();
  // Use the on-device URI from the picker when available — avoids writing a temp file
  const sourceUri = input.imageUri;
  const compressedBase64 = sourceUri
    ? (await compressImage(sourceUri, aspectRatio)) || input.imageBase64
    : input.imageBase64;

  // 2. Upload image to fal storage
  onProgress(5);
  const imageUrl = await uploadImageToFal(
    compressedBase64,
    "image/jpeg",
    signal,
  );
  onProgress(15);

  const duration = input.duration === "10s" ? "10" : "5"; // Kling uses numeric strings

  // 3. Build payload — Kling I2V has no aspect_ratio param; output ratio = input image ratio
  const payload: Record<string, unknown> = {
    image_url: imageUrl,
    prompt: input.prompt,
    duration,
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
    throw new Error(
      `fal.ai submit returned no request_id: ${JSON.stringify(submitData)}`,
    );
  }
  onProgress(20);

  // 5. Poll for completion using status_url from response (avoids URL construction issues)
  const pollUrl =
    status_url ?? `${FAL_QUEUE_BASE}/${model}/requests/${request_id}/status`;
  const resultUrl =
    response_url ??
    `${FAL_QUEUE_BASE}/${model}/requests/${request_id}/response`;

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
          throw new Error(
            `fal.ai status polling failed ${statusRes.status} (${consecutiveErrors}x in a row)`,
          );
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
      const errMsg =
        statusData.error ?? `fal.ai job failed (request_id=${request_id})`;
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
  const duration =
    input.duration === "15s" ? 15 : input.duration === "10s" ? 10 : 5; // PixVerse C1 uses integer, not string

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
    throw new Error(
      `fal.ai submit returned no request_id: ${JSON.stringify(submitData)}`,
    );
  }
  onProgress(20);

  const pollUrl =
    status_url ??
    `${FAL_QUEUE_BASE}/${FAL_T2V_MODEL}/requests/${request_id}/status`;
  const resultUrl =
    response_url ??
    `${FAL_QUEUE_BASE}/${FAL_T2V_MODEL}/requests/${request_id}/response`;
  // PixVerse C1 result shape: { video: { url } } — same as the existing fallback chain

  const startMs = Date.now();
  let consecutiveErrors = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Cancelled");
    if (Date.now() - startMs > T2V_MAX_POLL_MS)
      throw new Error("fal.ai timed out after 10 minutes");

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
        if (consecutiveErrors >= 5)
          throw new Error(
            `fal.ai polling failed ${statusRes.status} (${consecutiveErrors}x)`,
          );
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
    if (status === "FAILED")
      throw new Error(
        statusData.error ?? `fal.ai t2v failed (request_id=${request_id})`,
      );

    const elapsed = Math.min((Date.now() - startMs) / T2V_MAX_POLL_MS, 1);
    onProgress(
      status === "IN_PROGRESS"
        ? Math.round(30 + elapsed * 60)
        : Math.round(20 + elapsed * 10),
    );
  }

  const resultRes = await fetch(resultUrl, {
    headers: { Authorization: `Key ${apiKey}` },
    signal,
  });
  if (!resultRes.ok)
    throw new Error(`fal.ai result fetch failed ${resultRes.status}`);
  const result = await resultRes.json();

  const videoUrl: string =
    result?.video?.url ??
    result?.video_url ??
    result?.output?.video?.url ??
    result?.outputs?.[0]?.url;

  if (!videoUrl)
    throw new Error(
      `fal.ai t2v returned no video URL: ${JSON.stringify(result)}`,
    );

  onProgress(100);
  return videoUrl;
}
