/**
 * Case list and case detail (4.6, 4.2, 4.7): pure helpers. No React, no Next, no Supabase, so they are unit-tested.
 * Design: docs/12-office-pages/cases.md.
 */

import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";

export type CaseStatus = Enums<"case_status">;

export const CASE_STATUSES = [
  "received",
  "assigned",
  "field_in_progress",
  "office_review",
  "orchestrator_review",
  "submitted",
  "closed",
  "cancelled",
  "intake_confirmed",
] as const satisfies readonly CaseStatus[];

/** Work is finished: no due-date pressure, no reassignment from the UI. */
export const TERMINAL_STATUSES = ["submitted", "closed", "cancelled"] as const satisfies readonly CaseStatus[];
export const OPEN_STATUSES = CASE_STATUSES.filter((s) => !(TERMINAL_STATUSES as readonly string[]).includes(s));

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGuid(v: string | null | undefined): v is string {
  return !!v && GUID.test(v);
}

/** Case refs are generated as INV-YYYY-000123; anything URL-safe and short is looked up, the rest is a 404. */
export function isCaseRef(v: string | null | undefined): v is string {
  return !!v && /^[A-Za-z0-9._-]{1,64}$/.test(v);
}

export function caseHref(ref: string, tab?: "thread" | "evidence" | "history"): string {
  const base = `/cases/${encodeURIComponent(ref)}`;
  return tab ? `${base}/${tab}` : base;
}

/** Links to the task form (built in /tasks). */
export function newTaskHref(ref: string, kind?: "re_investigation"): string {
  const p = new URLSearchParams({ case: ref });
  if (kind) p.set("kind", kind);
  return `/tasks/new?${p.toString()}`;
}

function first(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

// ---------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------
export type StatusFilter = { kind: "open" } | { kind: "all" } | { kind: "one"; status: CaseStatus };

/** Status filter from the URL: empty = open cases (the default), `all`, or one status. */
export function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const v = first(raw);
  if (v === "all") return { kind: "all" };
  if ((CASE_STATUSES as readonly string[]).includes(v)) return { kind: "one", status: v as CaseStatus };
  return { kind: "open" };
}

export type OwnerFilter = { kind: "me" } | { kind: "none" } | { kind: "user"; id: string } | null;

export function parseOwnerFilter(raw: string | string[] | undefined): OwnerFilter {
  const v = first(raw);
  if (v === "me") return { kind: "me" };
  if (v === "none") return { kind: "none" };
  if (isGuid(v)) return { kind: "user", id: v };
  return null;
}

export const DUE_FILTERS = {
  overdue: "Overdue",
  soon: "Due within 2 days",
  on_track: "On track",
  none: "No due date",
} as const;
export type DueFilter = keyof typeof DUE_FILTERS;

export function parseDueFilter(raw: string | string[] | undefined): DueFilter | null {
  const v = first(raw);
  return Object.hasOwn(DUE_FILTERS, v) ? (v as DueFilter) : null;
}

/** "Due soon" window. */
export const SOON_HOURS = 48;
const HOUR = 3_600_000;

export type DueCondition = { op: "lt" | "gte" | "lte" | "gt"; value: string } | { op: "is_null" };

/**
 * Conditions on `cases.due_at` for a due filter. `overdue` and `soon` also need open statuses
 * (`openOnly`), because a submitted case past its due date is not overdue.
 */
export function dueConditions(due: DueFilter, now: Date): { conditions: DueCondition[]; openOnly: boolean } {
  const nowIso = now.toISOString();
  const soonIso = new Date(now.getTime() + SOON_HOURS * HOUR).toISOString();
  switch (due) {
    case "overdue":
      return { conditions: [{ op: "lt", value: nowIso }], openOnly: true };
    case "soon":
      return { conditions: [{ op: "gte", value: nowIso }, { op: "lte", value: soonIso }], openOnly: true };
    case "on_track":
      return { conditions: [{ op: "gt", value: soonIso }], openOnly: false };
    case "none":
      return { conditions: [{ op: "is_null" }], openOnly: false };
  }
}

// ---------------------------------------------------------------------
// Ageing vs TAT
// ---------------------------------------------------------------------
export type DueState = { kind: "done" | "none" | "overdue" | "soon" | "on_track"; label: string; tone: Tone };

