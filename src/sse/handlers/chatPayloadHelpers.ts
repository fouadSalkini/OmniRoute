import type { VideoBridgeLogRedactionEntry } from "@/lib/guardrails/videoBridge";
import { reanchorVideoBridgeRedaction } from "@/lib/guardrails/videoBridge";

function normalizeAllowedConnectionIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
  );
  return ids.length > 0 ? ids : null;
}

export function intersectAllowedConnectionIds(
  primary: unknown,
  secondary: unknown
): string[] | null {
  const first = normalizeAllowedConnectionIds(primary);
  const second = normalizeAllowedConnectionIds(secondary);

  if (first && second) {
    return first.filter((id) => second.includes(id));
  }

  return first || second || null;
}

export type VideoBridgeLog = { observed: boolean; redaction: VideoBridgeLogRedactionEntry[] };

/**
 * Derive the video-bridge log shadow from pre-call guardrail metadata. The
 * final payload anchors redactions after earlier guardrails may rewrite text.
 */
export function deriveVideoBridgeLog(
  results: Array<{ guardrail: string; meta?: Record<string, unknown> | null }>,
  finalBody: unknown
): VideoBridgeLog | undefined {
  const entry = results.find((result) => result.guardrail === "video-bridge");
  const meta = entry?.meta;
  if (!meta || typeof meta.videoBridgeObserved !== "boolean") return undefined;
  const rawRedaction = Array.isArray(meta.videoBridgeLogRedaction)
    ? (meta.videoBridgeLogRedaction as VideoBridgeLogRedactionEntry[])
    : [];
  const redaction = reanchorVideoBridgeRedaction(rawRedaction, finalBody);
  return { observed: meta.videoBridgeObserved, redaction };
}
