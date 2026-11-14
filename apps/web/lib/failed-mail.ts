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

/** A queued retry that has not gone through after this many minutes is "stuck" (D39). */
export const STUCK_AFTER_MINUTES = 60;

export type RetryFields = {
  status: string;
  retry_requested_at: string | null;
  retry_alerted_at: string | null;
};

/** Stuck: still queued after an hour, or failed again after a retry and already alerted. `now` is injected for tests. */
export function isStuck(r: RetryFields, now: Date = new Date()): boolean {
  if (r.status === "retry_requested" && r.retry_requested_at) {
    return now.getTime() - new Date(r.retry_requested_at).getTime() > STUCK_AFTER_MINUTES * 60_000;
  }
  return r.status === "failed" && r.retry_alerted_at !== null;
}

/** "Retry queued 12 min ago" style label; null when nothing was requested. */
export function retryQueuedLabel(requestedAt: string | null, now: Date = new Date()): string | null {
  if (!requestedAt) return null;
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(requestedAt).getTime()) / 60_000));
  if (mins < 1) return "Retry queued just now";
  if (mins < 60) return `Retry queued ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Retry queued ${hours} h ago`;
  return `Retry queued ${Math.floor(hours / 24)} d ago`;
}

export type StatusFilter = "failed" | "retry_requested";

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "failed", label: "Failed" },
  { value: "retry_requested", label: "Retry queued" },
];

/** Statuses to query for the filter value; anything unknown (or empty) means all. */
export function statusesForFilter(value: string | undefined): StatusFilter[] {
  return value === "failed" || value === "retry_requested" ? [value] : ["failed", "retry_requested"];
}