function span(ms: number): string {
  const hours = Math.max(1, Math.ceil(ms / HOUR));
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Badge for a case's due date against now. Finished cases have no due pressure. */
export function dueState(dueAt: string | null | undefined, status: string, now: Date): DueState {
  if (isTerminal(status)) return { kind: "done", label: "—", tone: "neutral" };
  const due = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (!Number.isFinite(due)) return { kind: "none", label: "No due date", tone: "neutral" };
  const diff = due - now.getTime();
  if (diff < 0) return { kind: "overdue", label: `Overdue ${span(-diff)}`, tone: "danger" };
  if (diff <= SOON_HOURS * HOUR) return { kind: "soon", label: `Due in ${span(diff)}`, tone: "warning" };
  return { kind: "on_track", label: `Due in ${span(diff)}`, tone: "success" };
}

/** Whole days a case has been open (received → now, or → closed). */
export function ageDays(receivedAt: string, closedAt: string | null | undefined, now: Date): number {
  const end = closedAt ? Date.parse(closedAt) : now.getTime();
  return Math.max(0, Math.floor((end - Date.parse(receivedAt)) / (24 * HOUR)));
}

// ---------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------
export const AVAILABILITY_LABELS: Record<Enums<"staff_availability">, string> = {
  available: "Available",
  on_leave: "On leave",
  unavailable: "Unavailable",
};

export type StaffOption = {
  id: string;
  full_name: string;
  role: Enums<"user_role">;
  availability: Enums<"staff_availability">;
  availability_until: string | null;
  max_open_cases: number | null;
};

/** On leave until a date that has passed counts as available (same rule as private.is_assignable). */
export function isAvailable(p: Pick<StaffOption, "availability" | "availability_until">, now: Date): boolean {
  return p.availability === "available" || (!!p.availability_until && Date.parse(p.availability_until) <= now.getTime());
}

/** "N Office · 7 open · On leave" — the select shows load and availability so the orchestrator can choose. */
export function assigneeLabel(p: StaffOption, openCases: number, now: Date): string {
  const parts = [p.full_name, `${openCases} open${p.max_open_cases ? ` of ${p.max_open_cases}` : ""}`];
  if (!isAvailable(p, now)) parts.push(AVAILABILITY_LABELS[p.availability]);
  if (p.role !== "office") parts.push(p.role === "admin" ? "Admin" : "Orchestrator");
  return parts.join(" · ");
}

/** Assignees for the reassign select: available first, then by load and name; the current owner is left out. */
export function assigneeOptions(
  staff: StaffOption[],
  openCounts: ReadonlyMap<string, number>,
  currentOwnerId: string | null,
  now: Date,
): { value: string; label: string }[] {
  return staff
    .filter((p) => p.id !== currentOwnerId)
    .sort(
      (a, b) =>
        Number(isAvailable(b, now)) - Number(isAvailable(a, now)) ||
        (openCounts.get(a.id) ?? 0) - (openCounts.get(b.id) ?? 0) ||
        a.full_name.localeCompare(b.full_name),
    )
    .map((p) => ({ value: p.id, label: assigneeLabel(p, openCounts.get(p.id) ?? 0, now) }));
}

export const REASON_MIN = 3;

/** What the case server actions return; the client shows `message` as a toast on success. */
export type CaseActionResult = { error: string | null; fieldErrors: Record<string, string>; message?: string };
export const REASON_MAX = 500;

// ---------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------
export const MESSAGE_MAX = 4000;
export type ComposerMode = "staff" | "field";

export function parseComposerMode(v: unknown): ComposerMode | null {
  return v === "staff" || v === "field" ? v : null;
}

export const THREAD_LIMIT = 200;

/** Newest `limit` messages come back newest first; the thread reads oldest → newest. */
export function chronological<T extends { created_at: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------
export const CAPTURE_SOURCE_LABELS: Record<Enums<"capture_source">, string> = {
  camera: "Camera",
  gallery: "Gallery",
  share: "Shared",
  web_upload: "Web upload",
  email_attachment: "Insurer email",
};

export const PROCESSING_LABELS: Record<string, { label: string; tone: Tone }> = {
  none: { label: "Not queued", tone: "neutral" },
  pending: { label: "Queued", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
  done: { label: "Processed", tone: "success" },
};

export type EvidenceSourceFilter = "field" | "email" | null;
export function parseEvidenceSource(raw: string | string[] | undefined): EvidenceSourceFilter {
  const v = first(raw);
  return v === "field" || v === "email" ? v : null;
}

/** "1.2 MB" style size. */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------
// Field tasks
// ---------------------------------------------------------------------
export type ChecklistRow = { task_id: string | null; status: string | null; is_mandatory: boolean | null; evidence_count: number | null };
export type ChecklistProgress = { done: number; total: number; mandatoryMissing: number };

/** Per task: an item is done when ticked (any status but pending) or when files are linked / matched by label (D41). */
export function checklistProgress(rows: ChecklistRow[]): Map<string, ChecklistProgress> {
  const out = new Map<string, ChecklistProgress>();
  for (const r of rows) {
    if (!r.task_id) continue;
    const p = out.get(r.task_id) ?? { done: 0, total: 0, mandatoryMissing: 0 };
    const done = (r.status !== null && r.status !== "pending") || (r.evidence_count ?? 0) > 0;
    p.total += 1;
    if (done) p.done += 1;
    else if (r.is_mandatory) p.mandatoryMissing += 1;
    out.set(r.task_id, p);
  }
  return out;
}

export const TASK_KIND_LABELS: Record<Enums<"task_kind">, string> = {
  initial: "Initial",
  re_investigation: "Re-investigation",
  office: "Office",
  other: "Other",
};

// ---------------------------------------------------------------------
// Intake fields
// ---------------------------------------------------------------------
export type IntakeFieldDef = {
  id: string;
  key: string;
  label: string;
  position: number;
  section_position: number;
  section_title: string | null;
};

export type IntakeFieldRow = { key: string; label: string; section: string | null; value: string | null; source: string | null };

/** Template intake fields in template order with the case's values (missing → null). */
export function intakeFieldRows(
  defs: IntakeFieldDef[],
  values: { field_id: string; value: string | null; source: string | null }[],
): IntakeFieldRow[] {
  const byField = new Map(values.map((v) => [v.field_id, v]));
  return [...defs]
    .sort((a, b) => a.section_position - b.section_position || a.position - b.position)
    .map((d) => {
      const v = byField.get(d.id);
      const value = v?.value?.trim() ? v.value : null;
      return { key: d.key, label: d.label, section: d.section_title, value, source: value ? (v?.source ?? null) : null };
    });
}

export const FIELD_SOURCE_LABELS: Record<Enums<"field_value_source">, string> = {
  email_parser: "From email",
  llm: "AI",
  office: "Entered",
  suggestion: "From a file",
};

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
export type StatusHistoryRow = { id: number; changed_at: string; from_status: string | null; to_status: string; note: string | null; actor: string | null };
export type AssignmentRow = { id: number; assigned_at: string; method: string; reason: string | null; assignee: string | null; actor: string | null };
export type FieldChangeRow = { changed_at: string; actor_name: string | null; action: string; field_key: string | null; old_value: string | null; new_value: string | null };

export type HistoryEntry = {
  key: string;
  at: string;
  kind: "status" | "assignment" | "field";
  actor: string | null;
  title: string;
  detail: string | null;
};

const STATUS_WORDS: Record<string, string> = {
  received: "Received",
  intake_confirmed: "Intake confirmed",
  assigned: "Assigned",
  field_in_progress: "In the field",
  office_review: "Office review",
  orchestrator_review: "Awaiting approval",
  submitted: "Submitted",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function statusWord(s: string | null): string {
  return s ? (STATUS_WORDS[s] ?? s) : "—";
}

function clip(v: string | null, max = 120): string {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(empty)";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** One timeline, newest first: status changes, assignments and field-value changes. */
export function buildHistory(status: StatusHistoryRow[], assignments: AssignmentRow[], fields: FieldChangeRow[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const s of status) {
    out.push({
      key: `s${s.id}`,
      at: s.changed_at,
      kind: "status",
      actor: s.actor,
      title: s.from_status ? `Status ${statusWord(s.from_status)} → ${statusWord(s.to_status)}` : `Status ${statusWord(s.to_status)}`,
      detail: s.note,
    });
  }
  for (const a of assignments) {
    out.push({
      key: `a${a.id}`,
      at: a.assigned_at,
      kind: "assignment",
      actor: a.method === "auto" ? null : a.actor,
      title: `${a.method === "auto" ? "Assigned automatically" : "Assigned"} to ${a.assignee ?? "staff"}`,
      detail: a.reason && a.reason !== "Automatic assignment" ? a.reason : null,
    });
  }
  fields.forEach((f, i) => {
    const what = f.field_key ?? "field";
    out.push({
      key: `f${i}`,
      at: f.changed_at,
      kind: "field",
      actor: f.actor_name,
      title: f.action === "INSERT" ? `Set ${what}` : f.action === "DELETE" ? `Cleared ${what}` : `Changed ${what}`,
      detail: f.action === "INSERT" ? clip(f.new_value) : f.action === "DELETE" ? clip(f.old_value) : `${clip(f.old_value)} → ${clip(f.new_value)}`,
    });
  });
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}
