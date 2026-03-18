const DEFAULT_LIVE_AVATAR_BACKEND_URL = "";

export interface LiveAvatarIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface LiveAvatarOffer {
  type: string;
  sdp: string;
}

export interface LiveAvatarRtcSession {
  sessionId: string;
  offer: LiveAvatarOffer;
  iceServers: LiveAvatarIceServer[];
}

export interface LiveAvatarSessionOptions {
  livePortraitMode?: "full" | "lips-only";
  livePortraitDrivingVideoUrl?: string;
  livePortraitMotionTemplateUrl?: string;
  livePortraitOptions?: Record<string, unknown>;
}

function getBackendBaseUrl() {
  return (
    process.env.EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL ??
    DEFAULT_LIVE_AVATAR_BACKEND_URL
  ).trim();
}

function getOptionalPublicToken() {
  return (process.env.EXPO_PUBLIC_LIVE_AVATAR_PUBLIC_TOKEN ?? "").trim();
}

function getHeaders() {
  const token = getOptionalPublicToken();
  return {
    "Content-Type": "application/json",
    accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function getRequiredBaseUrl() {
  const value = getBackendBaseUrl();
  if (!value) {
    throw new Error(
      "Live avatar backend URL is missing (EXPO_PUBLIC_LIVE_AVATAR_BACKEND_URL).",
    );
  }
  return value.replace(/\/$/, "");
}

async function parseJson<T>(res: Response, errorPrefix: string): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${errorPrefix} (${res.status}): ${body}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${errorPrefix}: invalid JSON response.`);
  }
}

export function isLiveAvatarBackendConfigured(): boolean {
  return Boolean(getBackendBaseUrl());
}

export async function createLiveAvatarSession(
  params: {
    avatarId: string;
    avatarName: string;
    sourceImageUrl?: string;
    sourceImageBase64?: string;
    sourceImageMimeType?: string;
  } & LiveAvatarSessionOptions,
): Promise<LiveAvatarRtcSession> {
  const baseUrl = getRequiredBaseUrl();
  const res = await fetch(`${baseUrl}/api/live-avatar/sessions`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });

  return parseJson<LiveAvatarRtcSession>(
    res,
    "Live avatar session creation failed",
  );
}

export async function submitLiveAvatarAnswer(params: {
  sessionId: string;
  answer: {
    type: string;
    sdp: string;
  };
}): Promise<void> {
  const baseUrl = getRequiredBaseUrl();
  const res = await fetch(
    `${baseUrl}/api/live-avatar/sessions/${params.sessionId}/answer`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ answer: params.answer }),
    },
  );

  await parseJson<Record<string, never> | { ok: boolean }>(
    res,
    "Live avatar SDP answer failed",
  );
}

export async function submitLiveAvatarIceCandidate(params: {
  sessionId: string;
  candidate: string | null;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}): Promise<void> {
  const baseUrl = getRequiredBaseUrl();
  const res = await fetch(
    `${baseUrl}/api/live-avatar/sessions/${params.sessionId}/ice`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        candidate: params.candidate,
        sdpMid: params.sdpMid,
        sdpMLineIndex: params.sdpMLineIndex,
      }),
    },
  );

  await parseJson<Record<string, never> | { ok: boolean }>(
    res,
    "Live avatar ICE candidate failed",
  );
}

export async function speakLiveAvatarText(params: {
  sessionId: string;
  text: string;
}): Promise<void> {
  const baseUrl = getRequiredBaseUrl();
  const res = await fetch(
    `${baseUrl}/api/live-avatar/sessions/${params.sessionId}/speak`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ text: params.text }),
    },
  );

  await parseJson<Record<string, never> | { ok: boolean }>(
    res,
    "Live avatar speak request failed",
  );
}

export async function deleteLiveAvatarSession(params: {
  sessionId: string;
}): Promise<void> {
  const baseUrl = getRequiredBaseUrl();
  const res = await fetch(
    `${baseUrl}/api/live-avatar/sessions/${params.sessionId}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/json",
        ...(getOptionalPublicToken()
          ? { Authorization: `Bearer ${getOptionalPublicToken()}` }
          : {}),
      },
    },
  );

  await parseJson<Record<string, never> | { ok: boolean }>(
    res,
    "Live avatar session delete failed",
  );
}
