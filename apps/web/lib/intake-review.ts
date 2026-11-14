/**
 * Intake review (3.9): pure helpers shared by the queue, the review screen and its server action.
 * No React, no Next, no Supabase, so they are unit-tested.
 */

import type { Tone } from "@/components/ui/badge";

/** Values below this parser confidence are highlighted for a second look. */
export const LOW_CONFIDENCE = 0.8;

/** confirm_intake() reads the claim number from p_values under this key. */
export const CLAIM_KEY = "insurer_claim_no";

/** Form input names for template fields are prefixed so they never clash with control inputs. */
export const FIELD_PREFIX = "f:";

/** Template field keys (snake_case, as loaded from config/templates). */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const MAX_VALUE_LENGTH = 4000;

// ---------------------------------------------------------------------
// Why an item is in the queue
// ---------------------------------------------------------------------
export type ReviewReason = "reply_no_case" | "no_template" | "missing_fields" | "uncertain";

export const REVIEW_REASONS: Record<ReviewReason, { label: string; tone: Tone; hint: string }> = {
  reply_no_case: {
    label: "Reply, no case",
    tone: "info",
    hint: "A reply or forward that matched no existing case.",
  },
  no_template: {
    label: "No template",
    tone: "danger",
    hint: "No active template of this insurer matched the email. Choose the insurer and template.",
  },
  missing_fields: {
    label: "Missing fields",
    tone: "warning",
    hint: "The template matched but some required fields were not found in the email.",
  },
  uncertain: {
    label: "Uncertain",
    tone: "warning",
    hint: "All required fields were found, but the template was chosen without a subject match or by AI. Check the values.",
  },
};

export const REVIEW_REASON_KEYS = Object.keys(REVIEW_REASONS) as ReviewReason[];

export function isReviewReason(v: string | undefined | null): v is ReviewReason {
  return !!v && (REVIEW_REASON_KEYS as string[]).includes(v);
}

/** Same precedence as the queue filter in app/(app)/intake/page.tsx. */
export function reviewReason(x: {
  parser_action: string | null;
  template_id: string | null;
  missing_required: string[] | null;
}): ReviewReason {
  if (x.parser_action === "attach_to_case") return "reply_no_case";
  if (!x.template_id) return "no_template";
  if ((x.missing_required ?? []).length > 0) return "missing_fields";
  return "uncertain";
}

// ---------------------------------------------------------------------
// jsonb columns of intake_extractions
// ---------------------------------------------------------------------
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** intake_extractions.extracted: {key: value}. Non-string scalars are stringified; null/objects dropped. */
export function asStringMap(json: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(json)) return out;
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** intake_extractions.field_confidence: {key: 0..1}. */
export function asNumberMap(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(json)) return out;
  for (const [k, v] of Object.entries(json)) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    if (Number.isFinite(n)) out[k] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/** case_template_fields.options: a list of strings (or {value,label} objects) for choice fields. */
export function asOptions(json: unknown): string[] | null {
  if (!Array.isArray(json)) return null;
  const opts = json
    .map((o) => (typeof o === "string" ? o : isRecord(o) && typeof o.value === "string" ? o.value : null))
    .filter((o): o is string => !!o);
  return opts.length ? opts : null;
}

// ---------------------------------------------------------------------
// Form model
// ---------------------------------------------------------------------
export type TemplateFieldDef = {
  key: string;
  label: string;
  field_type: string;
  is_required: boolean;
  options?: unknown;
  help_text?: string | null;
  /** Ordering: section position, then field position. */
  section_position?: number | null;
  position?: number | null;
  section_title?: string | null;
};

export type FieldIssue = { kind: "missing" | "low_confidence"; message: string };

export type ReviewFieldModel = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
  confidence: number | null;
  options: string[] | null;
  help: string | null;
  section: string | null;
  issue: FieldIssue | null;
};

