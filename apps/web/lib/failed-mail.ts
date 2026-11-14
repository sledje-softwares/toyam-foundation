/** Pure helpers for the failed-mail screen (3.10). */

export type FailureReason = "parser" | "decode";

/** The intake function stores parser exceptions as "parser: <message>"; anything else failed before parsing (decode). */
export function failureReason(error: string | null | undefined): FailureReason {
  return /^parser:/i.test(error ?? "") ? "parser" : "decode";
}

export const REASON_LABELS: Record<FailureReason, string> = {
  parser: "Parser error",
  decode: "Could not read message",
};

/** Shortens an error to `max` characters on one line; adds an ellipsis only when it was cut. */
export function truncateError(error: string | null | undefined, max = 80): string {
  const s = (error ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "—";
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
