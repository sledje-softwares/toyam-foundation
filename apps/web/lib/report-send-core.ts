/**
 * Sending a report to the insurer (8.2, D50): pure helpers for the workspace's "Send to insurer" card. No React,
 * no Next, no Supabase (lib/report-send-core.test.ts). The function contract is supabase/functions/report-send/README.md;
 * every rule is checked again by request_report_send / retry_report_send / resolve_report_send.
 */
import { z } from "zod";
import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";
import { renderTemplate, safeName } from "@shared/send/render.ts";

type CaseStatus = Enums<"case_status">;
type UserRole = Enums<"user_role">;

export type SendStatus = "queued" | "sending" | "sent" | "failed" | "unknown" | "test_sent";

export const SEND_STATUSES: Record<SendStatus, { label: string; tone: Tone; hint: string }> = {
  queued: { label: "Queued", tone: "info", hint: "Waiting for the sender. It starts at once, or within 10 minutes at the latest." },
  sending: { label: "Sending", tone: "info", hint: "The sender is handing the email to Gmail." },
  sent: { label: "Sent", tone: "success", hint: "Gmail accepted the email; the submission is recorded." },
  failed: { label: "Failed", tone: "danger", hint: "Nothing was sent. Fix the cause and retry." },
  unknown: {
    label: "Outcome unknown",
    tone: "warning",
    hint: "The connection was lost after the email was handed over. Check the shared Gmail's Sent folder before doing anything: it is never resent by itself.",
  },
  test_sent: { label: "Test run", tone: "neutral", hint: "Test mode: the email went to the test address only. Nothing was recorded as sent." },
};

export function isSendStatus(v: string | null | undefined): v is SendStatus {
  return !!v && v in SEND_STATUSES;
}

/** Statuses that block a new send of the same report (ux_report_sends_open). */
export const OPEN_SEND_STATUSES: SendStatus[] = ["queued", "sending", "unknown"];
/** Case statuses in which a report can be sent (private.report_ready_to_send). */
export const SENDABLE_CASE_STATUSES: CaseStatus[] = ["assigned", "office_review", "orchestrator_review"];
/** Who may settle an unknown outcome in the UI (the database allows anyone who manages the case). */
export const SETTLE_ROLES: UserRole[] = ["orchestrator", "admin"];

export const REPORT_FORMATS = ["pdf", "docx"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type SendRow = {
  id: string;
  report_id: string;
  status: string;
  formats: string[];
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  requested_at: string;
  sent_at: string | null;
  attempts: number;
  error: string | null;
  test_recipient: string | null;
  requester: string | null;
};

export type SendTarget = {
  to_addresses: string[];
  cc_addresses: string[];
  original_subject: string | null;
};

/** case_templates.report_email (config/templates/*.yaml); every key optional. */
export type ReportEmailConfig = { subject?: string; attachment_name?: string; body?: string; cc_from_original?: boolean };

export function readReportEmail(json: unknown): ReportEmailConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const j = json as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return {
    subject: str(j.subject),
    attachment_name: str(j.attachment_name),
    body: str(j.body),
    cc_from_original: typeof j.cc_from_original === "boolean" ? j.cc_from_original : undefined,
  };
}

export const DEFAULT_SUBJECT = "Re: {{original_subject}}";
export const DEFAULT_ATTACHMENT = "{{insurer_claim_no}}_IR";
export const DEFAULT_BODY = [
  "Dear Sir/Madam,",
  "",
  "Please find attached our investigation report for {{claim_text}}.",
  "",
  "Regards,",
  "Toyam Investigation and Valuation Pvt. Ltd",
].join("\n");

export type SendDefaults = { to: string; cc: string; subject: string; body: string; attachmentName: string; formats: ReportFormat[] };

/** Body text with `{{name}}` filled, keeping its line breaks (renderTemplate flattens values, not the pattern). */
function renderBody(pattern: string, values: Record<string, string | null | undefined>): string {
  return pattern.split("\n").map((line) => renderTemplate(line, values)).join("\n");
}

/**
 * The form's starting values: reply target from report_send_target (the insurer's latest mail), subject and file
 * name from the template's report_email patterns, formats = the template default among the generated ones.
 */
