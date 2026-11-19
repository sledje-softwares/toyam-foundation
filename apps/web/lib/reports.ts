/**
 * Reports list and report workspace (M7 structure, 8.1): pure helpers shared by the pages and their
 * server actions. No React, no Next, no Supabase, so they are unit-tested (lib/reports.test.ts).
 * Design: docs/12-office-pages/reports.md.
 */

import type { CachedFile } from "@/lib/file-cache/view-core";
import type { Tone } from "@/components/ui/badge";
import type { Enums } from "@/lib/database.types";

type CaseStatus = Enums<"case_status">;
type UserRole = Enums<"user_role">;
type ApprovalDecision = Enums<"approval_decision">;
type FieldSource = Enums<"field_value_source">;
export type FieldType = Enums<"template_field_type">;

// ---------------------------------------------------------------------
// Stages (derived; no new case statuses — rule 1)
// ---------------------------------------------------------------------
export type ReportStage = "in_progress" | "awaiting_approval" | "approved" | "sent";

export const REPORT_STAGES: Record<ReportStage, { label: string; tone: Tone }> = {
  in_progress: { label: "In progress", tone: "info" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  sent: { label: "Sent", tone: "neutral" },
};

export const REPORT_STAGE_KEYS = Object.keys(REPORT_STAGES) as ReportStage[];

/** Case statuses per stage. awaiting_approval and approved share orchestrator_review (split by approvals). */
export const STAGE_STATUSES: Record<ReportStage, CaseStatus[]> = {
  in_progress: ["received", "intake_confirmed", "assigned", "field_in_progress", "office_review"],
  awaiting_approval: ["orchestrator_review"],
  approved: ["orchestrator_review"],
  sent: ["submitted", "closed"],
};

/** Every status the reports list shows (cancelled cases are left out). */
export const LISTED_STATUSES: CaseStatus[] = [...STAGE_STATUSES.in_progress, "orchestrator_review", ...STAGE_STATUSES.sent];

export function isReportStage(v: string | null | undefined): v is ReportStage {
  return !!v && (REPORT_STAGE_KEYS as string[]).includes(v);
}

export type ApprovalLite = { decision: ApprovalDecision; requested_at: string };

/** The approval requested last (approvals are per report version; the newest is the one that counts). */
export function latestApproval<A extends ApprovalLite>(approvals: A[] | null | undefined): A | null {
  let best: A | null = null;
  for (const a of approvals ?? []) if (!best || a.requested_at > best.requested_at) best = a;
  return best;
}

export function reportStage(status: CaseStatus, approvals: ApprovalLite[] | null | undefined): ReportStage | null {
  if ((STAGE_STATUSES.sent as string[]).includes(status)) return "sent";
  if (status === "orchestrator_review") {
    const last = latestApproval(approvals);
    return last?.decision === "approved" ? "approved" : "awaiting_approval";
  }
  if ((STAGE_STATUSES.in_progress as string[]).includes(status)) return "in_progress";
  return null; // cancelled
}

// ---------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------
export type ProgressRow = { case_id: string; required_total: number | null; required_filled: number | null; fields_total: number | null; fields_filled: number | null };
export type Progress = { requiredTotal: number; requiredFilled: number; fieldsTotal: number; fieldsFilled: number };

/** Sums v_report_progress rows (one per section) per case. */
export function sumProgress(rows: ProgressRow[]): Map<string, Progress> {
  const out = new Map<string, Progress>();
  for (const r of rows) {
    const p = out.get(r.case_id) ?? { requiredTotal: 0, requiredFilled: 0, fieldsTotal: 0, fieldsFilled: 0 };
    p.requiredTotal += r.required_total ?? 0;
    p.requiredFilled += r.required_filled ?? 0;
    p.fieldsTotal += r.fields_total ?? 0;
    p.fieldsFilled += r.fields_filled ?? 0;
    out.set(r.case_id, p);
  }
  return out;
}

// ---------------------------------------------------------------------
// Values: storage format per field type (stored as text in case_field_values.value)
// ---------------------------------------------------------------------
export const FIELD_PREFIX = "f:"; // submitted value(s)
export const ORIGINAL_PREFIX = "o:"; // value as loaded (conflict check)
export const PRESENT_PREFIX = "p:"; // field was rendered (multi_choice sends nothing when all boxes are clear)

export const MAX_TEXT = 4000;
export const MAX_LONG_TEXT = 20000;

/**
 * Fields mirrored on `cases` (G6): editable here; the database copies them onto the case
 * (trigger case_field_values_sync_case) and refuses a claim no. used by another case of the insurer.
 */
export const MIRRORED_KEYS: ReadonlySet<string> = new Set(["insurer_claim_no", "policy_no"]);
/** Mirrored fields that cannot be emptied (cases.insurer_claim_no is not null). */
export const NOT_CLEARABLE_KEYS: ReadonlySet<string> = new Set(["insurer_claim_no"]);

export const BOOLEAN_OPTIONS = ["Yes", "No"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** case_template_fields.options: strings or {value} objects. */
export function asOptions(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((o) => (typeof o === "string" ? o : isRecord(o) && typeof o.value === "string" ? o.value : null))
    .filter((o): o is string => !!o);
}

/** A stored multi_choice value: JSON array of strings; anything else is kept as one item. */
export function parseMulti(raw: string | null | undefined): string[] {
  const s = (raw ?? "").trim();
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((x) => x.trim()).filter(Boolean);
  } catch {
    // not JSON: one value
  }
  return [s];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

function validYmd(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-12" or "12/11/2026" (dd/mm/yyyy, Indian order) → "2026-11-12"; else null. */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let m = ISO_DATE.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? s : null;
  m = DMY_DATE.exec(s);
  if (m && validYmd(+m[3], +m[2], +m[1])) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
  return null;
}

/** True when the stored value can be shown in the field's native input without losing it. */
export function rendersNatively(type: FieldType, raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s) return true;
  switch (type) {
    case "date":
      return ISO_DATE.test(s) && toIsoDate(s) === s;
    case "datetime":
      return ISO_DATETIME.test(s);
    case "boolean":
      return (BOOLEAN_OPTIONS as readonly string[]).includes(s);
    case "number":
    case "currency":
      return /^-?\d+(\.\d+)?$/.test(s);
    default:
      // choice / multi_choice keep an unknown value as an extra option; text types always render
      return true;
  }
}

export type Normalised = { value: string | null; error: string | null };

/**
 * Validates one submitted value and returns its stored form (null = cleared).
 * `raw` is the list of submitted strings (one for every type except multi_choice).
 */
export function normaliseValue(type: FieldType, raw: string[], options: string[], required: boolean): Normalised {
  const ok = (value: string | null): Normalised => ({ value, error: null });
  const fail = (error: string): Normalised => ({ value: null, error });

  if (type === "multi_choice") {
    const picked = [...new Set(raw.map((r) => r.trim()).filter(Boolean))];
    if (!picked.length) return required ? fail("Choose at least one.") : ok(null);
    return ok(JSON.stringify(picked));
  }

  const s = (raw[0] ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return required ? fail("This field is required.") : ok(null);

  switch (type) {
    case "text":
      return s.length > MAX_TEXT ? fail(`At most ${MAX_TEXT} characters.`) : ok(s);
    case "long_text":
      return s.length > MAX_LONG_TEXT ? fail(`At most ${MAX_LONG_TEXT} characters.`) : ok(s);
    case "number": {
      const n = s.replace(/[,\s]/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? ok(n) : fail("Enter a number.");
    }
    case "currency": {
      const n = s.replace(/[₹,\s]|^rs\.?/gi, "");
      if (!/^\d+(\.\d{1,2})?$/.test(n)) return fail("Enter an amount in rupees, e.g. 185000 or 1,85,000.50.");
      return ok(n);
    }
    case "date": {
      const iso = toIsoDate(s);
      return iso ? ok(iso) : fail("Enter a date as dd/mm/yyyy.");
    }
    case "datetime": {
      const m = ISO_DATETIME.exec(s);
      if (!m || toIsoDate(m[1]) !== m[1] || +m[2] > 23 || +m[3] > 59) return fail("Enter a date and time.");
      return ok(s);
    }
    case "boolean":
      return (BOOLEAN_OPTIONS as readonly string[]).includes(s) ? ok(s) : fail("Choose Yes or No.");
    case "choice":
      // A value outside the options is accepted only when it is the one already stored (rendered as its own option).
      return !options.length || options.includes(s) ? ok(s) : fail("Choose one of the options.");
    default:
      return ok(s);
  }
}

/** Comparable form of a raw value, so an untouched field is never rewritten. */
export function comparable(type: FieldType, raw: string[] | string | null | undefined): string {
  if (type === "multi_choice") {
    const list = Array.isArray(raw) ? raw.map((r) => r.trim()).filter(Boolean) : parseMulti(raw);
    return JSON.stringify(list);
  }
  const s = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return s.trim();
}

// ---------------------------------------------------------------------
// Saving a section: what to write, what is invalid, what changed underneath
// ---------------------------------------------------------------------
export type SaveFieldDef = { id: string; key: string; field_type: FieldType; is_required: boolean; options?: unknown };

export type SavePlan = {
  /** `expected` = the value as loaded; the database writes only while it is still the stored value. */
  writes: { field_id: string; key: string; value: string | null; expected: string }[];
  errors: Record<string, string>;
};

/** Reads `p:` / `f:` / `o:` entries of a submitted form. */
export function readSectionForm(entries: Iterable<[string, unknown]>): {
  present: Set<string>;
  values: Map<string, string[]>;
  originals: Map<string, string>;
} {
  const present = new Set<string>();
  const values = new Map<string, string[]>();
  const originals = new Map<string, string>();
  for (const [name, raw] of entries) {
    if (typeof raw !== "string") continue;
    if (name.startsWith(PRESENT_PREFIX)) present.add(name.slice(PRESENT_PREFIX.length));
    else if (name.startsWith(ORIGINAL_PREFIX)) originals.set(name.slice(ORIGINAL_PREFIX.length), raw);
    else if (name.startsWith(FIELD_PREFIX)) {
      const key = name.slice(FIELD_PREFIX.length);
      values.set(key, [...(values.get(key) ?? []), raw]);
    }
  }
  return { present, values, originals };
}

/**
 * Plans a section save. Only fields that were rendered (`present`) and whose value differs from the value as
 * loaded are sent; save_case_field_values compares each against the stored value atomically and returns the
 * ones changed underneath as conflicts. Clearing a required field is allowed (a wrong intake value can be
 * removed); required fields are enforced when approval is requested, and progress shows them meanwhile.
 */
export function planSectionSave(
  fields: SaveFieldDef[],
  form: { present: Set<string>; values: Map<string, string[]>; originals: Map<string, string> },
): SavePlan {
  const plan: SavePlan = { writes: [], errors: {} };
  for (const f of fields) {
    if (!form.present.has(f.key)) continue;
    const submitted = form.values.get(f.key) ?? [];
    const original = form.originals.get(f.key) ?? "";
    if (comparable(f.field_type, submitted) === comparable(f.field_type, original)) continue;

    // A stored choice outside the options stays selectable (it is rendered as its own option).
    const options = asOptions(f.options).concat(f.field_type === "choice" && original.trim() ? [original.trim()] : []);
    const norm = normaliseValue(f.field_type, submitted, options, false);
    if (norm.error) {
      plan.errors[f.key] = norm.error;
      continue;
    }
    if (norm.value === null && NOT_CLEARABLE_KEYS.has(f.key)) {
      plan.errors[f.key] = "The claim number cannot be empty.";
      continue;
    }
    if ((norm.value ?? "") === original.replace(/\r\n/g, "\n").trim()) continue; // normalises to what is stored (e.g. spaces only)
    plan.writes.push({ field_id: f.id, key: f.key, value: norm.value, expected: original });
  }
  return plan;
}

/** A field someone else saved since the form was loaded (from save_case_field_values). */
export type Conflict = { value: string; by: string | null; at: string | null };
export type SaveResult = { saved: string[]; conflicts: Record<string, Conflict> };

/** Reads the jsonb result of save_case_field_values; null when it is not in the expected shape. */
export function parseSaveResult(json: unknown): SaveResult | null {
  if (!isRecord(json) || !Array.isArray(json.saved) || !isRecord(json.conflicts)) return null;
  const saved = json.saved.filter((k): k is string => typeof k === "string");
  const conflicts: Record<string, Conflict> = {};
  for (const [key, c] of Object.entries(json.conflicts)) {
    if (!isRecord(c)) return null;
    conflicts[key] = {
      value: typeof c.value === "string" ? c.value : "",
      by: typeof c.updated_by_name === "string" ? c.updated_by_name : null,
      at: typeof c.updated_at === "string" ? c.updated_at : null,
    };
  }
  return { saved, conflicts };
}

/** What the form says after a save that met conflicts (the other fields were saved). */
export function conflictMessage(saved: number, conflicts: number): string {
  const head = saved ? `Saved ${saved} ${saved === 1 ? "field" : "fields"}. ` : "";
  const what = conflicts === 1 ? "A field was" : `${conflicts} fields were`;
  return `${head}${what} changed by someone else while you were editing and not saved. Their value is shown under the field; save again to replace it.`;
}

/** Result of the saveSection server action (app/(app)/reports/[caseRef]/actions.ts). */
export type SectionState = {
  error: string | null;
  fieldErrors: Record<string, string>;
  /** key → value saved by someone else since the form was loaded. */
  conflicts: Record<string, string>;
  /** key → who saved it and when (same keys as `conflicts`). */
  conflictInfo: Record<string, { by: string | null; at: string | null }>;
  /** What was submitted, so the form keeps it after a failed attempt (React resets forms after an action). */
  values: Record<string, string[]>;
  /** Set on success; the form shows a toast and remounts with the stored values. */
  savedAt: number | null;
  saved: number;
};

export const INITIAL_SECTION_STATE: SectionState = { error: null, fieldErrors: {}, conflicts: {}, conflictInfo: {}, values: {}, savedAt: null, saved: 0 };

export type ActionResult = { error: string | null };
export type LinkResult = { error: string | null; url: string | null };

// ---------------------------------------------------------------------
// Workspace model
// ---------------------------------------------------------------------
export type SectionDef = { id: string; key: string; title: string; position: number; guidance: string | null };
export type FieldDef = SaveFieldDef & {
  section_id: string;
  label: string;
  source: Enums<"template_field_source">;
  help_text: string | null;
  position: number;
};
export type ValueRow = { field_id: string; value: string | null; source: FieldSource; updated_at: string };

export const VALUE_SOURCES: Record<FieldSource, { label: string; tone: Tone }> = {
  email_parser: { label: "From email", tone: "info" },
  office: { label: "Entered", tone: "neutral" },
  suggestion: { label: "Suggestion", tone: "success" },
  llm: { label: "AI", tone: "warning" },
};

export type WorkspaceField = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  fromIntake: boolean;
  options: string[];
  value: string;
  source: FieldSource | null;
  /** Copied onto the case record when saved (claim / policy no., G6). */
  mirrored: boolean;
  /** Stored value would not survive the native input: render as text. */
  asText: boolean;
};

export type WorkspaceSection = SectionDef & {
  fields: WorkspaceField[];
  filled: number;
  total: number;
  requiredFilled: number;
  requiredTotal: number;
  lastUpdatedAt: string | null;
  /** Changes when any value of the section is saved: remounts the form with the new values. */
  version: string;
};

function filled(v: string): boolean {
  return v.trim() !== "";
}

export function buildWorkspace(sections: SectionDef[], fields: FieldDef[], values: ValueRow[]): WorkspaceSection[] {
  const byField = new Map(values.map((v) => [v.field_id, v]));
  return [...sections]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const fs = fields
        .filter((f) => f.section_id === s.id)
        .sort((a, b) => a.position - b.position)
        .map((f): WorkspaceField => {
          const row = byField.get(f.id);
          const value = row?.value ?? "";
          const options = asOptions(f.options);
          return {
            id: f.id,
            key: f.key,
            label: f.label,
            type: f.field_type,
            required: f.is_required,
            help: f.help_text,
            fromIntake: f.source === "intake",
            options,
            value,
            source: row && filled(value) ? row.source : null,
            mirrored: MIRRORED_KEYS.has(f.key),
            asText: !rendersNatively(f.field_type, value),
          };
        });
      const stamps = fs.map((f) => byField.get(f.id)?.updated_at).filter((t): t is string => !!t).sort();
      const last = stamps.length ? stamps[stamps.length - 1] : null;
      return {
        ...s,
        fields: fs,
        filled: fs.filter((f) => filled(f.value)).length,
        total: fs.length,
        requiredFilled: fs.filter((f) => f.required && filled(f.value)).length,
        requiredTotal: fs.filter((f) => f.required).length,
        lastUpdatedAt: last,
        version: `${s.id}:${last ?? "-"}:${stamps.length}`,
      };
    });
}

