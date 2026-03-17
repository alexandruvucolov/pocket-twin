import * as FileSystem from "expo-file-system/legacy";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Default reply voice — male fallback.
// Can be overridden with EXPO_PUBLIC_ELEVENLABS_VOICE_ID in .env
// Example common voice IDs: Adam=pNInz6obpgDQGcFmaJgB, Josh=TxGEqnHWrfWFTfGW9XjX
const DEFAULT_VOICE_ID = (
  process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? "pNInz6obpgDQGcFmaJgB"
).trim();

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
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const fileUri = (FileSystem.cacheDirectory ?? "") + `tts_${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(fileUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return fileUri;
}