export function sendDefaults(input: {
  target: SendTarget | null;
  reportEmail: ReportEmailConfig;
  values: Record<string, string | null | undefined>;
  caseRef: string;
  allowedFormats: string[];
  generatedFormats: string[];
  defaultFormat: string | null;
}): SendDefaults {
  const original = (input.target?.original_subject ?? "").replace(/^(\s*re\s*:\s*)+/i, "").trim();
  const values = {
    ...input.values,
    original_subject: original || input.caseRef,
    case_ref: input.caseRef,
    // "claim no. X (insured)" for the default body; values are trimmed by renderTemplate, so it is built here
    claim_text: [
      input.values.insurer_claim_no ? `claim no. ${input.values.insurer_claim_no}` : `case ${input.caseRef}`,
      input.values.insured_name ? `(${input.values.insured_name})` : "",
    ].filter(Boolean).join(" "),
  };
  const subject = renderTemplate(input.reportEmail.subject ?? DEFAULT_SUBJECT, values).slice(0, 300) || `Report ${input.caseRef}`;
  const rawName = renderTemplate(input.reportEmail.attachment_name ?? DEFAULT_ATTACHMENT, values);
  const attachmentName = /[A-Za-z0-9]/.test(rawName.replace(/_IR$/, "")) ? safeName(rawName, 100) : safeName(`${input.caseRef}_IR`, 100);
  const usable = REPORT_FORMATS.filter((f) => input.allowedFormats.includes(f) && input.generatedFormats.includes(f));
  const formats = usable.filter((f) => f === input.defaultFormat);
  return {
    to: (input.target?.to_addresses ?? []).join(", "),
    cc: input.reportEmail.cc_from_original === false ? "" : (input.target?.cc_addresses ?? []).join(", "),
    subject,
    body: renderBody(input.reportEmail.body ?? DEFAULT_BODY, values).slice(0, 5000),
    attachmentName,
    formats: formats.length ? formats : usable.slice(0, 1),
  };
}

// ---------------------------------------------------------------------
// What the card offers
// ---------------------------------------------------------------------
export type SendModel = {
  /** The form is offered. */
  canSend: boolean;
  /** Why it is not (shown instead of the form), or null when nothing is to be said. */
  blocked: string | null;
  /** The latest version's open send (queued / sending / unknown), if any. */
  open: SendRow | null;
};

export function sendModel(input: {
  canManage: boolean;
  caseStatus: CaseStatus;
  approvalState: "not_required" | "no_version" | "not_requested" | "pending" | "approved" | "changes_requested";
  latestReportId: string | null;
  sends: SendRow[];
  hasTarget: boolean;
  usableFormats: string[];
}): SendModel {
  const open = input.sends.find((s) => s.report_id === input.latestReportId && (OPEN_SEND_STATUSES as string[]).includes(s.status)) ?? null;
  const no = (blocked: string | null): SendModel => ({ canSend: false, blocked, open });
  if (!input.canManage) return no(null);
  if (input.caseStatus === "submitted" || input.caseStatus === "closed" || input.caseStatus === "cancelled") return no(null);
  if (!input.latestReportId) return no(null);
  if (input.approvalState !== "approved" && input.approvalState !== "not_required") return no(null);
  if (!SENDABLE_CASE_STATUSES.includes(input.caseStatus)) return no("Field work is still open; the report can be sent when it is finished.");
  if (open) return no(null);
  if (!input.hasTarget) {
    return no("There is no insurer email on this case to reply to. Deliver the report another way and record it on Submissions.");
  }
  if (input.usableFormats.length === 0) return no("The latest version has no file in a format this insurer's template allows. Generate the report again.");
  return { canSend: true, blocked: null, open: null };
}

export function rowActions(input: { role: UserRole; canManage: boolean; status: string; isLatest: boolean }): {
  retry: boolean;
  sendNow: boolean;
  settle: boolean;
} {
  return {
    retry: input.canManage && input.status === "failed" && input.isLatest,
    sendNow: input.canManage && input.status === "queued",
    settle: input.canManage && input.status === "unknown" && SETTLE_ROLES.includes(input.role),
  };
}

