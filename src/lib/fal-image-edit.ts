/**
 * fal-image-edit.ts
 *
 * Client for fal.ai GPT Image 2 Edit (openai/gpt-image-2/edit).
 * Uses the same queue REST API pattern as fal-video.ts — no SDK needed.
 *
 * Required env var:
 *   EXPO_PUBLIC_FAL_API_KEY  ← your fal.ai API key
 */

const FAL_STORAGE_INITIATE =
  "https://rest.alpha.fal.ai/storage/upload/initiate";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_EDIT_MODEL = "openai/gpt-image-2/edit";

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_MS = 300_000; // 5 min

export interface FalImageEditInput {
  /** Pure base64 string (no data URI prefix). */
  imageBase64: string;
  prompt: string;
  quality?: "low" | "medium" | "high";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function falApiKey(): string {
  const v = (process.env.EXPO_PUBLIC_FAL_API_KEY ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_FAL_API_KEY is not set.");
  return v;
}

/** Decode a base64 string to a Uint8Array (works in React Native / Hermes). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Resize the image to at most 1024px on its longest side and compress to JPEG.
 * Writes to a temp cache file first (manipulateAsync requires a real file URI).
 * Falls back to the original base64 on any error.
 */
async function compressImage(base64: string): Promise<string> {
  try {
    const FileSystem = await import("expo-file-system");
    const { manipulateAsync, SaveFormat } =
      await import("expo-image-manipulator");

    const tmpUri = `${FileSystem.cacheDirectory}fal_edit_tmp.jpg`;
    await FileSystem.writeAsStringAsync(tmpUri, base64, { encoding: "base64" });

    const result = await manipulateAsync(tmpUri, [{ resize: { width: 768 } }], {
      compress: 0.85,
      format: SaveFormat.JPEG,
      base64: true,
    });

    FileSystem.deleteAsync(tmpUri, { idempotent: true }).catch(() => {});
    return result.base64 ?? base64;
  } catch {
    return base64;
  }
}

/**
 * Upload a base64 JPEG to fal.ai storage and return a public URL.
 */
async function uploadToFal(
  imageBase64: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();

  const initiateRes = await fetch(FAL_STORAGE_INITIATE, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content_type: "image/jpeg",
      file_name: "image.jpg",
    }),
    signal,
  });
  if (!initiateRes.ok) {
    const text = await initiateRes.text();
    throw new Error(
      `fal.ai storage initiate failed ${initiateRes.status}: ${text}`,
    );
  }
  const { upload_url, file_url } = await initiateRes.json();

  const bytes = base64ToBytes(imageBase64);
  const uploadRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
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
 * Edit an image using GPT Image 2 on fal.ai.
 * Compresses the image, uploads it, submits the edit job, polls until done,
 * and returns the edited image URL.
 *
 * Calls `onProgress(0–100)` throughout.
 */
export async function runFalImageEdit(
  input: FalImageEditInput,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();

  // 1. Compress image
  onProgress(3);
  const compressedBase64 = await compressImage(input.imageBase64);

  // 2. Upload to fal storage
  onProgress(5);
  const imageUrl = await uploadToFal(compressedBase64, signal);
  onProgress(15);

  // 3. Submit edit job
  const payload = {
    prompt: input.prompt,
    image_urls: [imageUrl],
    image_size: "portrait_16_9",
    quality: input.quality ?? "low",
    output_format: "jpeg",
    num_images: 1,
  };

  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${FAL_EDIT_MODEL}`, {
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
  const { status_url, response_url } = submitData;
  if (!status_url || !response_url) {
    throw new Error(
      `fal.ai submit missing URLs: ${JSON.stringify(submitData)}`,
    );
  }
  onProgress(20);

  // 4. Poll for completion
  const deadline = Date.now() + MAX_POLL_MS;
  let pollProgress = 20;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetch(status_url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal,
    });
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const status: string = statusData.status ?? "";

    if (status === "COMPLETED") {
      onProgress(95);
      break;
    }
    if (status === "FAILED") {
      throw new Error(
        `fal.ai image edit failed: ${JSON.stringify(statusData)}`,
      );
    }

    pollProgress = Math.min(pollProgress + 5, 90);
    onProgress(pollProgress);
  }

  if (Date.now() >= deadline) throw new Error("fal.ai image edit timed out");

  // 5. Fetch result
  const resultRes = await fetch(response_url, {
    headers: { Authorization: `Key ${apiKey}` },
    signal,
  });
  if (!resultRes.ok) {
    throw new Error(`fal.ai result fetch failed ${resultRes.status}`);
  }
  const result = await resultRes.json();

  const url: string | undefined =
    result?.images?.[0]?.url ??
    result?.image?.url ??
    result?.output?.images?.[0]?.url;

  if (!url)
    throw new Error(
      `fal.ai image edit: no URL in result: ${JSON.stringify(result)}`,
    );

  onProgress(100);
  return url;
}

// ─── Text-to-image ────────────────────────────────────────────────────────────

const FAL_T2I_MODEL = "fal-ai/gpt-image-2";

export interface FalTextToImageInput {
  prompt: string;
  quality?: "low" | "medium" | "high";
}

/**
 * Generate an image from text using GPT Image 2 on fal.ai.
 * Same quality/size settings as image editing: quality "low", portrait_16_9.
 */
export async function runFalTextToImage(
  input: FalTextToImageInput,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = falApiKey();
  onProgress(5);

  const payload = {
    prompt: input.prompt,
    image_size: "portrait_16_9",
    quality: input.quality ?? "low",
    output_format: "jpeg",
    num_images: 1,
  };

  const submitRes = await fetch(`${FAL_QUEUE_BASE}/${FAL_T2I_MODEL}`, {
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
  const { status_url, response_url } = submitData;
  if (!status_url || !response_url) {
    throw new Error(
      `fal.ai submit missing URLs: ${JSON.stringify(submitData)}`,
    );
  }
  onProgress(20);

  const deadline = Date.now() + MAX_POLL_MS;
  let pollProgress = 20;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetch(status_url, {
      headers: { Authorization: `Key ${apiKey}` },
      signal,
    });
    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const status: string = statusData.status ?? "";

    if (status === "COMPLETED") {
      onProgress(95);
      break;
    }
    if (status === "FAILED") {
      throw new Error(
        `fal.ai text-to-image failed: ${JSON.stringify(statusData)}`,
      );
    }

    pollProgress = Math.min(pollProgress + 5, 90);
    onProgress(pollProgress);
  }

  if (Date.now() >= deadline) throw new Error("fal.ai text-to-image timed out");

  const resultRes = await fetch(response_url, {
    headers: { Authorization: `Key ${apiKey}` },
    signal,
  });
  if (!resultRes.ok) {
    throw new Error(`fal.ai result fetch failed ${resultRes.status}`);
  }
  const result = await resultRes.json();

  const url: string | undefined =
    result?.images?.[0]?.url ??
    result?.image?.url ??
    result?.output?.images?.[0]?.url;

  if (!url)
    throw new Error(
      `fal.ai text-to-image: no URL in result: ${JSON.stringify(result)}`,
    );

  onProgress(100);
  return url;
}