function issueFor(
  key: string,
  required: boolean,
  value: string,
  confidence: number | null,
  missingRequired: ReadonlySet<string>,
): FieldIssue | null {
  if (!value.trim()) {
    if (missingRequired.has(key)) return { kind: "missing", message: "Required, and not found in the email." };
    if (required) return { kind: "missing", message: "Required. Fill it in from the email." };
    return null;
  }
  if (confidence !== null && confidence < LOW_CONFIDENCE) {
    return {
      kind: "low_confidence",
      message: `Low confidence (${Math.round(confidence * 100)}%). Check it against the email.`,
    };
  }
  return null;
}

/**
 * Builds the review form: the claim number (always shown, always required, because confirm_intake needs it)
 * and the template's other intake fields in template order, each pre-filled from the parser output and
 * flagged when missing or low-confidence.
 */
export function buildReviewForm(
  fields: TemplateFieldDef[],
  extracted: Record<string, string>,
  confidence: Record<string, number>,
  missingRequired: string[],
): { claim: ReviewFieldModel; fields: ReviewFieldModel[]; issueCount: number } {
  const missing = new Set(missingRequired);
  const sorted = [...fields].sort(
    (a, b) => (a.section_position ?? 0) - (b.section_position ?? 0) || (a.position ?? 0) - (b.position ?? 0),
  );
  const model = (f: TemplateFieldDef, required: boolean): ReviewFieldModel => {
    const value = extracted[f.key] ?? "";
    const conf = f.key in confidence ? confidence[f.key] : null;
    return {
      key: f.key,
      label: f.label,
      type: f.field_type,
      required,
      value,
      confidence: conf,
      options: asOptions(f.options),
      help: f.help_text ?? null,
      section: f.section_title ?? null,
      issue: issueFor(f.key, required, value, conf, missing),
    };
  };

  const claimDef = sorted.find((f) => f.key === CLAIM_KEY) ?? {
    key: CLAIM_KEY,
    label: "Claim no.",
    field_type: "text",
    is_required: true,
  };
  const claim = model(claimDef, true);
  const rest = sorted.filter((f) => f.key !== CLAIM_KEY).map((f) => model(f, f.is_required));
  const issueCount = [claim, ...rest].filter((m) => m.issue).length;
  return { claim, fields: rest, issueCount };
}

// ---------------------------------------------------------------------
// Submitted values
// ---------------------------------------------------------------------
/**
 * Reads `f:<key>` entries of the submitted form into {key: trimmed value}. Only `allowedKeys` are kept
 * (the chosen template's intake fields plus the claim number); empty values are dropped.
 */
export function readSubmittedValues(
  entries: Iterable<[string, unknown]>,
  allowedKeys: Iterable<string>,
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  const out: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!name.startsWith(FIELD_PREFIX) || typeof raw !== "string") continue;
    const key = name.slice(FIELD_PREFIX.length);
    if (!FIELD_KEY_RE.test(key) || !allowed.has(key)) continue;
    const value = raw.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Field errors for required fields left empty (the database checks again in confirm_intake). */
export function requiredErrors(
  fields: Pick<TemplateFieldDef, "key" | "is_required">[],
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values[CLAIM_KEY]) errors[CLAIM_KEY] = "Enter the claim number.";
  for (const f of fields) {
    if (f.key !== CLAIM_KEY && f.is_required && !values[f.key]) errors[f.key] = "This field is required.";
  }
  return errors;
}

/**
 * Flash after confirming intake when the new (or matched) case is assigned to someone else (D44):
 * the confirming office user cannot open it, so they go back to the queue with the reference.
 */
export function confirmedElsewhereMessage(caseRef: string | null | undefined): string {
  return caseRef
    ? `Intake confirmed: case ${caseRef}. It is assigned to another office employee, so it does not open for you.`
    : "Intake confirmed. The case is assigned to another office employee.";
}

/** "IGI Motor OD · standard v3" style label for a template. */
export function templateLabel(t: { name: string; variant: string; version?: number | null }): string {
  return `${t.name} · ${t.variant}${t.version ? ` v${t.version}` : ""}`;
}
