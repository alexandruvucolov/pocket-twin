/**
 * create-serverless.ts
 *
 * Client for Pocket Twin AI generation endpoints.
 * Handles: text_to_image | image_to_image | text_to_video | image_to_video
 *
 * All four tasks are routed to fal.ai (EXPO_PUBLIC_FAL_API_KEY required).
 * Modal is only used for lipsync — see modal-lipsync.ts.
 */
import { isFalConfigured, runFalImageToVideo, runFalTextToVideo } from "./fal-video";
import { runFalImageEdit, runFalTextToImage } from "./fal-image-edit";

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
  duration: "5s" | "10s" | "15s";
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
  duration: "5s" | "10s";
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

export function isCreateConfigured(): boolean {
  return isFalConfigured();
}

// No-op warmup — fal.ai is serverless and doesn't need pre-warming
export async function warmupCreateWorker(): Promise<void> {}

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

  // ── text_to_image → fal.ai GPT Image 2 (when API key is configured) ────────
  if (input.task === "text_to_image" && isFalConfigured()) {
    const t2iInput = input as TextToImageInput;
    try {
      const url = await runFalTextToImage(
        { prompt: t2iInput.prompt },
        (pct) => onStatus({ phase: pct < 100 ? "running" : "done", progress: pct }),
        signal,
      );
      onStatus({ phase: "done", progress: 100, url });
      return url;
    } catch (e: any) {
      onStatus({ phase: "error", error: e.message });
      throw e;
    }
  }

  // ── image_to_image → fal.ai GPT Image 2 Edit (when API key is configured) ─
  if (input.task === "image_to_image" && isFalConfigured()) {
    const i2iInput = input as ImageToImageInput;
    try {
      const url = await runFalImageEdit(
        {
          imageBase64: i2iInput.image,
          prompt: i2iInput.prompt,
        },
        (pct) => onStatus({ phase: pct < 100 ? "running" : "done", progress: pct }),
        signal,
      );
      onStatus({ phase: "done", progress: 100, url });
      return url;
    } catch (e: any) {
      onStatus({ phase: "error", error: e.message });
      throw e;
    }
  }

  // ── text_to_video → fal.ai PixVerse C1 ─────────────────────────────────────
  if (input.task === "text_to_video" && isFalConfigured()) {
    const t2vInput = input as TextToVideoInput;
    try {
      const url = await runFalTextToVideo(
        {
          prompt: t2vInput.prompt,
          duration: t2vInput.duration,
          width: t2vInput.width,
          height: t2vInput.height,
        },
        (pct) => onStatus({ phase: pct < 100 ? "running" : "done", progress: pct }),
        signal,
      );
      onStatus({ phase: "done", progress: 100, url });
      return url;
    } catch (e: any) {
      onStatus({ phase: "error", error: e.message });
      throw e;
    }
  }

  // ── image_to_video → fal.ai (when API key is configured) ─────────────────
  if (input.task === "image_to_video" && isFalConfigured()) {
    const i2vInput = input as ImageToVideoInput;
    try {
      const url = await runFalImageToVideo(
        {
          imageBase64: i2vInput.image,
          prompt: i2vInput.prompt,
          duration: i2vInput.duration,
          width: i2vInput.width,
          height: i2vInput.height,
        },
        (pct) => onStatus({ phase: pct < 100 ? "running" : "done", progress: pct }),
        signal,
      );
      onStatus({ phase: "done", progress: 100, url });
      return url;
    } catch (e: any) {
      onStatus({ phase: "error", error: e.message });
      throw e;
    }
  }

  // All tasks are handled by fal.ai above — this point is unreachable when
  // fal.ai is configured. Throw a clear error if somehow reached.
  throw new Error(`No handler for task "${input.task}" — set EXPO_PUBLIC_FAL_API_KEY.`);
}
