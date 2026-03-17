import {
  isRunpodLivePortraitConfigured,
  submitRunpodJob,
  waitForRunpodJob,
} from "./runpod";

interface LivePortraitOutputShape {
  output?: unknown;
  result?: unknown;
  video_url?: string;
  url?: string;
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractVideoUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const direct =
    pickString(record.video_url) ??
    pickString(record.videoUrl) ??
    pickString(record.result_url) ??
    pickString(record.resultUrl) ??
    pickString(record.url) ??
    pickString(record.mp4_url) ??
    pickString(record.mp4Url);

  if (direct) return direct;

  const nestedCandidates = [record.output, record.result, record.data];
  for (const candidate of nestedCandidates) {
    const nested = extractVideoUrl(candidate);
    if (nested) return nested;
  }

  return null;
}

export function getDefaultLivePortraitDrivingVideoUrl(): string | null {
  return (
    (process.env.EXPO_PUBLIC_LIVEPORTRAIT_DRIVING_VIDEO_URL ?? "").trim() ||
    null
  );
}

export function isLivePortraitConfigured(): boolean {
  return isRunpodLivePortraitConfigured();
}

export async function createLivePortraitVideo(params: {
  sourceImageUrl: string;
  drivingVideoUrl?: string;
  motionTemplateUrl?: string;
  outputFormat?: "mp4" | "gif";
  maxAttempts?: number;
  pollIntervalMs?: number;
  onStatus?: (message: string) => void;
}): Promise<string> {
  if (!isRunpodLivePortraitConfigured()) {
    throw new Error("Runpod LivePortrait is not configured.");
  }

  const drivingVideoUrl =
    params.drivingVideoUrl ?? getDefaultLivePortraitDrivingVideoUrl();

  if (!drivingVideoUrl && !params.motionTemplateUrl) {
    throw new Error(
      "LivePortrait needs a driving video or motion template URL. Set EXPO_PUBLIC_LIVEPORTRAIT_DRIVING_VIDEO_URL or pass one explicitly.",
    );
  }

  params.onStatus?.("Submitting LivePortrait job…");

  const job = await submitRunpodJob({
    source_image_url: params.sourceImageUrl,
    ...(drivingVideoUrl ? { driving_video_url: drivingVideoUrl } : {}),
    ...(params.motionTemplateUrl
      ? { motion_template_url: params.motionTemplateUrl }
      : {}),
    output_format: params.outputFormat ?? "mp4",
  });

  const finalState = await waitForRunpodJob<LivePortraitOutputShape>(job.id, {
    maxAttempts: params.maxAttempts ?? 90,
    pollIntervalMs: params.pollIntervalMs ?? 2_000,
    onStatus: (state, attempt) => {
      console.log(
        `[Runpod] LivePortrait job ${job.id} attempt ${attempt} status=${state.status}`,
      );
      params.onStatus?.(`LivePortrait ${String(state.status).toLowerCase()}…`);
    },
  });

  const videoUrl = extractVideoUrl(finalState.output);
  if (!videoUrl) {
    throw new Error(
      "Runpod LivePortrait job completed but no video URL was returned. Update the worker to return `video_url`.",
    );
  }

  return videoUrl;
}
