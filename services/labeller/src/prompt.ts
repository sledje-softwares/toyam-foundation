// Prompt and answer parser for the vision labeller (D30, D34, D35).
// One call per image returns: labels (categories), the report fields the image is evidence for
// (sections follow from the fields and from the categories), and a short description only where
// one is useful. Values (numbers, dates) are NOT read here — OCR + rules do that.
// Shared by the bake-off script and, later, the pipeline worker's `label` stage.
// Runs in Node (type stripping) and Deno: no npm imports here.

export interface LabelCategory {
  code: string;
  name: string;
  description?: string;
  default_evidence_type?: string;
}

/** The case template's sections and fields (config/templates/*.yaml). */
export interface LabelTemplate {
  sections: Array<{
    key: string;
    title: string;
    categories?: string[];
    fields?: Array<{ key: string; label: string; help?: string }>;
  }>;
}

export interface LabelChoice {
  code: string;
  confidence: number;
}

export interface FieldMatch {
  key: string;                    // field key from the template
  confidence: number;
}

export interface LabelAnswer {
  ok: boolean;
  labels: LabelChoice[];          // best first, at most MAX_LABELS
  fields: FieldMatch[];           // best first, at most MAX_FIELDS; empty without a template
  needs_detail: boolean;
  detail_reason: string | null;
  description: string | null;     // only where useful (D35)
  error?: string;                 // why the answer was not usable as given
}

export const MAX_LABELS = 3;
export const MAX_FIELDS = 5;
export const PROMPT_VERSION = 'label-v2';

/** Field keys of a template (unique within a template). */
export function templateFieldKeys(t: LabelTemplate | undefined): Set<string> {
  return new Set((t?.sections ?? []).flatMap((s) => (s.fields ?? []).map((f) => f.key)));
}

/**
 * Sections an image belongs to: those of its matched fields, plus those whose categories include
 * one of its labels. In template order.
 */
export function sectionsFor(t: LabelTemplate, labels: string[], fields: string[]): string[] {
  const l = new Set(labels);
  const f = new Set(fields);
  return t.sections
    .filter((s) => (s.categories ?? []).some((c) => l.has(c)) || (s.fields ?? []).some((x) => f.has(x.key)))
    .map((s) => s.key);
}

/**
 * System prompt: categories, the template's report fields grouped by section, and the answer
 * format. Stable per template version, so it can be cached.
 */