export function workspaceTotals(sections: WorkspaceSection[]): { requiredFilled: number; requiredTotal: number; filled: number; total: number } {
  return sections.reduce(
    (t, s) => ({
      requiredFilled: t.requiredFilled + s.requiredFilled,
      requiredTotal: t.requiredTotal + s.requiredTotal,
      filled: t.filled + s.filled,
      total: t.total + s.total,
    }),
    { requiredFilled: 0, requiredTotal: 0, filled: 0, total: 0 },
  );
}

/** Requested section, else the first with a required field missing, else the first. */
export function focusSection(sections: WorkspaceSection[], requested: string | null | undefined): WorkspaceSection | null {
  return (
    sections.find((s) => s.key === requested) ??
    sections.find((s) => s.requiredFilled < s.requiredTotal) ??
    sections[0] ??
    null
  );
}

// ---------------------------------------------------------------------
// Who may edit (D44: office staff act on the cases they own; D45: orchestrators edit reports too)
// ---------------------------------------------------------------------
/** Same list as private.report_editable_status() in the database. */
export const EDITABLE_STATUSES: CaseStatus[] = STAGE_STATUSES.in_progress;
export const EDITOR_ROLES: UserRole[] = ["admin", "orchestrator", "office"];

/** Mirrors private.can_manage_case(): admin and orchestrator on every case, office on the cases they own. */
export function canManageCase(role: UserRole, ownerId: string | null | undefined, userId: string): boolean {
  if (role === "admin" || role === "orchestrator") return true;
  return role === "office" && !!ownerId && ownerId === userId;
}

