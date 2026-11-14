// Field extraction for one template: subject groups → table labels → regex → text blocks.
import { htmlRows, htmlToText, textRows } from './html.ts';
import { buildIndex, findLabel, normLabel } from './table.ts';
import type { ExtractedValue, IntakeConfig, IntakeTemplate, ParsedEmail } from './types.ts';

export function bodyText(email: ParsedEmail): string {
  const t = email.text?.trim();
  if (t) return t;
  return email.html ? htmlToText(email.html) : '';
}

/** Lines between `startsAfter` and `until` (case-insensitive), tidied into a list. */
export function extractBlock(text: string, startsAfter: string, until?: string): string | null {
  const lower = text.toLowerCase();
  const s = lower.indexOf(startsAfter.toLowerCase());
  if (s < 0) return null;
  let start = text.indexOf('\n', s + startsAfter.length);
  if (start < 0) start = s + startsAfter.length;
  let end = text.length;
  if (until) {
    const u = lower.indexOf(until.toLowerCase(), start);
    if (u >= 0) end = u;
  }
  const lines = text
    .slice(start, end)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '' && !/^(thanks|regards|with regards|thanks & best regards)\b/i.test(l));
  const out = lines.join('\n').trim();
  return out === '' ? null : out.slice(0, 4000);
}

function cleanValue(v: string): string {
  return v.replace(/\s+/g, ' ').replace(/^[:\-–\s]+/, '').trim();
}

function isBlank(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  const t = v.trim();
  return t === '' || /^[-–_.]+$/.test(t);
}

export interface FieldResult {
  fields: Record<string, ExtractedValue>;
  missing: string[];
  rowsSource: 'table' | 'text';
}

/** All labels the insurer's templates know — used to spot misaligned text cells. */
export function knownLabels(cfg: IntakeConfig, insurerId: string): Set<string> {
  const s = new Set<string>();
  for (const t of cfg.templates) {
    if (t.insurer_id !== insurerId) continue;
    for (const f of t.fields) for (const l of f.extract.labels ?? []) s.add(normLabel(l));
  }
  return s;
}

export function extractFields(
  email: ParsedEmail,
  template: IntakeTemplate,
  subjectValues: Record<string, string>,
  labels: Set<string>,
): FieldResult {
  const html = email.html ?? '';
  const useTable = /<tr\b/i.test(html);
  const rows = useTable ? htmlRows(html) : textRows(bodyText(email));
  const index = buildIndex(rows);
  const text = bodyText(email);
  const fields: Record<string, ExtractedValue> = {};
  const baseConfidence = useTable ? 0.95 : 0.8;
  const points = template.intake_rules.investigation_points;

  for (const f of template.fields) {
    let hit: ExtractedValue | null = null;

    if (!isBlank(subjectValues[f.key])) {
      hit = { value: cleanValue(subjectValues[f.key]), confidence: 1, source: 'subject' };
    } else if (f.key === 'investigation_points' && points) {
      const block = extractBlock(text, points.starts_after, points.until);
      if (block) hit = { value: block, confidence: 0.9, source: 'block' };
    } else if (f.extract.labels?.length) {
      const parts: string[] = [];
      for (const l of f.extract.labels) {
        const found = findLabel(index, l, f.extract.within, labels);
        if (found && !isBlank(found.value)) parts.push(cleanValue(found.value));
      }
      if (parts.length > 0) {
        const sep = f.type === 'date' || f.type === 'datetime' ? ' ' : ', ';
        hit = { value: parts.join(sep), confidence: baseConfidence, source: useTable ? 'table' : 'text' };
      }
    }

    if (!hit && f.extract.regex) {
      try {
        const m = new RegExp(f.extract.regex, 'i').exec(text);
        const v = m?.[1] ?? m?.[0];
        if (!isBlank(v)) hit = { value: cleanValue(v!), confidence: 0.7, source: 'regex' };
      } catch { /* invalid pattern: ignore */ }
    }

    if (hit) fields[f.key] = hit;
  }

  const missing = template.fields.filter((f) => f.required && !fields[f.key]).map((f) => f.key);
  return { fields, missing, rowsSource: useTable ? 'table' : 'text' };
}
