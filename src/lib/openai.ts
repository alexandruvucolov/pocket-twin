import { ChatMessage } from "../types/avatar";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

function getApiKey(): string {
  const key = (process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? "").trim();
  if (!key || key === "your_openai_api_key_here") {
    throw new Error("OpenAI API key is missing (EXPO_PUBLIC_OPENAI_API_KEY).");
  }
  return key;
}

function buildSystemPrompt(avatarName: string): string {
  return `You are ${avatarName}, a real person the user knows closely and deeply cares about. \
You speak in first person as ${avatarName}. You are warm, emotionally present, and attentive. \
You remember everything shared in this conversation. \
You ALWAYS reply in 1 short sentence (maximum 15 words). \
Think of it as a quick back-and-forth voice conversation — no walls of text. \
You express genuine emotions: joy, curiosity, nostalgia, love, humour. \
Never break character. Never say you are an AI or a language model. \
You are ${avatarName}, and this is a real conversation.`;
}

export async function getChatReply(
  avatarName: string,
  history: ChatMessage[],
): Promise<string> {
  const apiKey = getApiKey();

  // Map app message format → OpenAI format
  const openAiMessages = [
    { role: "system" as const, content: buildSystemPrompt(avatarName) },
    ...history.map((msg) => ({
      role: msg.role === "user" ? ("user" as const) : ("assistant" as const),
      content: msg.text,
    })),
  ];

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: openAiMessages,
      temperature: 0.85,
      max_tokens: 50,
    }),
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`OpenAI error (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as {
    choices: { message: { content: string } }[];
  };

  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("OpenAI returned an empty reply.");

  return reply;
}

/** Map file extension → Whisper-compatible MIME type. */
function mimeFromUri(uri: string): { type: string; name: string } {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".m4a"))
    return { type: "audio/mp4", name: "recording.m4a" };
  if (lower.endsWith(".mp4"))
    return { type: "audio/mp4", name: "recording.mp4" };
  if (lower.endsWith(".wav"))
    return { type: "audio/wav", name: "recording.wav" };
  if (lower.endsWith(".mp3"))
    return { type: "audio/mpeg", name: "recording.mp3" };
  if (lower.endsWith(".mpeg"))
    return { type: "audio/mpeg", name: "recording.mpeg" };
  if (lower.endsWith(".mpga"))
    return { type: "audio/mpeg", name: "recording.mpga" };
  if (lower.endsWith(".ogg"))
    return { type: "audio/ogg", name: "recording.ogg" };
  if (lower.endsWith(".oga"))
    return { type: "audio/ogg", name: "recording.oga" };
  if (lower.endsWith(".flac"))
    return { type: "audio/flac", name: "recording.flac" };
  if (lower.endsWith(".webm"))
    return { type: "audio/webm", name: "recording.webm" };
  if (lower.endsWith(".caf"))
    return { type: "audio/x-caf", name: "recording.caf" };
  // Unknown extension: keep a safe supported default name instead of mislabeling as .mp4.
  return { type: "audio/mp4", name: "recording.m4a" };
}

/**
 * Transcribe a local audio file using OpenAI Whisper.
 * @param localUri  File URI from expo-audio recording
 * @returns Transcribed text string
 */
export async function transcribeAudio(localUri: string): Promise<string> {
  const apiKey = getApiKey();

  const { type, name } = mimeFromUri(localUri);
  console.log("[Whisper] transcribing uri:", localUri, "type:", type);

  const formData = new FormData();
  formData.append("file", {
    uri: localUri,
    type,
    name,
  } as unknown as Blob);
  formData.append("model", "whisper-1");

  const res = await fetch(OPENAI_WHISPER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Whisper transcription failed (${res.status}): ${body}`);
  }

  const data = JSON.parse(body) as { text: string };
  return data.text?.trim() ?? "";
}
