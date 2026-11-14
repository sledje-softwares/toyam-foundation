/** Checklist templates (docs/08 §2.3): pure list and editor logic shared by the pages, the editor and the server actions. */
import { z } from "zod";
import type { Enums } from "@/lib/database.types";

export type ClaimType = Enums<"claim_type">;
export type EvidenceType = Enums<"evidence_type">;

/** Enum order (docs/08: groups in enum order). */
export const CLAIM_TYPES = ["health", "motor", "death", "personal_accident", "property", "other"] as const satisfies readonly ClaimType[];
export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  health: "Health",
  motor: "Motor",
  death: "Death",
  personal_accident: "Personal accident",
  property: "Property",
  other: "Other",
};
export const EVIDENCE_TYPES = ["photo", "document", "audio", "video", "note"] as const satisfies readonly EvidenceType[];
export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  photo: "Photo",
  document: "Document",
  audio: "Audio",
  video: "Video",
  note: "Note",
};

export const NAME_MIN = 3;
export const NAME_MAX = 80;
export const DESC_MIN = 3;
export const DESC_MAX = 200;
export const MAX_ITEMS = 50;
export const ALL_INSURERS = "All insurers";

export function isClaimType(v: unknown): v is ClaimType {
  return typeof v === "string" && (CLAIM_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- list (T13)

export type TemplateRow = {
  id: string;
  name: string;
  claim_type: ClaimType;
  insurer_id: string | null;
  insurer_name: string | null;
  is_active: boolean;
  version: number;
  updated_at: string;
  items: number;
  required: number;
};

export type StatusFilter = "in_use" | "not_in_use" | "all";
export type ListFilters = { claim_type: ClaimType | null; insurer: string | null; status: StatusFilter };

export function parseStatusFilter(v: unknown): StatusFilter {
  return v === "not_in_use" || v === "all" ? v : "in_use";
}

/** insurer: null = any, "none" = all-insurer checklists only, else an insurer id. */
export function filterTemplates(rows: TemplateRow[], f: ListFilters): TemplateRow[] {
  return rows.filter(
    (r) =>
      (!f.claim_type || r.claim_type === f.claim_type) &&
      (!f.insurer || (f.insurer === "none" ? r.insurer_id === null : r.insurer_id === f.insurer)) &&
      (f.status === "all" || r.is_active === (f.status === "in_use")),
  );
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** An in-use insurer checklist hides the in-use all-insurer checklist of the same name and claim type. */
export function overridesAllInsurers(row: TemplateRow, all: TemplateRow[]): boolean {
  return (
    row.is_active &&
    row.insurer_id !== null &&
    all.some((o) => o.is_active && o.insurer_id === null && o.claim_type === row.claim_type && sameName(o.name, row.name))
  );
}

/** Every claim type in enum order (or only the filtered one), rows sorted by name with "All insurers" first. */
export function groupTemplates(rows: TemplateRow[], only: ClaimType | null): { claim_type: ClaimType; rows: TemplateRow[] }[] {
  return CLAIM_TYPES.filter((c) => !only || c === only).map((claim_type) => ({
    claim_type,
    rows: rows
      .filter((r) => r.claim_type === claim_type)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
          Number(a.insurer_id !== null) - Number(b.insurer_id !== null) ||
          (a.insurer_name ?? "").localeCompare(b.insurer_name ?? "") ||
          Number(b.is_active) - Number(a.is_active) ||
          b.version - a.version,
      ),
  }));
}

export function itemsLabel(items: number, required: number): string {
  return `${items} · ${required} req.`;
}

// ---------------------------------------------------------------- editor (T14)

export type EditorItem = {
  /** Client key: the item id for saved items, "new-n" for new ones. */
  key: string;
  id: string | null;
  description: string;
  required_evidence_type: EvidenceType;
  is_mandatory: boolean;
  camera_only: boolean;
  /** "" = no category. */
  category_id: string;
};

export type EditorState = {
  id: string | null;
  version: number | null;
  name: string;
  claim_type: ClaimType | "";
  /** "" = all insurers. */
  insurer_id: string;
  items: EditorItem[];
};

export function newItem(key: string, type: EvidenceType = "photo"): EditorItem {
  return { key, id: null, description: "", required_evidence_type: type, is_mandatory: true, camera_only: type === "photo", category_id: "" };
}

export function addItem(items: EditorItem[], key: string): EditorItem[] {
  return items.length >= MAX_ITEMS ? items : [...items, newItem(key)];
}

/** Moves the item one place up (-1) or down (+1); unchanged at the ends. */
export function moveItem(items: EditorItem[], key: string, delta: -1 | 1): EditorItem[] {
  const i = items.findIndex((x) => x.key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export type Removed = { item: EditorItem; index: number };

export function removeItem(items: EditorItem[], key: string): { items: EditorItem[]; removed: Removed | null } {
  const index = items.findIndex((x) => x.key === key);
  if (index < 0) return { items, removed: null };
  return { items: items.filter((x) => x.key !== key), removed: { item: items[index], index } };
}

export function undoRemove(items: EditorItem[], removed: Removed): EditorItem[] {
  if (items.some((x) => x.key === removed.item.key)) return items;
  const next = items.slice();
  next.splice(Math.min(removed.index, next.length), 0, removed.item);
  return next;
}

/** Applies a field change; a type change resets "camera only" to its default (on for Photo), and Note never allows it. */
export function updateItem(items: EditorItem[], key: string, patch: Partial<Omit<EditorItem, "key" | "id">>): EditorItem[] {
  return items.map((x) => {
    if (x.key !== key) return x;
    const next = { ...x, ...patch };
    if (patch.required_evidence_type && patch.required_evidence_type !== x.required_evidence_type && patch.camera_only === undefined) {
      next.camera_only = patch.required_evidence_type === "photo";
    }
    if (next.required_evidence_type === "note") next.camera_only = false;
    return next;
  });
}

export type OtherTemplate = { id: string; name: string; claim_type: ClaimType; insurer_id: string | null; is_active: boolean; version: number };

export type Validation = {
  fieldErrors: { name?: string; claim_type?: string; items?: string };
  itemErrors: Record<string, string>;
  warnings: string[];
};

/**
 * Blocking errors mirror the database (1-50 items, description 3-200, no camera-only Note) plus the form rules (name 3-80;
 * an in-use checklist may not share its name with another in-use one in the same claim type and insurer scope).
 */
export function validateChecklist(s: EditorState, opts: { isActive?: boolean; others?: OtherTemplate[] } = {}): Validation {
  const fieldErrors: Validation["fieldErrors"] = {};
  const itemErrors: Record<string, string> = {};
  const warnings: string[] = [];
  const name = s.name.trim();
  if (!name) fieldErrors.name = "Enter a name.";
  else if (name.length < NAME_MIN || name.length > NAME_MAX) fieldErrors.name = `Use ${NAME_MIN} to ${NAME_MAX} characters.`;
  else if (opts.isActive && s.claim_type && findReplaced({ ...s, name }, opts.others ?? [])) {
    fieldErrors.name = "Another checklist in use for this claim type and insurer has this name.";
  }
  if (!s.claim_type) fieldErrors.claim_type = "Choose a claim type.";
  if (s.items.length === 0) fieldErrors.items = "Add at least one item.";
  else if (s.items.length > MAX_ITEMS) fieldErrors.items = `A checklist can have at most ${MAX_ITEMS} items.`;
  for (const it of s.items) {
    const d = it.description.trim();
    if (d.length < DESC_MIN || d.length > DESC_MAX) itemErrors[it.key] = `Describe the item in ${DESC_MIN} to ${DESC_MAX} characters.`;
    else if (it.camera_only && it.required_evidence_type === "note") itemErrors[it.key] = "A note can't be camera only.";
  }
  if (s.items.length > 0) {
    if (!s.items.some((x) => x.is_mandatory)) warnings.push("No item is required.");
    const seen = new Set<string>();
    if (s.items.some((x) => { const k = x.description.trim().toLowerCase(); if (!k) return false; const dup = seen.has(k); seen.add(k); return dup; })) {
      warnings.push("Two items have the same description.");
    }
    const noCat = s.items.filter((x) => !x.category_id).length;
    if (noCat > 0) {
      warnings.push(
        noCat === 1
          ? "1 item has no evidence category, so it will not tick itself when files are labelled."
          : `${noCat} items have no evidence category, so they will not tick themselves when files are labelled.`,
      );
    }
  }
  return { fieldErrors, itemErrors, warnings };
}

export function hasBlockingErrors(v: Validation): boolean {
  return Object.keys(v.fieldErrors).length > 0 || Object.keys(v.itemErrors).length > 0;
}

/** The in-use checklist that putting `s` in use would replace (same claim type, insurer scope and name). */
export function findReplaced(
  s: { id: string | null; name: string; claim_type: ClaimType | ""; insurer_id: string },
  others: OtherTemplate[],
): OtherTemplate | null {
  const insurer = s.insurer_id || null;
  return (
    others.find((o) => o.is_active && o.id !== s.id && o.claim_type === s.claim_type && o.insurer_id === insurer && sameName(o.name, s.name)) ?? null
  );
}

export const SaveItemSchema = z.object({
  id: z.guid().optional(),
  description: z.string().trim().min(DESC_MIN).max(DESC_MAX),
  required_evidence_type: z.enum(EVIDENCE_TYPES),
  is_mandatory: z.boolean(),
  camera_only: z.boolean(),
  category_id: z.guid().nullable(),
});

export const SavePayloadSchema = z
  .object({
    id: z.guid().nullable(),
    expected_version: z.number().int().positive().nullable(),
    name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
    claim_type: z.enum(CLAIM_TYPES),
    insurer_id: z.guid().nullable(),
    items: z.array(SaveItemSchema).min(1).max(MAX_ITEMS),
  })
  .refine((p) => (p.id === null) === (p.expected_version === null), { message: "id and expected_version go together" })
  .refine((p) => p.items.every((i) => !(i.camera_only && i.required_evidence_type === "note")), { message: "A note can't be camera only." });

export type SavePayload = z.infer<typeof SavePayloadSchema>;

/** Payload for save_checklist_template(): trimmed text, items in display order (the RPC renumbers 1..n). */
export function buildSavePayload(s: EditorState): SavePayload {
  return {
    id: s.id,
    expected_version: s.id ? s.version : null,
    name: s.name.trim(),
    claim_type: s.claim_type as ClaimType,
    insurer_id: s.insurer_id || null,
    items: s.items.map((it) => ({
      ...(it.id ? { id: it.id } : {}),
      description: it.description.trim(),
      required_evidence_type: it.required_evidence_type,
      is_mandatory: it.is_mandatory,
      camera_only: it.required_evidence_type === "note" ? false : it.camera_only,
      category_id: it.category_id || null,
    })),
  };
}

/** True when the form differs from what was loaded (keys and ids of new items are ignored). */
export function isDirty(initial: EditorState, current: EditorState): boolean {
  const snap = (s: EditorState) =>
    JSON.stringify([s.name, s.claim_type, s.insurer_id, s.items.map((i) => [i.id, i.description, i.required_evidence_type, i.is_mandatory, i.camera_only, i.category_id])]);
  return snap(initial) !== snap(current);
}

/** Editor state for "Duplicate": "Copy of …", not in use, items without ids. */
export function copyState(src: EditorState, nextKey: () => string): EditorState {
  const name = `Copy of ${src.name.trim()}`.slice(0, NAME_MAX);
  return { ...src, id: null, version: null, name, items: src.items.map((i) => ({ ...i, id: null, key: nextKey() })) };
}

// ---------------------------------------------------------------- categories

export type Category = { id: string; name: string; is_active: boolean };

/**
 * Categories for the item select: those used in the claim type's report templates first, then the rest; each group by name.
 * Inactive categories are left out unless an item already uses one.
 */
export function orderCategories(
  cats: Category[],
  relevantIds: ReadonlySet<string>,
  keepIds: ReadonlySet<string> = new Set(),
): { relevant: Category[]; other: Category[] } {
  const usable = cats.filter((c) => c.is_active || keepIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  return { relevant: usable.filter((c) => relevantIds.has(c.id)), other: usable.filter((c) => !relevantIds.has(c.id)) };
}

// ---------------------------------------------------------------- impact (T15)

/** Distinct open tasks per checklist template, from task_checklist_items rows already filtered to open tasks. */
export function openTaskCounts(rows: { task_id: string; template_id: string | null }[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.template_id) continue;
    let s = sets.get(r.template_id);
    if (!s) sets.set(r.template_id, (s = new Set()));
    s.add(r.task_id);
  }
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

function tasksPhrase(n: number): string {
  return n === 1 ? "1 open task uses" : `${n} open tasks use`;
}

/** Info note above the editor. */
export function impactText(openTasks: number): string {
  const base = "Saving changes affects tasks created after you save.";
  if (openTasks === 0) return `${base} No open task uses a copy of this checklist.`;
  return `${base} Existing tasks keep their own copy — ${tasksPhrase(openTasks)} an earlier copy of this checklist.`;
}

export function scopeLabel(claim: ClaimType, insurerName: string | null): string {
  return `${CLAIM_TYPE_LABELS[claim]} · ${insurerName ?? ALL_INSURERS}`;
}

export function putInUseText(p: {
  name: string;
  claim_type: ClaimType;
  insurerName: string | null;
  replaced: { version: number; openTasks: number } | null;
  openTasks: number;
}): string {
  const parts = [`Put "${p.name}" in use for ${p.insurerName ?? ALL_INSURERS.toLowerCase()}?`];
  if (p.replaced) {
    parts.push(
      `It replaces the checklist currently in use with the same name for ${scopeLabel(p.claim_type, p.insurerName)} (version ${p.replaced.version}).`,
    );
    parts.push("Case templates linked to that checklist switch to this one, so new cases from them get the new items immediately.");
    if (p.replaced.openTasks > 0) parts.push(`${tasksPhrase(p.replaced.openTasks)} a copy of that checklist.`);
  }
  if (p.openTasks > 0) parts.push(`${tasksPhrase(p.openTasks)} an earlier copy of this checklist.`);
  parts.push("Tasks already created are not affected.");
  return parts.join(" ");
}

export function takeOutOfUseText(openTasks: number): string {
  const base = "Staff will no longer be able to choose this checklist for new tasks.";
  if (openTasks === 0) return `${base} No open task uses it.`;
  return `${base} ${tasksPhrase(openTasks)} a copy of it; existing tasks are not affected.`;
}