// ---------------------------------------------------------------------
// Form input (app/(app)/reports/[caseRef]/send-actions.ts)
// ---------------------------------------------------------------------
const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Splits on commas, semicolons, spaces and line breaks; lower-case; duplicates removed. */
export function parseAddressList(raw: string): { list: string[]; bad: string | null } {
  const list: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const a = part.trim().toLowerCase();
    if (!a) continue;
    if (!ADDRESS.test(a) || a.length > 254) return { list, bad: part.trim().slice(0, 60) };
    if (!list.includes(a)) list.push(a);
  }
  return { list, bad: null };
}

const addressField = (label: string, required: boolean) =>
  z.string().transform((v, ctx) => {
    const r = parseAddressList(v);
    if (r.bad) {
      ctx.addIssue({ code: "custom", message: `${label}: "${r.bad}" is not an email address.` });
      return z.NEVER;
    }
    if (required && r.list.length === 0) {
      ctx.addIssue({ code: "custom", message: `Add at least one ${label} address.` });
      return z.NEVER;
    }
    return r.list;
  });

const Id = z.guid();
export const CaseRef = z.string().regex(/^[A-Za-z0-9_\-/]{3,40}$/);

export const SendInput = z
  .object({
    case_id: Id,
    case_ref: CaseRef,
    formats: z
      .array(z.enum(REPORT_FORMATS))
      .min(1, { message: "Choose at least one format." })
      .refine((f) => new Set(f).size === f.length, { message: "Choose each format once." }),
    to: addressField("To", true),
    cc: addressField("Cc", false),
    subject: z.string().trim().min(1, { message: "Enter a subject." }).max(300, { message: "Keep the subject under 300 characters." }),
    body: z.string().trim().min(1, { message: "Enter the message." }).max(5000, { message: "Keep the message under 5000 characters." }),
    attachment_name: z
      .string()
      .trim()
      .min(1, { message: "Enter the file name." })
      .max(100, { message: "Keep the file name under 100 characters." }),
  })
  .refine((v) => v.to.length + v.cc.filter((a) => !v.to.includes(a)).length <= 30, { message: "At most 30 recipients in all.", path: ["cc"] });

export const SendIdInput = z.object({ send_id: Id, case_ref: CaseRef });
export const SettleInput = SendIdInput.extend({ was_sent: z.enum(["yes", "no"]) });

export function firstIssue(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Check the form and try again.";
}

// ---------------------------------------------------------------------
// Replies of the report-send function ({ action: 'send' } and { action: 'mode' })
// ---------------------------------------------------------------------
export type SenderMode = { configured: boolean; mode: "test" | "live" | null; testTo: string | null };
export type KickResult = { ok: true; mode: "test" | "live"; testTo: string | null } | { ok: false; code: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseModeReply(v: unknown): SenderMode | null {
  if (!isObj(v) || v.ok !== true) return null;
  const mode = v.mode === "test" || v.mode === "live" ? v.mode : null;
  return { configured: v.configured === true && mode !== null, mode, testTo: typeof v.test_to === "string" ? v.test_to : null };
}

export function parseKickReply(v: unknown): KickResult {
  if (isObj(v) && v.ok === true && v.accepted === true && (v.mode === "test" || v.mode === "live")) {
    return { ok: true, mode: v.mode, testTo: typeof v.test_to === "string" ? v.test_to : null };
  }
  const code = isObj(v) && isObj(v.error) && typeof v.error.code === "string" ? v.error.code : "unavailable";
  return { ok: false, code };
}

/** Flash after queueing (or retrying, or "Send now"). */
export function kickMessage(k: KickResult): string {
  if (k.ok) {
    return k.mode === "test"
      ? `Test mode: the email is going to ${k.testTo ?? "the test address"} only, not to the insurer. Nothing will be recorded as sent.`
      : "Sending to the insurer now. The status below updates in a moment.";
  }
  if (k.code === "not_configured") return "Queued, but sending is not set up yet (ask the admin). It goes out once the sender is configured.";
  if (k.code === "not_queued") return "The sender has already picked this email up.";
  return "Queued. The sender could not be reached just now; it picks the email up within 10 minutes.";
}
