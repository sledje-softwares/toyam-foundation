/**
 * Dashboard (M9): pure shaping helpers. No React, no Next, no Supabase, so they are unit-tested.
 * Days are IST calendar days, like lib/format.ts.
 */

const TZ = "Asia/Kolkata";
const DAY_MS = 86_400_000;

export const CLOSED_STATUSES = ["submitted", "closed", "cancelled"] as const;
/** PostgREST `in` list for "not open". */
export const CLOSED_STATUS_LIST = `(${CLOSED_STATUSES.join(",")})`;

export const ESCALATION_KINDS = ["case_unassigned", "no_field_task", "intake_retry_stuck"] as const;

/** Rows read per block; reaching it means the numbers are partial. */
export const ROW_CAP = 5000;

function istDay(d: Date): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .split("-")
    .map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]) / DAY_MS;
}

// ---------------------------------------------------------------------
// Ageing vs TAT
// ---------------------------------------------------------------------
export type Bucket = "ontime" | "today" | "1-2" | "3plus" | "none";

export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "ontime", label: "On time" },
  { key: "today", label: "Due today" },
  { key: "1-2", label: "Overdue 1-2 days" },
  { key: "3plus", label: "Overdue 3+ days" },
  { key: "none", label: "No due date" },
];

/** Bucket of a due date relative to `now`, by IST calendar day. */
export function bucketFor(due: string | null | undefined, now: Date = new Date()): Bucket {
  if (!due) return "none";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "none";
  const late = istDay(now) - istDay(d);
  if (late < 0) return "ontime";
  if (late === 0) return "today";
  return late <= 2 ? "1-2" : "3plus";
}

export type BucketCounts = Record<Bucket, number>;

export function emptyBuckets(): BucketCounts {
  return { ontime: 0, today: 0, "1-2": 0, "3plus": 0, none: 0 };
}

export function overdueTotal(c: BucketCounts): number {
  return c["1-2"] + c["3plus"];
}

export type AgeingRow = { insurerId: string; name: string; counts: BucketCounts; total: number };

/** Open cases per insurer and bucket; insurers sorted by overdue count, then name. */
export function ageingByInsurer(
  cases: { insurer_id: string; due_at: string | null }[],
  insurers: { id: string; name: string }[],
  now: Date = new Date(),
): AgeingRow[] {
  const names = new Map(insurers.map((i) => [i.id, i.name]));
  const rows = new Map<string, AgeingRow>();
  for (const c of cases) {
    let r = rows.get(c.insurer_id);
    if (!r) {
      r = { insurerId: c.insurer_id, name: names.get(c.insurer_id) ?? "Unknown", counts: emptyBuckets(), total: 0 };
      rows.set(c.insurer_id, r);
    }
    r.counts[bucketFor(c.due_at, now)] += 1;
    r.total += 1;
  }
  return [...rows.values()].sort(
    (a, b) => overdueTotal(b.counts) - overdueTotal(a.counts) || a.name.localeCompare(b.name),
  );
}

export function totalBuckets(rows: AgeingRow[]): BucketCounts {
  const t = emptyBuckets();
  for (const r of rows) for (const b of BUCKETS) t[b.key] += r.counts[b.key];
  return t;
}

// ---------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------
export type WorkloadRow = { id: string | null; name: string; count: number };

/**
 * Counts per person. People with no work are kept (a zero is useful when assigning); `unassignedLabel`
 * adds a first row for items with no owner when there are any. Sorted by count (high first), then name.
 */
export function workload(
  items: (string | null)[],
  people: { id: string; full_name: string }[],
  unassignedLabel?: string,
): WorkloadRow[] {
  const counts = new Map<string, number>();
  let none = 0;
  for (const id of items) {
    if (id === null) none += 1;
    else counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rows: WorkloadRow[] = people.map((p) => ({ id: p.id, name: p.full_name, count: counts.get(p.id) ?? 0 }));
  const known = new Set(people.map((p) => p.id));
  for (const [id, count] of counts) if (!known.has(id)) rows.push({ id, name: "Former user", count });
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (unassignedLabel && none > 0) rows.unshift({ id: null, name: unassignedLabel, count: none });
  return rows;
}

// ---------------------------------------------------------------------
// Turnaround per stage
// ---------------------------------------------------------------------
export type HistoryRow = { case_id: string; to_status: string; changed_at: string };
export type StageStat = { stage: string; cases: number; medianMs: number; meanMs: number };

export const STAGE_ORDER = [
  "received",
  "intake_confirmed",
  "assigned",
  "field_in_progress",
  "office_review",
  "orchestrator_review",
] as const;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Time spent in each status: for every case, the gap between a change into a status and the next change.
 * The latest change of a case has no end yet and is skipped. Each stay counts once (a case that returns to a
 * stage adds another sample). Stages follow STAGE_ORDER, unknown ones after.
 */
export function stageTurnaround(history: HistoryRow[]): StageStat[] {
  const byCase = new Map<string, HistoryRow[]>();
  for (const h of history) {
    const l = byCase.get(h.case_id);
    if (l) l.push(h);
    else byCase.set(h.case_id, [h]);
  }
  const samples = new Map<string, number[]>();
  for (const rows of byCase.values()) {
    rows.sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
    for (let i = 0; i + 1 < rows.length; i++) {
      const ms = Date.parse(rows[i + 1].changed_at) - Date.parse(rows[i].changed_at);
      if (!Number.isFinite(ms) || ms < 0) continue;
      const l = samples.get(rows[i].to_status);
      if (l) l.push(ms);
      else samples.set(rows[i].to_status, [ms]);
    }
  }
  const rank = (s: string) => {
    const i = (STAGE_ORDER as readonly string[]).indexOf(s);
    return i === -1 ? STAGE_ORDER.length : i;
  };
  return [...samples.entries()]
    .map(([stage, v]) => ({
      stage,
      cases: v.length,
      medianMs: median(v),
      meanMs: v.reduce((a, b) => a + b, 0) / v.length,
    }))
    .sort((a, b) => rank(a.stage) - rank(b.stage) || a.stage.localeCompare(b.stage));
}

/** "45 min", "3 h 20 min", "2 d 4 h"; "—" for no data. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// ---------------------------------------------------------------------
// Links (documented in docs/12-office-pages/dashboard.md)
// ---------------------------------------------------------------------
/** `/cases?scope=open&…`; empty values are skipped. */
export function casesLink(params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams({ scope: "open" });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `/cases?${q.toString()}`;
}

/** `owner=none` on /cases means "no office owner". */
export const OWNER_NONE = "none";
