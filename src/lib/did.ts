const DID_BASE = "https://api.d-id.com";

export interface DidAgentStreamIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface DidAgentStreamOffer {
  type: string;
  sdp: string;
}

export interface DidAgentStreamSession {
  agentId: string;
  streamId: string;
  sessionId: string;
  offer: DidAgentStreamOffer;
  iceServers: DidAgentStreamIceServer[];
}

function getAuthHeader(): string {
  const raw = (process.env.EXPO_PUBLIC_DID_API_KEY ?? "").trim();
  if (!raw)
    throw new Error("D-ID API key is missing (EXPO_PUBLIC_DID_API_KEY).");
  if (raw.startsWith("Basic ")) return raw;
  return `Basic ${raw}`;
}

function getDidLiveVoiceId(): string {
  return (
    process.env.EXPO_PUBLIC_DID_LIVE_VOICE_ID ??
    "en-US-AndrewMultilingualNeural"
  ).trim();
}

function normalizeIceServers(
  iceServers: Array<{
    urls?: string | string[];
    url?: string;
    username?: string;
    credential?: string;
  }> = [],
): DidAgentStreamIceServer[] {
  return iceServers
    .map((server) => ({
      urls: server.urls ?? server.url ?? [],
      username: server.username,
      credential: server.credential,
    }))
    .filter((server) =>
      Array.isArray(server.urls)
        ? server.urls.length > 0
        : Boolean(server.urls),
    );
}

/**
 * Upload a local image file directly to D-ID's /images endpoint.
 * Returns a D-ID-hosted URL that their Rekognition moderation can access.
 */
export async function uploadImageToDID(localUri: string): Promise<string> {
  const auth = getAuthHeader();

  const formData = new FormData();
  formData.append("image", {
    uri: localUri,
    type: "image/jpeg",
    name: "avatar.jpg",
  } as unknown as Blob);

  const res = await fetch(`${DID_BASE}/images`, {
    method: "POST",
    headers: {
      Authorization: auth,
      accept: "application/json",
      // Do NOT set Content-Type manually — fetch sets it with the boundary
    },
    body: formData,
  });

  const body = await res.text();
  console.log("[D-ID] uploadImage response", res.status, body.slice(0, 300));

  if (!res.ok) {
    throw new Error(`D-ID image upload failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as { url: string };
  return data.url;
}

export async function createAgentFromPhoto(params: {
  name: string;
  sourceUrl: string;
  voiceId?: string;
}): Promise<string> {
  const res = await fetch(`${DID_BASE}/agents`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      preview_name: params.name,
      presenter: {
        type: "talk",
        source_url: params.sourceUrl,
        thumbnail: params.sourceUrl,
        voice: {
          type: "microsoft",
          voice_id: params.voiceId ?? getDidLiveVoiceId(),
        },
      },
    }),
  });

  const body = await res.text();
  console.log("[D-ID] createAgentFromPhoto response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID create agent failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as { id: string };
  if (!data.id) throw new Error("D-ID create agent returned no id.");
  return data.id;
}

export async function createAgentStream(
  agentId: string,
  options?: {
    streamWarmup?: boolean;
    compatibilityMode?: "on" | "off" | "auto";
    fluent?: boolean;
  },
): Promise<DidAgentStreamSession> {
  const res = await fetch(`${DID_BASE}/agents/${agentId}/streams`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      stream_warmup: options?.streamWarmup ?? true,
      compatibility_mode: options?.compatibilityMode ?? "auto",
      fluent: options?.fluent ?? false,
    }),
  });

  const body = await res.text();
  console.log("[D-ID] createAgentStream response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID create stream failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as {
    id: string;
    session_id: string;
    offer: DidAgentStreamOffer;
    ice_servers?: Array<{
      urls?: string | string[];
      url?: string;
      username?: string;
      credential?: string;
    }>;
  };

  return {
    agentId,
    streamId: data.id,
    sessionId: data.session_id,
    offer: data.offer,
    iceServers: normalizeIceServers(data.ice_servers),
  };
}

export async function startAgentConnection(params: {
  agentId: string;
  streamId: string;
  sessionId: string;
  answer: {
    type: string;
    sdp: string;
  };
}): Promise<void> {
  const res = await fetch(
    `${DID_BASE}/agents/${params.agentId}/streams/${params.streamId}/sdp`,
    {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        session_id: params.sessionId,
        answer: params.answer,
      }),
    },
  );

  const body = await res.text();
  console.log("[D-ID] startAgentConnection response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID start connection failed (${res.status}): ${body}`);
  }
}

export async function submitAgentIceCandidate(params: {
  agentId: string;
  streamId: string;
  sessionId: string;
  candidate: string | null;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}): Promise<void> {
  const res = await fetch(
    `${DID_BASE}/agents/${params.agentId}/streams/${params.streamId}/ice`,
    {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        session_id: params.sessionId,
        candidate: params.candidate,
        sdpMid: params.sdpMid,
        sdpMLineIndex: params.sdpMLineIndex,
      }),
    },
  );

  const body = await res.text();
  console.log("[D-ID] submitAgentIceCandidate response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID ICE failed (${res.status}): ${body}`);
  }
}