export type EditLock = { editable: true } | { editable: false; reason: string };

export function editLock(role: UserRole, status: CaseStatus, ownsCase: boolean): EditLock {
  if (!EDITOR_ROLES.includes(role)) return { editable: false, reason: "Only office staff edit reports." };
  if (role === "office" && !ownsCase) {
    return {
      editable: false,
      reason: "This case belongs to another employee, so the report is read-only for you. Ask an orchestrator to reassign it if you should work on it.",
    };
  }
  if (status === "orchestrator_review") {
    return { editable: false, reason: "A version is waiting for approval or approved, so the values are locked. The orchestrator can request changes to unlock them." };
  }
  if (status === "submitted" || status === "closed") {
    return {
      editable: false,
      reason: status === "closed" ? "The case is closed." : "The report has been sent to the insurer. Reopen the case from Submissions to change it.",
    };
  }
  if (status === "cancelled") return { editable: false, reason: "The case is cancelled." };
  return { editable: true };
}

// ---------------------------------------------------------------------
// Files beside a section (7.2)
// ---------------------------------------------------------------------
export type PanelEvidence = {
  id: string;
  server_received_at: string;
  relevance: Enums<"evidence_relevance">;
  /** Active label category ids. */
  categoryIds: string[];
};

/** A file as the panel shows it (built in app/(app)/reports/[caseRef]/load.ts). */
export type PanelFile = PanelEvidence & {
  type: Enums<"evidence_type">;
  name: string;
  mime: string | null;
  source: Enums<"capture_source">;
  backend: string;
  /** Hashes of the original and its copies (RLS read) for the browser file cache; null for notes. */
  file: CachedFile | null;
  labels: { categoryId: string; name: string; confidence: number | null; source: Enums<"label_source"> }[];
  description: string | null;
  /** v_evidence_processing.state */
  processing: string | null;
  matchScore: number | null;
  /** Where the best field match came from: the template's category → field map (label-based) or a model. */
  matchFrom: MatchOrigin | null;
};

