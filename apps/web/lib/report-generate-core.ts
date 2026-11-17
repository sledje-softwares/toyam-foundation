/**
 * Pure parts of the `report-generate` client (contract: supabase/functions/report-generate/README.md): reply
 * parsing, error messages, the button's state, file names. No I/O, so vitest covers them.
 */
export type GenerateMode = "generate" | "preview";

export type GenerateError = { code: string; message: string; retryAfter: number | null };
export type GenerateOk = {
  ok: true;
  mode: GenerateMode;
  html: string | null;
  version: number | null;
  reportId: string | null;
  photos: number | null;
  warnings: string[];
};
export type GenerateResult = GenerateOk | ({ ok: false } & GenerateError);

export const NOT_SET_UP = "Report generation is not set up yet (ask the admin).";
export const UNAVAILABLE = "The report service is not reachable right now. Try again in a moment.";

/** Whole seconds, at least 1, at most one day; anything else is unknown. */
export function cleanRetryAfter(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.ceil(n), 86400);
}

export function retryText(seconds: number): string {
  if (seconds >= 120) return `Try again in ${Math.ceil(seconds / 60)} min.`;
  return `Try again in ${seconds} s.`;
}

/** The user-facing sentence for an error code; other codes show the server's own message. */
export function errorMessage(code: string, serverMessage: string | null, retryAfter: number | null): string {
  switch (code) {
    case "rate_limited":
      return retryAfter ? retryText(retryAfter) : "Too many requests. Try again in a few seconds.";
    case "values_changed":
      return "Someone changed the report while it was generating. Generate it again.";
    case "no_layout":
      return "This template has no report layout yet.";
    case "pdf_not_configured":
    case "storage_not_configured":
      return NOT_SET_UP;
    case "unauthorized":
      return "Your session has ended. Sign in again.";
    default:
      return serverMessage?.trim() || "The report could not be generated. Try again, or ask the admin if it keeps failing.";
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function warningsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((w): w is string => typeof w === "string" && w.length > 0).slice(0, 50) : [];
}

const invalid = (): GenerateResult => ({ ok: false, code: "invalid_reply", message: errorMessage("invalid_reply", null, null), retryAfter: null });

/** Turns the function's JSON (success or `{ok:false,error}`) into a result. Anything unexpected is a generic failure. */
export function parseGenerateReply(mode: GenerateMode, body: unknown): GenerateResult {
  if (!isObj(body)) return { ok: false, code: "unavailable", message: UNAVAILABLE, retryAfter: null };
  if (body.ok === true) {
    if (mode === "preview") {
      if (typeof body.html !== "string") return invalid();
      return { ok: true, mode, html: body.html, version: null, reportId: null, photos: null, warnings: warningsOf(body.warnings) };
    }
    if (typeof body.version !== "number") return invalid();
    return {
      ok: true,
      mode,
      html: null,
      version: body.version,
      reportId: typeof body.report_id === "string" ? body.report_id : null,
      photos: typeof body.photos === "number" ? body.photos : null,
      warnings: warningsOf(body.warnings),
    };
  }
  const e = isObj(body.error) ? body.error : {};
  const code = typeof e.code === "string" ? e.code : "unknown";
  const retryAfter = cleanRetryAfter(e.retry_after);
  const server = typeof e.message === "string" ? e.message : null;
  return { ok: false, code, message: errorMessage(code, server, retryAfter), retryAfter };
}

/** State of the Generate button: disabled while a request runs or the rate-limit countdown has seconds left. */
export function generateButtonState(input: { pending: boolean; retryLeft: number }): { disabled: boolean; label: string } {
  if (input.pending) return { disabled: true, label: "Generating report…" };
  if (input.retryLeft > 0) return { disabled: true, label: `Generate report (${input.retryLeft} s)` };
  return { disabled: false, label: "Generate report" };
}

export type GenerateState = {
  /** Changes with every answer so the countdown restarts even for the same message. */
  seq: number;
  status: "idle" | "ok" | "error";
  message: string | null;
  version: number | null;
  warnings: string[];
  retryAfter: number | null;
};
export const INITIAL_GENERATE_STATE: GenerateState = { seq: 0, status: "idle", message: null, version: null, warnings: [], retryAfter: null };

export function stateFromResult(prev: GenerateState, r: GenerateResult): GenerateState {
  const seq = prev.seq + 1;
  if (r.ok) return { seq, status: "ok", message: `Version ${r.version} generated.`, version: r.version, warnings: r.warnings, retryAfter: null };
  return { seq, status: "error", message: r.message, version: null, warnings: [], retryAfter: r.retryAfter };
}

export const REPORT_FORMATS = ["pdf", "docx"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const FORMAT_LABEL: Record<ReportFormat, string> = { pdf: "PDF", docx: "Word" };

export function isReportFormat(v: string): v is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(v);
}

/** `<case_ref>_v<n>.<ext>`; characters other than letters, digits, `_` and `-` become `_`. */
export function reportDownloadName(caseRef: string, version: number, format: ReportFormat): string {
  return `${caseRef.replace(/[^A-Za-z0-9_-]+/g, "_")}_v${version}.${format}`;
}

export function reportFileHref(reportId: string, format: string): string {
  return `/files/reports/${reportId}/${format}`;
}
