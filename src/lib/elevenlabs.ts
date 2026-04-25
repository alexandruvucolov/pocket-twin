import * as FileSystem from "expo-file-system/legacy";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Default reply voice — male fallback.
// Can be overridden with EXPO_PUBLIC_ELEVENLABS_VOICE_ID in .env
// Example common voice IDs: Adam=pNInz6obpgDQGcFmaJgB, Josh=TxGEqnHWrfWFTfGW9XjX
const DEFAULT_VOICE_ID = (
  process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? "UgBBYS2sOqTuMpoF3BR0"
).trim();

function bytesToBase64(bytes: Uint8Array): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;

    const enc1 = b0 >> 2;
    const enc2 = ((b0 & 0x03) << 4) | (b1 >> 4);
    const enc3 = ((b1 & 0x0f) << 2) | (b2 >> 6);
    const enc4 = b2 & 0x3f;

    out += chars[enc1];
    out += chars[enc2];
    out += hasB1 ? chars[enc3] : "=";
    out += hasB2 ? chars[enc4] : "=";
  }

  return out;
}

function getApiKey(): string {
  const key = (process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? "").trim();
  if (!key || key === "your_elevenlabs_api_key_here") {
    throw new Error(
      "ElevenLabs API key is missing (EXPO_PUBLIC_ELEVENLABS_API_KEY).",
    );
  }
  return key;
}

/**
 * Convert text to speech via ElevenLabs and return raw base64-encoded MP3.
 * Use this when you need to forward the audio bytes to a backend (e.g. RunPod
 * LatentSync worker) rather than playing it locally.
 */
export async function textToSpeechBase64(
  text: string,
  voiceId: string = DEFAULT_VOICE_ID,
): Promise<string> {
  const apiKey = getApiKey();

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errBody}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return bytesToBase64(new Uint8Array(arrayBuffer));
}

/**
 * Convert text to speech via ElevenLabs and return a local file URI
 * ready to be played by expo-audio.
 */
export async function textToSpeech(
  text: string,
  voiceId: string = DEFAULT_VOICE_ID,
): Promise<string> {
  const apiKey = getApiKey();

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errBody}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const base64 = bytesToBase64(bytes);

  const fileUri = (FileSystem.cacheDirectory ?? "") + `tts_${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(fileUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return fileUri;
}
