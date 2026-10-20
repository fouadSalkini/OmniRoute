const TOOL_CALLING_UNSUPPORTED_PATTERNS: string[] = [
  // Specialty / non-chat surfaces must never inherit optimistic tool defaults (#8016)
  "whisper",
  "tts-1",
  "gpt-4o-mini-tts",
  "omni-moderation",
  "moderation",
  "eleven_multilingual",
  "eleven_turbo",
  "seedance",
  "/veo",
  "veo-",
  "rerank",
  "embedding",
  "dall-e",
  "flux-",
  "stable-diffusion",
];
const REASONING_UNSUPPORTED_PATTERNS = [
  "antigravity/tab_",
  // Specialty / non-chat surfaces (#8016)
  "whisper",
  "tts-1",
  "gpt-4o-mini-tts",
  "omni-moderation",
  "moderation",
  "eleven_multilingual",
  "eleven_turbo",
  "seedance",
  "/veo",
  "veo-",
  "rerank",
  "embedding",
  "dall-e",
  "flux-",
  "stable-diffusion",
  // Non-reasoning Llama chat ids (#3258) dropped from the Groq static catalog when Groq retired
  // them for free/developer tiers — enterprise keys and live discovery can still reach them, and
  // Groq returns HTTP 400 if reasoning_effort is forwarded.
  "llama-3.3-70b-versatile",
  "llama-4-scout-17b-16e-instruct",
];

/** Catalog/API surface types that are not chat completions. */
const NON_CHAT_SURFACE_TYPES = new Set([
  "audio",
  "video",
  "image",
  "moderation",
  "rerank",
  "embedding",
  "music",
]);

export function isNonChatCatalogSurface(type: unknown): boolean {
  return typeof type === "string" && NON_CHAT_SURFACE_TYPES.has(type);
}

const MAX_TOKENS_UNSUPPORTED_PATTERNS = [
  "o1-preview",
  "o1-mini",
  "o1",
  "o3-mini",
  "o3",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-6",
];

export function heuristicToolCalling(modelStr: string): boolean {
  const normalized = String(modelStr || "").toLowerCase();
  if (!normalized) return false;
  const blocked = TOOL_CALLING_UNSUPPORTED_PATTERNS.some((pattern) => {
    if (normalized === pattern) return true;
    if (normalized.endsWith(`/${pattern}`)) return true;
    return normalized.includes(pattern);
  });
  return !blocked;
}

export function heuristicReasoning(modelStr: string): boolean {
  const normalized = String(modelStr || "").toLowerCase();
  if (!normalized) return true;
  const blocked = REASONING_UNSUPPORTED_PATTERNS.some(
    (pattern) =>
      normalized === pattern || normalized.endsWith(`/${pattern}`) || normalized.includes(pattern)
  );
  return !blocked;
}

export function heuristicMaxTokens(modelStr: string): boolean {
  const normalized = String(modelStr || "").toLowerCase();
  if (!normalized) return true;
  const blocked = MAX_TOKENS_UNSUPPORTED_PATTERNS.some(
    (pattern) =>
      normalized === pattern || normalized.endsWith(`/${pattern}`) || normalized.includes(pattern)
  );
  return !blocked;
}
