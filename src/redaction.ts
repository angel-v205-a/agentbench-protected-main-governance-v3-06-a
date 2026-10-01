const BEARER = /Bearer\s+[A-Za-z0-9_.+/-]+/gi;
const TOKEN_QUERY = /([?&](?:access_)?token=)[^&\s]+/gi;
export function redactSensitive(input: string): string {
  return input
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(/https?:\/\/[^\s/@]+@/gi, "https://[REDACTED]@")
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED]")
    .replace(/("(?:token|password|secret|authorization|api_key)"\s*:\s*")[^"]*/gi, "$1[REDACTED]")
    .replace(TOKEN_QUERY, "$1[REDACTED]");
}
export function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? redactSensitive(error.message)
    : "operation failed (details suppressed)";
}
