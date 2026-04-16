/**
 * create-serverless.ts
 *
 * Client for the Pocket Twin WAN 2.1 + FLUX RunPod serverless endpoint.
 * Handles: text_to_image | text_to_video | image_to_video
 *
 * Required env vars:
 *   EXPO_PUBLIC_RUNPOD_API_KEY
 *   EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID   ← w8h6kiymam2pcf
 */

const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 300; // 10 min max

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateTask = "text_to_image" | "text_to_video" | "image_to_video";

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

export interface TextToVideoInput {
  task: "text_to_video";
  prompt: string;
  negative_prompt?: string;
  duration: "6s" | "15s" | "30s";
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
  duration: "6s" | "15s" | "30s";
  width?: number;
  height?: number;
  num_inference_steps?: number;
  seed?: number;
}

export type CreateInput =
  | TextToImageInput
  | TextToVideoInput
  | ImageToVideoInput;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function apiKey(): string {
  const v = (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_RUNPOD_API_KEY is not set.");
  return v;
}

function endpointId(): string {
  const v = (process.env.EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID ?? "").trim();
  if (!v) throw new Error("EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID is not set.");
  return v;
}

function baseUrl(): string {
  return `${RUNPOD_BASE_URL}/${endpointId()}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    "Content-Type": "application/json",
  };
}

export function isCreateConfigured(): boolean {
  return Boolean(
    (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim() &&
    (process.env.EXPO_PUBLIC_RUNPOD_CREATE_ENDPOINT_ID ?? "").trim(),
  );
}

// ─── Warmup ──────────────────────────────────────────────────────────────────

export async function warmupCreateWorker(): Promise<void> {
  if (!isCreateConfigured()) return;
  try {
    await fetch(`${baseUrl()}/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ input: { warmup: true } }),
    });
  } catch (_) {
    // best-effort
  }
}

// ─── Submit job ──────────────────────────────────────────────────────────────

async function submitJob(input: CreateInput): Promise<string> {
  const res = await fetch(`${baseUrl()}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RunPod submit failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data.id) throw new Error("No job ID returned from RunPod");
  return data.id as string;
}

// ─── Poll status ─────────────────────────────────────────────────────────────

async function pollStatus(jobId: string): Promise<{
  status: string;
  output?: { url?: string; error?: string };
  error?: string;
}> {
  const res = await fetch(`${baseUrl()}/status/${jobId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`RunPod poll failed ${res.status}`);
  return await res.json();
}

// ─── Main: run job with progress callback ────────────────────────────────────

/**
 * Submit a create job and poll until done.
 * Calls `onStatus` with progress updates so the UI can react.
 */
export async function runCreateJob(
  input: CreateInput,
  onStatus: (status: CreateJobStatus) => void,
  signal?: AbortSignal,
): Promise<string> {
  onStatus({ phase: "queued", progress: 0 });

  const jobId = await submitJob(input);

  let attempt = 0;

  while (attempt < MAX_POLL_ATTEMPTS) {
    if (signal?.aborted) throw new Error("Cancelled");

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    attempt++;

    const data = await pollStatus(jobId);
    const s = data.status;

    if (s === "IN_QUEUE") {
      onStatus({ phase: "queued", progress: 5 });
    } else if (s === "IN_PROGRESS") {
      // Fake linear progress while running (real progress not exposed by RunPod)
      const fakeProgress = Math.min(10 + attempt * 2, 90);
      onStatus({ phase: "running", progress: fakeProgress });
    } else if (s === "COMPLETED") {
      const url = data.output?.url;
      if (!url) throw new Error("Job completed but no output URL");
      onStatus({ phase: "done", progress: 100, url });
      return url;
    } else if (s === "FAILED" || s === "CANCELLED") {
      const err = data.output?.error ?? data.error ?? "Job failed on RunPod";
      onStatus({ phase: "error", error: err });
      throw new Error(err);
    }
  }

  throw new Error("Timed out waiting for create job");
}
