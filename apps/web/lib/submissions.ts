/**
 * Submissions list (8.5): pure helpers. No React, no Next, no Supabase (lib/submissions.test.ts).
 * Design: docs/12-office-pages/reports.md.
 */

import { z } from "zod";
import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";
import { parseIstDateTime } from "./tasks-form";

type CaseStatus = Enums<"case_status">;
type Channel = Enums<"submission_channel">;

export const CHANNELS: Record<Channel, string> = { email: "Email", portal: "Portal", other: "Other" };
export const CHANNEL_KEYS = Object.keys(CHANNELS) as Channel[];

export function isChannel(v: string | null | undefined): v is Channel {
  return !!v && (CHANNEL_KEYS as string[]).includes(v);
}

export type AckFilter = "acknowledged" | "awaiting";
export const ACK_FILTERS: Record<AckFilter, string> = { acknowledged: "Acknowledged", awaiting: "Awaiting acknowledgement" };

export function isAckFilter(v: string | null | undefined): v is AckFilter {
  return v === "acknowledged" || v === "awaiting";
}

export type SubmissionState = "sent" | "resent" | "reopened" | "closed";

export const SUBMISSION_STATES: Record<SubmissionState, { label: string; tone: Tone; hint: string }> = {
  sent: { label: "Sent", tone: "success", hint: "Latest report sent for this case." },
  resent: { label: "Superseded", tone: "neutral", hint: "A later submission exists for this case." },
  reopened: { label: "Reopened", tone: "warning", hint: "The case is being worked on again after this was sent." },
  closed: { label: "Closed", tone: "neutral", hint: "The case is closed. A closed case is final." },
};

const ACTIVE: CaseStatus[] = ["received", "intake_confirmed", "assigned", "field_in_progress", "office_review", "orchestrator_review"];

/**
 * A submission is superseded when its case has a later one; the latest is "reopened" when reopen_case() marked it
 * (or the case is active again after sending), "closed" when the case is closed, else "sent".
 */
export function submissionState(
  row: { id: string; submitted_at: string; reopened_at?: string | null },
  caseStatus: CaseStatus,
  latestByCase: string | undefined,
): SubmissionState {
  if (latestByCase && latestByCase !== row.id) return "resent";
  if (row.reopened_at || ACTIVE.includes(caseStatus)) return "reopened";
  return caseStatus === "closed" ? "closed" : "sent";
}

// ---------------------------------------------------------------------
// Actions (app/(app)/submissions/actions.ts): acknowledgement, portal / other submission, reopen
// ---------------------------------------------------------------------
/** Channels recorded by hand; email submissions are recorded by the sender (8.2). */
export const MANUAL_CHANNELS = ["portal", "other"] as const satisfies readonly Channel[];
export const FORMATS = ["pdf", "docx"] as const;

/**
 * Actions on a row: acknowledgement while none is recorded; reopen and close on the latest submission of a submitted
 * case. Close needs the acknowledgement, except for orchestrators / admins (`canCloseWithoutAck`), who give a reason
 * (close_case; the database re-checks all of it, including that no field work is open).
 */
export function rowActions(input: {
  canManage: boolean;
  acknowledged: boolean;
  state: SubmissionState;
  caseStatus: CaseStatus;
  canCloseWithoutAck?: boolean;
}): {
  ack: boolean;
  reopen: boolean;
  close: false | "acknowledged" | "without_ack";
} {
  const latestSubmitted = input.canManage && input.state === "sent" && input.caseStatus === "submitted";
  return {
    ack: input.canManage && !input.acknowledged,
    reopen: latestSubmitted,
    close: !latestSubmitted ? false : input.acknowledged ? "acknowledged" : input.canCloseWithoutAck ? "without_ack" : false,
  };
}

/** Orchestrators and admins may close a submitted case without the insurer's acknowledgement (with a reason). */
export function canCloseWithoutAck(role: string): boolean {
  return role === "orchestrator" || role === "admin";
}

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `Keep the ${label} under ${max} characters.` })
    .transform((v) => (v ? v : null));

/** "" = now; else a datetime-local value read as India time. */
const istTime = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return null;
    const d = parseIstDateTime(v);
    if (!d) {
      ctx.addIssue({ code: "custom", message: "Enter a date and time." });
      return z.NEVER;
    }
    return d.toISOString();
  });

const Guid = z.guid();

export const AckInput = z.object({
  submission_id: Guid,
  ack_at: istTime,
  insurer_reference: optionalText(200, "reference"),
  note: optionalText(1000, "note"),
});

export const ManualInput = z
  .object({
    case_ref: z.string().trim().regex(/^[A-Za-z0-9_\-/]{3,40}$/, { message: "Enter the case reference, e.g. INV-2026-000123." }),
    channel: z.enum(MANUAL_CHANNELS, { message: "Choose portal or other." }),
    formats: z.array(z.enum(FORMATS)).min(1, { message: "Choose the formats that were delivered." }),
    submitted_at: istTime,
    insurer_reference: optionalText(200, "reference"),
    note: optionalText(1000, "note"),
  })
  .refine((v) => v.channel !== "portal" || v.insurer_reference, { message: "Enter the portal reference number.", path: ["insurer_reference"] })
  .refine((v) => v.channel !== "other" || v.note, { message: "Say how the report was delivered.", path: ["note"] });

export const ReopenInput = z.object({
  case_id: Guid,
  reason: z.string().trim().min(3, { message: "Say what the insurer asked for (at least 3 characters)." }).max(500, { message: "Keep the reason under 500 characters." }),
});

/** close_case(p_case_id, p_note): the note is optional with an acknowledgement, a 3-500 character reason without. */
export const CloseInput = z
  .object({
    case_id: Guid,
    without_ack: z.boolean(),
    note: z.string().trim().max(500, { message: "Keep the note under 500 characters." }),
  })
  .refine((v) => !v.without_ack || v.note.length >= 3, {
    message: "Say why the case is closed without the insurer's acknowledgement (at least 3 characters).",
    path: ["note"],
  });

/** First validation message of a failed parse. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

/** Only redirect back to the submissions list (keeps its filters). */
export function safeBack(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return /^\/submissions(\?[^\s]*)?$/.test(s) && !s.includes("//") ? s : "/submissions";
}

/** Latest submission id per case among rows of the same cases. */
export function latestPerCase(rows: { id: string; case_id: string; submitted_at: string }[]): Map<string, string> {
  const best = new Map<string, { id: string; at: string }>();
  for (const r of rows) {
    const b = best.get(r.case_id);
    if (!b || r.submitted_at > b.at || (r.submitted_at === b.at && r.id > b.id)) best.set(r.case_id, { id: r.id, at: r.submitted_at });
  }
  return new Map([...best].map(([k, v]) => [k, v.id]));
}

/** "a@x.in +2" for the table; the full list goes into the title attribute. */
export function recipientsSummary(to: string[] | null | undefined, cc: string[] | null | undefined): { short: string; full: string } {
  const t = to ?? [];
  const c = cc ?? [];
  if (!t.length && !c.length) return { short: "—", full: "" };
  const all = [...t, ...c];
  const short = all.length === 1 ? all[0] : `${all[0]} +${all.length - 1}`;
  const full = [t.length ? `To: ${t.join(", ")}` : "", c.length ? `Cc: ${c.join(", ")}` : ""].filter(Boolean).join("\n");
  return { short, full };
}

export function formatsLabel(formats: string[] | null | undefined): string {
  const f = (formats ?? []).map((x) => x.toUpperCase());
  return f.length ? f.join(", ") : "—";
}