export function buildSystemPrompt(categories: LabelCategory[], template?: LabelTemplate, opts: { collage?: boolean } = {}): string {
  const list = categories
    .map((c) => `- ${c.code}: ${c.name}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n');
  const fieldLines = (template?.sections ?? [])
    .filter((s) => (s.fields ?? []).length)
    .map((s) => [`${s.title}:`, ...(s.fields ?? []).map((f) => `- ${f.key}: ${f.label}${f.help ? ` (${f.help})` : ''}`)].join('\n'));
  const withFields = fieldLines.length > 0;
  const collage = opts.collage === true;
  const one = withFields
    ? '{"labels":[{"code":"<category code>","confidence":<0..1>}],"fields":[{"key":"<field key>","confidence":<0..1>}],"needs_detail":<true|false>,"detail_reason":"<short reason or null>","description":"<one factual sentence or null>"}'
    : '{"labels":[{"code":"<category code>","confidence":<0..1>}],"needs_detail":<true|false>,"detail_reason":"<short reason or null>","description":"<one factual sentence or null>"}';
  return [
    'You label evidence files for a motor and general insurance claim investigation firm in India.',
    collage
      ? 'Each request contains one picture made of numbered cells in a grid. Each cell is a separate file: a photo taken by a field investigator, a screenshot, or a scanned or photographed document. The cell number is in the yellow box at its top-left corner.'
      : 'Each request contains one image: a photo taken by a field investigator, a screenshot, or a scanned or photographed document.',
    '',
    'Choose the category or categories that describe the image, from this list only:',
    list,
    ...(withFields ? [
      '',
      'The investigation report has these fields, grouped by section. Choose the fields this image is evidence for:',
      fieldLines.join('\n\n'),
    ] : []),
    '',
    'Answer with one JSON object and nothing else:',
    collage ? `{"images":[{"n":<cell number>,${one.slice(1)}]}` : one,
    '',
    'Rules:',
    ...(collage ? [
      '- Answer for every numbered cell, in number order, with "n" set to the cell number. Never skip a cell, even if it is blurred or unclear.',
      '- Judge each cell on its own. Never use what is visible in a neighbouring cell. Ignore empty black cells.',
      '- "at this resolution" below means the size of the cell.',
    ] : []),
    `- labels: best first, at most ${MAX_LABELS}. Add a second label only when the image clearly shows both (for example an odometer and a chassis plate). Use "other" when nothing fits.`,
    '- confidence: how sure you are of each label. Use lower values when the image is blurred, cropped or ambiguous.',
    '- needs_detail: true when the image carries text, numbers or a small detail that a report may need and that cannot be read reliably at this resolution (documents, number plates, odometer readings, stamped chassis or engine numbers, screenshots). false for general views of a vehicle, a place or a person.',
    '- detail_reason: a few words naming what must be read (for example "registration number", "odometer reading"); null when needs_detail is false.',
    ...(withFields ? [
      `- fields: the report fields this image shows or supports, best first, at most ${MAX_FIELDS}. A driving licence supports the licence fields; an odometer photo supports the odometer reading; a general vehicle view may support none. Use [] when no field fits. Do not read or return the values.`,
    ] : []),
    '- description: only when it adds something the labels do not say — visible damage and where it is, the scene of a place, a person shown, or an image you labelled "other" or with low confidence. At most 25 words. Otherwise null (for example a clear RC, DL, policy copy or bill). Do not guess identities, do not judge whether the claim is genuine, and do not copy personal numbers from documents.',
  ].join('\n');
}

export const USER_INSTRUCTION = 'Label this image.';

/** Parse and validate a model answer against the allowed category codes and field keys. Never throws. */
export function parseLabelAnswer(text: string, allowedCodes: Set<string>, allowedFields: Set<string> = new Set()): LabelAnswer {
  const empty: LabelAnswer = { ok: false, labels: [], fields: [], needs_detail: true, detail_reason: null, description: null };
  const json = extractJson(text);
  if (json === null) return { ...empty, error: 'no JSON object in the answer' };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ...empty, error: 'answer is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...empty, error: 'answer is not an object' };
  const obj = raw as Record<string, unknown>;

  const problems: string[] = [];
  const labels: LabelChoice[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(obj.labels) ? obj.labels : []) {
    if (typeof item !== 'object' || item === null) continue;
    const code = String((item as Record<string, unknown>).code ?? '').trim();
    if (!allowedCodes.has(code)) {
      problems.push(`unknown category "${code}"`);
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    labels.push({ code, confidence: clamp01(Number((item as Record<string, unknown>).confidence)) });
  }
  labels.sort((a, b) => b.confidence - a.confidence);
  if (labels.length > MAX_LABELS) labels.length = MAX_LABELS;
  if (labels.length === 0) problems.push('no valid label');

  const fields: FieldMatch[] = [];
  const seenFields = new Set<string>();
  for (const item of Array.isArray(obj.fields) ? obj.fields : []) {
    if (typeof item !== 'object' || item === null) continue;
    const key = String((item as Record<string, unknown>).key ?? '').trim();
    if (!allowedFields.has(key)) {
      problems.push(`unknown field "${key}"`);
      continue;
    }
    if (seenFields.has(key)) continue;
    seenFields.add(key);
    fields.push({ key, confidence: clamp01(Number((item as Record<string, unknown>).confidence)) });
  }
  fields.sort((a, b) => b.confidence - a.confidence);
  if (fields.length > MAX_FIELDS) fields.length = MAX_FIELDS;

  // A missing or malformed flag is treated as "needs detail": a wasted OCR run is cheaper than a missed number.
  const needsDetail = typeof obj.needs_detail === 'boolean' ? obj.needs_detail : true;
  if (typeof obj.needs_detail !== 'boolean') problems.push('needs_detail missing');
  const reason = typeof obj.detail_reason === 'string' && obj.detail_reason.trim() !== '' ? obj.detail_reason.trim().slice(0, 300) : null;
  const description = typeof obj.description === 'string' && obj.description.trim() !== '' && obj.description.trim().toLowerCase() !== 'null'
    ? obj.description.trim().slice(0, 1000) : null;

  return {
    ok: labels.length > 0,
    labels,
    fields,
    needs_detail: needsDetail,
    detail_reason: needsDetail ? reason : null,
    description,
    ...(problems.length ? { error: problems.join('; ') } : {}),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** First balanced {...} block, ignoring code fences and text around it. */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