/** Field matches below this score are not used for placement. */
export const MATCH_MIN_SCORE = 0.5;

export type PanelGroups<E> = { matched: E[]; unlabelled: E[]; notRelevant: E[] };

/**
 * Matched = an active label in the section's categories or a field match to one of its fields (D35), best match
 * first, then newest. Unlabelled = no active label and no match. Files marked not relevant are folded apart.
 */
export function sectionEvidence<E extends PanelEvidence>(
  evidence: E[],
  sectionCategoryIds: Iterable<string>,
  matchScores: Map<string, number>,
): PanelGroups<E> {
  const cats = new Set(sectionCategoryIds);
  const score = (e: E) => matchScores.get(e.id) ?? 0;
  const newest = (a: E, b: E) => (a.server_received_at < b.server_received_at ? 1 : a.server_received_at > b.server_received_at ? -1 : 0);
  const out: PanelGroups<E> = { matched: [], unlabelled: [], notRelevant: [] };
  for (const e of evidence) {
    const isMatch = e.categoryIds.some((c) => cats.has(c)) || score(e) >= MATCH_MIN_SCORE;
    const isUnlabelled = !isMatch && e.categoryIds.length === 0;
    if (!isMatch && !isUnlabelled) continue;
    if (e.relevance === "not_relevant") out.notRelevant.push(e);
    else if (isMatch) out.matched.push(e);
    else out.unlabelled.push(e);
  }
  out.matched.sort((a, b) => score(b) - score(a) || newest(a, b));
  out.unlabelled.sort(newest);
  out.notRelevant.sort(newest);
  return out;
}

