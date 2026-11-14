/**
 * Submissions list (8.5): pure helpers. No React, no Next, no Supabase (lib/submissions.test.ts).
 * Design: docs/12-office-pages/reports.md.
 */

import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";

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

export type SubmissionState = "sent" | "resent" | "reopened";

export const SUBMISSION_STATES: Record<SubmissionState, { label: string; tone: Tone; hint: string }> = {
  sent: { label: "Sent", tone: "success", hint: "Latest report sent for this case." },
  resent: { label: "Superseded", tone: "neutral", hint: "A later submission exists for this case." },
  reopened: { label: "Reopened", tone: "warning", hint: "The case is being worked on again after this was sent." },
};

const ACTIVE: CaseStatus[] = ["received", "intake_confirmed", "assigned", "field_in_progress", "office_review", "orchestrator_review"];

/**
 * A submission is superseded when its case has a later one; the latest is "reopened" when the case went back to
 * an active status after sending (needs reopen, gap G8), else "sent".
 */
export function submissionState(row: { id: string; submitted_at: string }, caseStatus: CaseStatus, latestByCase: string | undefined): SubmissionState {
  if (latestByCase && latestByCase !== row.id) return "resent";
  return ACTIVE.includes(caseStatus) ? "reopened" : "sent";
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