export async function createAgentVideoStream(params: {
  agentId: string;
  streamId: string;
  sessionId: string;
  text: string;
  voiceId?: string;
}): Promise<void> {
  const res = await fetch(
    `${DID_BASE}/agents/${params.agentId}/streams/${params.streamId}`,
    {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        session_id: params.sessionId,
        script: {
          type: "text",
          input: params.text,
          provider: {
            type: "microsoft",
            voice_id: params.voiceId ?? getDidLiveVoiceId(),
          },
        },
      }),
    },
  );

  const body = await res.text();
  console.log("[D-ID] createAgentVideoStream response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID live speak failed (${res.status}): ${body}`);
  }
}

export async function deleteAgentStream(params: {
  agentId: string;
  streamId: string;
}): Promise<void> {
  const res = await fetch(
    `${DID_BASE}/agents/${params.agentId}/streams/${params.streamId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: getAuthHeader(),
        accept: "application/json",
      },
    },
  );

  const body = await res.text();
  console.log("[D-ID] deleteAgentStream response", res.status, body);

  if (!res.ok) {
    throw new Error(`D-ID delete stream failed (${res.status}): ${body}`);
  }
}

function audioMimeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  return "audio/mpeg";
}

export async function uploadAudioToDID(localUri: string): Promise<string> {
  const auth = getAuthHeader();

  const formData = new FormData();
  formData.append("audio", {
    uri: localUri,
    type: audioMimeFromUri(localUri),
    name: localUri.toLowerCase().endsWith(".wav") ? "reply.wav" : "reply.mp3",
  } as unknown as Blob);

  const res = await fetch(`${DID_BASE}/audios`, {
    method: "POST",
    headers: {
      Authorization: auth,
      accept: "application/json",
    },
    body: formData,
  });

  const body = await res.text();
  console.log("[D-ID] uploadAudio response", res.status, body.slice(0, 300));

  if (!res.ok) {
    throw new Error(`D-ID audio upload failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as {
    url?: string;
    audio_url?: string;
    result_url?: string;
  };
  const url = data.url ?? data.audio_url ?? data.result_url;
  if (!url) throw new Error("D-ID audio upload returned no URL.");
  return url;
}

export async function createTalk(didImageUrl: string): Promise<string> {
  console.log("[D-ID] createTalk → source_url:", didImageUrl.slice(0, 80));
  const res = await fetch(`${DID_BASE}/talks`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      source_url: didImageUrl,
      script: {
        type: "text",
        subtitles: false,
        provider: {
          type: "microsoft",
          voice_id: "en-US-JennyNeural",
        },
        input: "Hi! I'm your Pocket Twin. I'm ready to chat with you!",
      },
      config: { fluent: false, pad_audio: 0 },
    }),
  });

  const body = await res.text();
  console.log("[D-ID] createTalk response", res.status, body.slice(0, 300));

  if (!res.ok) {
    throw new Error(`D-ID create talk failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as { id: string };
  return data.id;
}

export async function createTalkFromAudio(
  didImageUrl: string,
  didAudioUrl: string,
  name?: string,
): Promise<string> {
  console.log(
    "[D-ID] createTalkFromAudio → source_url:",
    didImageUrl.slice(0, 80),
  );
  const res = await fetch(`${DID_BASE}/talks`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      source_url: didImageUrl,
      script: {
        type: "audio",
        audio_url: didAudioUrl,
      },
      config: { fluent: false, pad_audio: 0 },
      ...(name ? { name } : {}),
    }),
  });

  const body = await res.text();
  console.log(
    "[D-ID] createTalkFromAudio response",
    res.status,
    body.slice(0, 300),
  );

  if (!res.ok) {
    throw new Error(
      `D-ID create talk from audio failed (${res.status}): ${body}`,
    );
  }

  const data = JSON.parse(body) as { id: string };
  return data.id;
}

export async function pollTalk(
  talkId: string,
  onProgress?: (pct: number) => void,
  maxAttempts = 60,
): Promise<string> {
  const auth = getAuthHeader();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 2_000));

    const res = await fetch(`${DID_BASE}/talks/${talkId}`, {
      headers: { Authorization: auth, accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`D-ID poll failed (${res.status})`);
    }

    const data = (await res.json()) as {
      status: string;
      result_url?: string;
    };

    console.log(
      `[D-ID] pollTalk ${talkId} attempt ${attempt + 1}/${maxAttempts} status=${data.status}`,
    );

    onProgress?.(Math.min(55 + attempt * 3, 93));

    if (data.status === "done" && data.result_url) {
      console.log(`[D-ID] pollTalk ${talkId} done`, data.result_url);
      return data.result_url;
    }
    if (data.status === "error" || data.status === "rejected") {
      throw new Error(`D-ID talk rejected (status: ${data.status})`);
    }
  }

  throw new Error("D-ID animation timed out after 120 seconds.");
}