/** Best score per evidence among the given matches. */
export function bestMatchScores(matches: { evidence_id: string; score: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) out.set(m.evidence_id, Math.max(out.get(m.evidence_id) ?? 0, m.score));
  return out;
}

/** `category_map` rows come from the template's category → field map applied to the file's labels (gap 26). */
export const CATEGORY_MAP_MODEL = "category_map";
export type MatchOrigin = "category" | "model";

/** Origin of the best match per evidence (ties: a model match wins, it is specific to the file). */
export function bestMatchOrigins(matches: { evidence_id: string; score: number; model: string }[]): Map<string, MatchOrigin> {
  const best = new Map<string, { score: number; origin: MatchOrigin }>();
  for (const m of matches) {
    const origin: MatchOrigin = m.model === CATEGORY_MAP_MODEL ? "category" : "model";
    const cur = best.get(m.evidence_id);
    if (!cur || m.score > cur.score || (m.score === cur.score && origin === "model")) best.set(m.evidence_id, { score: m.score, origin });
  }
  return new Map([...best].map(([id, b]) => [id, b.origin]));
}

// ---------------------------------------------------------------------
// Report versions and approval (8.1)
// ---------------------------------------------------------------------
export type VersionApproval = { id: string; decision: ApprovalDecision; requested_by: string; requested_at: string };
export type VersionLite = { id: string; version: number; approval: VersionApproval | null };

