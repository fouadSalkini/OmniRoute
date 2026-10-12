/** Pure, bounded retry decisions for empty and not-ready SSE streams. */
export const STREAM_EARLY_EOF_MAX_RETRIES = 1;

const RETRYABLE_STREAM_EMPTY_CODES: ReadonlySet<string> = new Set([
  "STREAM_EARLY_EOF",
  "empty_response",
  "empty_content",
]);

export function shouldRetryStreamEarlyEof(
  errorCode: string | null | undefined,
  attempt: number
): boolean {
  return (
    typeof errorCode === "string" &&
    RETRYABLE_STREAM_EMPTY_CODES.has(errorCode) &&
    attempt < STREAM_EARLY_EOF_MAX_RETRIES
  );
}

export const STREAM_READINESS_TIMEOUT_MAX_RETRIES = 1;

export function shouldRetryStreamReadinessTimeout(
  errorCode: string | null | undefined,
  attempt: number,
  isCombo: boolean,
  clientAborted: boolean
): boolean {
  return (
    !isCombo &&
    !clientAborted &&
    errorCode === "STREAM_READINESS_TIMEOUT" &&
    attempt < STREAM_READINESS_TIMEOUT_MAX_RETRIES
  );
}
