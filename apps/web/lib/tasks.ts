/**
 * Office Tasks pages (4.3, 4.4; docs/12-office-pages/tasks.md): pure helpers for the list, the detail page and the
 * assign form. No React, no Next, no Supabase, so they are unit-tested.
 */
import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";
import { formatDate } from "./format";

export type TaskKind = Enums<"task_kind">;
export type TaskStatus = Enums<"task_status">;
export type CaseStatus = Enums<"case_status">;
type UserRole = Enums<"user_role">;

export const TASK_KINDS: readonly TaskKind[] = ["initial", "re_investigation", "other", "office"];
export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed", "cancelled"];
export const OPEN_STATUSES: readonly TaskStatus[] = ["pending", "in_progress"];

export const TASK_KIND_LABELS: Record<TaskKind, { label: string; tone: Tone }> = {
  initial: { label: "First visit", tone: "neutral" },
  re_investigation: { label: "Re-investigation", tone: "warning" },
  other: { label: "Additional field work", tone: "neutral" },
  office: { label: "Office", tone: "neutral" },
};

export function isTaskKind(v: string | null | undefined): v is TaskKind {
  return !!v && (TASK_KINDS as readonly string[]).includes(v);
}

export function isOpen(status: string | null | undefined): boolean {
  return !!status && (OPEN_STATUSES as readonly string[]).includes(status);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGuid(v: string | null | undefined): v is string {
  return !!v && GUID.test(v);
}

/** Case references as generated (e.g. INV-2026-000123); anything else in the URL is ignored. */
const CASE_REF = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/;
export function isCaseRef(v: string | null | undefined): v is string {
  return !!v && CASE_REF.test(v);
}

export function caseHref(caseRef: string): string {
  return `/cases/${encodeURIComponent(caseRef)}`;
}

// ---------------------------------------------------------------------
// List filters (URL params)
// ---------------------------------------------------------------------
function first(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

/** `status`: "" = open (default), one status, or "all" (null = no filter). */
export function parseStatusFilter(raw: string | string[] | undefined): { value: string; statuses: TaskStatus[] | null } {
  const v = first(raw);
  if (v === "all") return { value: "all", statuses: null };
  if ((TASK_STATUSES as readonly string[]).includes(v)) return { value: v, statuses: [v as TaskStatus] };
  return { value: "", statuses: [...OPEN_STATUSES] };
}

export type Scope = "mine" | "all";

/**
 * `scope`: orchestrators and admins default to all cases and may narrow to their own.
 * Office staff only ever see tasks of the cases assigned to them (D44, enforced by RLS), so their scope is always "mine".
 */
export function defaultScope(role: UserRole): Scope {
  return role === "office" ? "mine" : "all";
}

export function parseScope(raw: string | string[] | undefined, role: UserRole): Scope {
  if (role === "office") return "mine";
  const v = first(raw);
  return v === "mine" || v === "all" ? v : defaultScope(role);
}

/** Office staff have no case-scope choice (D44); orchestrators and admins switch between all cases and their own. */
export function hasScopeChoice(role: UserRole): boolean {
  return role !== "office";
}

export const DUE_FILTERS = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due in 7 days",
  none: "No due date",
} as const;
export type DueFilter = keyof typeof DUE_FILTERS;

export function isDueFilter(v: string | null | undefined): v is DueFilter {
  return !!v && v in DUE_FILTERS;
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000; // India has no daylight saving time

/** Start of the IST calendar day containing `now`, as a UTC instant. */
export function istDayStart(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

export type DueBounds = { gte?: string; lt?: string; isNull?: true; openOnly?: true };

/** Query bounds on tasks.due_at for a due filter. "Overdue" also limits to open tasks. */
export function dueBounds(f: DueFilter, now: Date): DueBounds {
  switch (f) {
    case "overdue":
      return { lt: now.toISOString(), openOnly: true };
    case "today": {
      const start = istDayStart(now);
      return { gte: start.toISOString(), lt: new Date(start.getTime() + DAY_MS).toISOString() };
    }
    case "week":
      return { gte: now.toISOString(), lt: new Date(now.getTime() + 7 * DAY_MS).toISOString() };
    case "none":
      return { isNull: true };
  }
}

export function isOverdue(t: { status: string; due_at: string | null }, now: Date): boolean {
  return isOpen(t.status) && !!t.due_at && Date.parse(t.due_at) < now.getTime();
}

// ---------------------------------------------------------------------
// Checklist progress (v_case_checklist; D41: an item ticks when matched evidence exists)
// ---------------------------------------------------------------------
export type ChecklistRow = { status: string; is_mandatory: boolean; evidence_count: number | null };

export function itemDone(i: ChecklistRow): boolean {
  return i.status !== "pending" || (i.evidence_count ?? 0) > 0;
}

export function checklistProgress(items: ChecklistRow[]) {
  const mandatory = items.filter((i) => i.is_mandatory);
  return {
    done: items.filter(itemDone).length,
    total: items.length,
    mandatoryDone: mandatory.filter(itemDone).length,
    mandatoryTotal: mandatory.length,
  };
}

/** "3 / 5" for the list (all items), or null when the task has no checklist. */
export function progressLabel(items: ChecklistRow[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  const p = checklistProgress(items);
  return `${p.done} / ${p.total}`;
}

// ---------------------------------------------------------------------
// Late uploads (D43, task_holds)
// ---------------------------------------------------------------------
export type HoldWindow =
  | { state: "current" }
  | { state: "late_open"; until: Date }
  | { state: "late_closed"; until: Date };

/**
 * Deadline for files captured during a hold, as in private.field_upload_allowed(): an ended hold accepts them until
 * held_until + grace (when it ended before any deactivation); a deactivated operator's phone may drain them until
 * deactivated_at + drain window; the earlier deadline wins. No deadline = the hold is current.
 */
export function lateUploadWindow(
  h: { held_until: string | null; deactivated_at?: string | null },
  graceHours: number,
  now: Date,
  drainDays = 7,
): HoldWindow {
  const ended = h.held_until ? Date.parse(h.held_until) : null;
  const deact = h.deactivated_at ? Date.parse(h.deactivated_at) : null;
  const deadlines = [
    ended !== null && (deact === null || ended <= deact) ? ended + graceHours * 3_600_000 : null,
    deact !== null ? deact + drainDays * DAY_MS : null,
  ].filter((d): d is number => d !== null);
  if (deadlines.length === 0) return { state: "current" };
  const until = new Date(Math.min(...deadlines));
  return until.getTime() > now.getTime() ? { state: "late_open", until } : { state: "late_closed", until };
}

/** app_settings.value is jsonb; the number may come back as a number or a string. */
export function settingInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------
// Assign form helpers
// ---------------------------------------------------------------------
/**
 * Cases that are submitted, closed or cancelled take no new field work (D46: a submitted case is reopened from
 * Submissions when the insurer asks, then work can be assigned again). Same rule as create_field_task().
 */
export function canRaiseTask(caseStatus: string): boolean {
  return caseStatus !== "submitted" && caseStatus !== "closed" && caseStatus !== "cancelled";
}

/** Why a case takes no new field work, for the blocking notice (null when it does). */
export function noFieldWorkReason(caseStatus: string): string | null {
  if (caseStatus === "submitted") return "This case was submitted. Reopen it from Submissions when the insurer asks.";
  if (caseStatus === "closed" || caseStatus === "cancelled") return "It is closed or cancelled.";
  return null;
}

/** First visit when the case has no earlier field task (cancelled ones do not count), else additional work. */
export function defaultKind(previous: { kind: string; status: string }[]): "initial" | "other" {
  const field = previous.filter((t) => t.kind !== "office" && t.status !== "cancelled");
  return field.length === 0 ? "initial" : "other";
}

/** Open (pending / in progress) tasks per assignee. */
export function openTaskCounts(rows: { assignee_id: string | null; status?: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.assignee_id || (r.status !== undefined && !isOpen(r.status))) continue;
    m.set(r.assignee_id, (m.get(r.assignee_id) ?? 0) + 1);
  }
  return m;
}

/** "On leave until 18 Nov 2026" / "Unavailable", or null when available (or the until date has passed). */
export function availabilityNote(availability: string | null | undefined, until: string | null | undefined, now: Date): string | null {
  if (!availability || availability === "available") return null;
  if (until && Date.parse(until) <= now.getTime()) return null;
  const label = availability === "on_leave" ? "On leave" : "Unavailable";
  return until ? `${label} until ${formatDate(until)}` : label;
}

export type ChecklistOption = { id: string; name: string; items: number; is_default: boolean };

/** Linked checklists first by default flag, then name. */
export function sortChecklistOptions(opts: ChecklistOption[]): ChecklistOption[] {
  return [...opts].sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name));
}