export type VersionRow = VersionLite & {
  origin: string;
  created_at: string;
  notes: string | null;
  creator: string | null;
  files: { format: string; size_bytes: number | null }[];
  approvalDetail: {
    requested_at: string;
    requester: string | null;
    decided_at: string | null;
    decider: string | null;
    comments: string | null;
  } | null;
};

export type ApprovalModel = {
  /** What the approval card says. */
  state: "not_required" | "no_version" | "not_requested" | "pending" | "approved" | "changes_requested";
  latest: VersionLite | null;
  /** The request rules pass for this user (approval request, or the one-step approval when `oneStep`). */
  canRequest: boolean;
  /** D47: orchestrators and admins approve their own reports in one step ("Approve report") instead of requesting. */
  oneStep: boolean;
  /** Why "Request approval" / "Approve report" is disabled (shown next to it). */
  requestBlocked: string | null;
  canDecide: boolean;
};

/** Decide office requests, and approve in one step (D47). */
export const APPROVER_ROLES: UserRole[] = ["orchestrator", "admin"];
/** Request approval from an orchestrator / admin (office employees, on the cases they own). */
export const REQUESTER_ROLES: UserRole[] = ["office"];

/** Statuses in which approval can be requested (report_approvals_guard also refuses open field work). */
export const REQUEST_STATUSES: CaseStatus[] = ["assigned", "office_review"];

