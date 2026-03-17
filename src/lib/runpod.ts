const RUNPOD_BASE_URL = "https://api.runpod.ai/v2";

export type RunpodJobStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | string;

export interface RunpodJobState<TOutput = unknown> {
  id: string;
  status: RunpodJobStatus;
  output?: TOutput;
  error?: string;
  delayTime?: number;
  executionTime?: number;
}

function getRunpodApiKey(): string {
  const value = (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim();
  if (!value) {
    throw new Error("Runpod API key is missing (EXPO_PUBLIC_RUNPOD_API_KEY).");
  }
  return value;
}

function getLivePortraitEndpointId(): string {
  const value = (
    process.env.EXPO_PUBLIC_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID ?? ""
  ).trim();
  if (!value) {
    throw new Error(
      "Runpod LivePortrait endpoint id is missing (EXPO_PUBLIC_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID).",
    );
  }
  return value;
}

function getBaseUrl() {
  return (process.env.EXPO_PUBLIC_RUNPOD_BASE_URL ?? RUNPOD_BASE_URL).trim();
}

function getAuthHeaders() {
  return {
    Authorization: `Bearer ${getRunpodApiKey()}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

async function parseJsonResponse<T>(res: Response, fallbackMessage: string) {
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`${fallbackMessage} (${res.status}): ${body}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${fallbackMessage}: invalid JSON response.`);
  }
}

export function isRunpodLivePortraitConfigured(): boolean {
  return Boolean(
    (process.env.EXPO_PUBLIC_RUNPOD_API_KEY ?? "").trim() &&
    (process.env.EXPO_PUBLIC_RUNPOD_LIVEPORTRAIT_ENDPOINT_ID ?? "").trim(),
  );
}

export async function submitRunpodJob<TInput extends Record<string, unknown>>(
  input: TInput,
  options?: {
    executionTimeoutMs?: number;
    ttlMs?: number;
  },
): Promise<{ id: string; status?: RunpodJobStatus }> {
  const endpointId = getLivePortraitEndpointId();
  const res = await fetch(`${getBaseUrl()}/${endpointId}/run`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      input,
      ...(options?.executionTimeoutMs || options?.ttlMs
        ? {
            policy: {
              ...(options.executionTimeoutMs
                ? { executionTimeout: options.executionTimeoutMs }
                : {}),
              ...(options.ttlMs ? { ttl: options.ttlMs } : {}),
            },
          }
        : {}),
    }),
  });

  return parseJsonResponse<{ id: string; status?: RunpodJobStatus }>(
    res,
    "Runpod job submission failed",
  );
}

export async function getRunpodJobStatus<TOutput = unknown>(
  jobId: string,
): Promise<RunpodJobState<TOutput>> {
  const endpointId = getLivePortraitEndpointId();
  const res = await fetch(`${getBaseUrl()}/${endpointId}/status/${jobId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getRunpodApiKey()}`,
      accept: "application/json",
    },
  });

  return parseJsonResponse<RunpodJobState<TOutput>>(
    res,
    "Runpod status check failed",
  );
}

export async function waitForRunpodJob<TOutput = unknown>(
  jobId: string,
  options?: {
    maxAttempts?: number;
    pollIntervalMs?: number;
    onStatus?: (state: RunpodJobState<TOutput>, attempt: number) => void;
  },
): Promise<RunpodJobState<TOutput>> {
  const maxAttempts = options?.maxAttempts ?? 90;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = await getRunpodJobStatus<TOutput>(jobId);
    options?.onStatus?.(state, attempt);

    if (state.status === "COMPLETED") {
      return state;
    }

    if (
      state.status === "FAILED" ||
      state.status === "CANCELLED" ||
      state.status === "TIMED_OUT"
    ) {
      throw new Error(
        `Runpod job ${state.status.toLowerCase()}: ${state.error ?? "unknown error"}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Runpod job timed out while waiting for completion.");
}
