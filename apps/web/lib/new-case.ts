/**
 * /cases/new — create a case directly (D49): pure helpers for the page and its server action.
 * public.create_case_direct(p_template_id, p_values, p_owner_id, p_note) re-checks everything
 * (staff, owner rules, active template, intake keys, required fields, duplicate claim no.).
 * Values use the report workspace's storage format (normaliseValue in lib/reports.ts).
 */
import type { Enums } from "@/lib/database.types";
import { CLAIM_TYPE_LABELS } from "./checklists";
import { asOptions, FIELD_PREFIX, normaliseValue, type FieldType } from "./reports";
import { isGuid } from "./cases";

type UserRole = Enums<"user_role">;
type ClaimType = Enums<"claim_type">;

export const CLAIM_NO_KEY = "insurer_claim_no";
/** Owner select value meaning "run the automatic assignment" (orchestrator / admin). */
export const AUTO_OWNER = "auto";
export const NOTE_MAX = 4000;

/** Office employees create cases for themselves (D44/D49); orchestrators and admins choose or auto-assign. */
export function canChooseOwner(role: UserRole): boolean {
  return role === "orchestrator" || role === "admin";
}

export type TemplateOption = { id: string; claim_type: ClaimType; variant: string; version: number; name: string };

/** "Motor · OD · v3" */
export function templateLabel(t: Pick<TemplateOption, "claim_type" | "variant" | "version">): string {
  const variant = t.variant.replace(/_/g, " ");
  return `${CLAIM_TYPE_LABELS[t.claim_type]} · ${variant.length <= 4 ? variant.toUpperCase() : variant[0].toUpperCase() + variant.slice(1)} · v${t.version}`;
}

export type NewCaseField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  help: string | null;
  section: string | null;
};

type FieldRow = {
  key: string;
  label: string;
  field_type: FieldType;
  is_required: boolean;
  options: unknown;
  help_text: string | null;
  position: number;
  section_position: number;
  section_title: string | null;
};

/**
 * The template's intake fields in report order. The claim number is required for every case, so it is
 * always present and required (added first when the template has no intake field of that key).
 */
export function newCaseFields(rows: FieldRow[]): NewCaseField[] {
  const fields = [...rows]
    .sort((a, b) => a.section_position - b.section_position || a.position - b.position)
    .map<NewCaseField>((r) => ({
      key: r.key,
      label: r.label,
      type: r.field_type,
      required: r.is_required || r.key === CLAIM_NO_KEY,
      options: r.field_type === "boolean" ? [] : asOptions(r.options),
      help: r.help_text,
      section: r.section_title,
    }));
  if (!fields.some((f) => f.key === CLAIM_NO_KEY)) {
    fields.unshift({ key: CLAIM_NO_KEY, label: "Claim no.", type: "text", required: true, options: [], help: null, section: null });
  }
  return fields;
}

/** Field keys grouped by section title, in order (consecutive fields of one section stay together). */
export function groupBySection(fields: NewCaseField[]): { title: string | null; fields: NewCaseField[] }[] {
  const groups: { title: string | null; fields: NewCaseField[] }[] = [];
  for (const f of fields) {
    const last = groups[groups.length - 1];
    if (last && last.title === f.section) last.fields.push(f);
    else groups.push({ title: f.section, fields: [f] });
  }
  return groups;
}

export type NewCaseInput = {
  p_template_id: string;
  p_values: Record<string, string>;
  p_owner_id: string | null;
  p_note: string | null;
};

export type NewCaseFormState = {
  error: string | null;
  fieldErrors: Record<string, string>;
  /** What was submitted (field key -> values; plus `owner` and `note`), so the form keeps it after an error. */
  values: Record<string, string[]>;
  /** Set by the server action on every failed attempt; the form remounts with `values` (React resets forms after an action). */
  attempt?: number;
};
export const NEW_CASE_IDLE: NewCaseFormState = { error: null, fieldErrors: {}, values: {} };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Reads `f:<key>` values (several for multi_choice), `owner`, `note`, `template_id`. */
export function readNewCaseForm(entries: Iterable<[string, unknown]>): { templateId: string; values: Record<string, string[]> } {
  const values: Record<string, string[]> = {};
  let templateId = "";
  for (const [name, raw] of entries) {
    if (typeof raw !== "string") continue;
    if (name === "template_id") templateId = raw.trim();
    else if (name === "owner" || name === "note") values[name] = [raw];
    else if (name.startsWith(FIELD_PREFIX)) {
      const key = name.slice(FIELD_PREFIX.length);
      (values[key] ??= []).push(raw);
    }
  }
  return { templateId, values };
}

/**
 * Validates the form against the template's intake fields and the caller's role.
 * `ownerIds`: the owners the select offered (orchestrator / admin only).
 */
export function validateNewCase(
  form: { templateId: string; values: Record<string, string[]> },
  fields: NewCaseField[],
  ctx: { role: UserRole; ownerIds: ReadonlySet<string> },
): { errors: Record<string, string>; formError: string | null; input: NewCaseInput | null } {
  const errors: Record<string, string> = {};
  if (!isGuid(form.templateId)) return { errors, formError: "Reload the page and try again.", input: null };

  const out: Record<string, string> = {};
  for (const f of fields) {
    const norm = normaliseValue(f.type, form.values[f.key] ?? [], f.options, f.required);
    if (norm.error) errors[f.key] = norm.error;
    else if (norm.value !== null) out[f.key] = norm.value;
  }

  let owner: string | null = null;
  if (canChooseOwner(ctx.role)) {
    const raw = str(form.values.owner?.[0]).trim();
    if (raw && raw !== AUTO_OWNER) {
      if (!isGuid(raw) || !ctx.ownerIds.has(raw)) errors.owner = "Choose one of the listed people.";
      else owner = raw;
    }
  }

  const note = str(form.values.note?.[0]).replace(/\r\n/g, "\n").trim();
  if (note.length > NOTE_MAX) errors.note = `At most ${NOTE_MAX} characters.`;

  if (Object.keys(errors).length) return { errors, formError: "Check the highlighted fields.", input: null };
  return { errors, formError: null, input: { p_template_id: form.templateId, p_values: out, p_owner_id: owner, p_note: note || null } };
}

/**
 * Field-level placement of create_case_direct errors: duplicate claim no. and an empty required field go next to the
 * field; everything else is a form error (message already mapped for people).
 */
export function placeCreateError(
  code: string | null | undefined,
  message: string,
  fields: NewCaseField[],
): { formError: string; fieldErrors: Record<string, string> } {
  if (code === "23505") return { formError: "This claim is already on file.", fieldErrors: { [CLAIM_NO_KEY]: message } };
  if (code === "22023") {
    if (/claim number is (required|too long)/i.test(message)) return { formError: "Check the highlighted fields.", fieldErrors: { [CLAIM_NO_KEY]: message } };
    const m = /^Required fields are empty: (.+)$/.exec(message);
    if (m) {
      const labels = new Set(m[1].split(", ").map((s) => s.trim()));
      const fieldErrors: Record<string, string> = {};
      for (const f of fields) if (labels.has(f.label)) fieldErrors[f.key] = "This field is required.";
      if (Object.keys(fieldErrors).length) return { formError: "Check the highlighted fields.", fieldErrors };
    }
    if (/^(Unknown field|Choose a template that is in use)/.test(message))
      return { formError: "The template changed since this page was opened. Reload the page and try again.", fieldErrors: {} };
    if (/owner must be/i.test(message)) return { formError: "Check the highlighted fields.", fieldErrors: { owner: message } };
  }
  return { formError: message, fieldErrors: {} };
}