/**
 * Same rules as report_approvals_guard (G5). Office employees request approval; orchestrators and admins (D47)
 * approve in one step under the same rules (approve_own_report) and still decide office requests.
 */
export function approvalModel(input: {
  role: UserRole;
  /** Office staff request approval only on cases they own (D44). */
  ownsCase: boolean;
  requiresApproval: boolean;
  status: CaseStatus;
  versions: VersionLite[];
  requiredMissing: number;
}): ApprovalModel {
  const latest = [...input.versions].sort((a, b) => b.version - a.version)[0] ?? null;
  const decision = latest?.approval?.decision ?? null;
  const state: ApprovalModel["state"] = !input.requiresApproval
    ? "not_required"
    : !latest
      ? "no_version"
      : !decision
        ? "not_requested"
        : decision;

  const oneStep = APPROVER_ROLES.includes(input.role);
  let requestBlocked: string | null = null;
  if (state === "no_version" || state === "not_requested" || state === "changes_requested") {
    if (!oneStep && !REQUESTER_ROLES.includes(input.role)) requestBlocked = "Office staff request approval.";
    else if (input.role === "office" && !input.ownsCase) requestBlocked = "Only the case owner requests approval.";
    else if (state === "no_version") requestBlocked = "Generate a report version first.";
    else if (state === "changes_requested") requestBlocked = "Changes were requested on the latest version. Generate a new version first.";
    else if (input.requiredMissing > 0)
      requestBlocked = `${input.requiredMissing} required ${input.requiredMissing === 1 ? "field is" : "fields are"} empty.`;
    else if (!REQUEST_STATUSES.includes(input.status))
      requestBlocked = input.status === "field_in_progress" ? "Field work is still open." : "The case is not in office review.";
  }
  return {
    state,
    latest,
    canRequest: state === "not_requested" && requestBlocked === null,
    oneStep,
    requestBlocked,
    canDecide: state === "pending" && APPROVER_ROLES.includes(input.role),
  };
}

export const APPROVAL_DECISIONS: Record<ApprovalDecision, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  changes_requested: { label: "Changes requested", tone: "danger" },
};

/** "3 days left", "due today", "2 days overdue" (whole days, by the clock). */
export function dueLabel(dueAt: string | null | undefined, now: Date = new Date()): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return null;
  const days = Math.floor(Math.abs(ms) / 86_400_000);
  if (ms < 0) return { text: days === 0 ? "overdue" : `${days} ${days === 1 ? "day" : "days"} overdue`, overdue: true };
  return { text: days === 0 ? "due today" : `${days} ${days === 1 ? "day" : "days"} left`, overdue: false };
}
