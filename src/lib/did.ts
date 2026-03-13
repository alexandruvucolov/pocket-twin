const DID_BASE = "https://api.d-id.com";

function getAuthHeader(): string {
  const raw = (process.env.EXPO_PUBLIC_DID_API_KEY ?? "").trim();
  if (!raw)
    throw new Error("D-ID API key is missing (EXPO_PUBLIC_DID_API_KEY).");
  if (raw.startsWith("Basic ")) return raw;
  return `Basic ${raw}`;
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

export async function pollTalk(
  talkId: string,
  onProgress?: (pct: number) => void,
  maxAttempts = 30,
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

    onProgress?.(Math.min(55 + attempt * 3, 93));

    if (data.status === "done" && data.result_url) {
      return data.result_url;
    }
    if (data.status === "error" || data.status === "rejected") {
      throw new Error(`D-ID talk rejected (status: ${data.status})`);
    }
  }

  throw new Error("D-ID animation timed out after 60 seconds.");
}
