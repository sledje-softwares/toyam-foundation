// Field value rules on OCR text (6.5, docs/10 "Rules engine" / "Second opinion on numbers"). Pure functions.
// Rules suggest; the office accepts or rejects in the report workspace (rule 5). Values only for the fields
// the label stage matched or whose sections list the file's categories.
import type { OcrBlock } from './types.ts';

export interface FieldSpec { key: string; label: string; field_type: string }
export interface Candidate { value: string; confidence: number; block_index: number }

type Kind = 'registration' | 'chassis' | 'engine' | 'dl' | 'policy' | 'claim' | 'date' | 'amount' | 'odometer';

const STATE_CODES = new Set(('AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UA UP WB').split(' '));

/** Which rule a field gets, from its key first and its type second. Null = no rule (free text). */
export function ruleKind(f: FieldSpec): Kind | null {
  const k = f.key.toLowerCase();
  if (/(^|_)(reg|registration)_?(no|num|number)$|^vehicle_no$|^vehicle_number$|^registration_no$/.test(k)) return 'registration';
  if (/chassis|vin/.test(k)) return 'chassis';
  if (/^engine_?(no|num|number)$/.test(k)) return 'engine';
  if (/^dl_?(no|num|number)$|licen[cs]e_?(no|num|number)$/.test(k)) return 'dl';
  if (/polic(y|ies)_?(no|num|number)$/.test(k)) return 'policy';
  if (/claim_?(no|num|number)$/.test(k)) return 'claim';
  if (/odometer/.test(k)) return 'odometer';
  if (f.field_type === 'date' || f.field_type === 'datetime' || /(_|^)(date|dob)$|_date_|^date_/.test(k)) return 'date';
  if (f.field_type === 'currency' || /amount|estimate_value|_cost$/.test(k)) return 'amount';
  return null;
}

/** Label words near a value for keys that share a value shape (several dates or amounts on one page). */
const HINTS: Record<string, RegExp> = {
  reg_date: /reg(n|d|istration)?\.?\s*(date|dt)|date\s*of\s*reg/i,
  driver_dob: /d\.?\s*o\.?\s*b|date\s*of\s*birth|birth/i,
  dl_validity: /valid(ity)?|non[-\s]?transport|\bnt\b|expir/i,
  loss_datetime: /loss|accident|incident/i,
  intimation_datetime: /intimat/i,
  garage_entry: /entry|in\s*date|job\s*card\s*date|received/i,
  policy_period: /period|from|to/i,
};

export function normalise(s: string): string {
  return s.toUpperCase().replace(/[\s.\-/]+/g, '');
}

// --- value finders: each returns [value, base confidence] per match in a text ------------------------------

function registrations(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const t = text.toUpperCase();
  for (const m of t.matchAll(/\b([A-Z]{2})[\s.\-]?(\d{1,2})[\s.\-]?([A-Z]{0,3})[\s.\-]?(\d{4})\b/g)) {
    const v = `${m[1]}${m[2].padStart(2, '0')}${m[3]}${m[4]}`;
    out.push([v, STATE_CODES.has(m[1]) ? 0.8 : 0.4]);
  }
  for (const m of t.matchAll(/\b(\d{2})[\s.\-]?BH[\s.\-]?(\d{4})[\s.\-]?([A-Z]{1,2})\b/g)) out.push([`${m[1]}BH${m[2]}${m[3]}`, 0.8]);
  return out;
}

/** 17-character VIN: letters and digits, never I, O or Q; must contain both letters and digits. */
function chassisNumbers(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of text.toUpperCase().matchAll(/\b([A-HJ-NPR-Z0-9]{17})\b/g)) {
    const v = m[1];
    if (!/[A-Z]/.test(v) || !/\d/.test(v)) continue;
    out.push([v, v.startsWith('M') ? 0.85 : 0.7]);      // WMI starting with M = made in India
  }
  return out;
}

function dlNumbers(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const t = text.toUpperCase();
  // SS RR YYYY NNNNNNN (15 characters, separators optional)
  for (const m of t.matchAll(/\b([A-Z]{2})[\s\-]?(\d{2})[\s\-]?((?:19|20)\d{2})[\s\-]?(\d{7})\b/g)) {
    out.push([`${m[1]}${m[2]}${m[3]}${m[4]}`, STATE_CODES.has(m[1]) ? 0.85 : 0.5]);
  }
  // older formats: SS-RR/NNNN/YYYY
  for (const m of t.matchAll(/\b([A-Z]{2})[\s\-]?(\d{2})[\s\/\-](\d{3,7})[\s\/\-]((?:19|20)\d{2})\b/g)) {
    if (STATE_CODES.has(m[1])) out.push([`${m[1]}${m[2]}/${m[3]}/${m[4]}`, 0.6]);
  }
  return out;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Indian order (day first): dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, dd-Mon-yyyy, and ISO yyyy-mm-dd. Returns ISO. */
export function dates(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const v = isoDate(+m[1], +m[2], +m[3]);
    if (v) out.push([v, 0.7]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4}|\d{2})\b/g)) {
    const v = isoDate(+m[3], +m[2], +m[1]);
    if (v) out.push([v, m[3].length === 4 ? 0.6 : 0.4]);
  }
  for (const m of text.toUpperCase().matchAll(/\b(\d{1,2})[\s.\-\/]*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*[\s.\-\/,]*(\d{4})\b/g)) {
    const v = isoDate(+m[3], MONTHS[m[2]], +m[1]);
    if (v) out.push([v, 0.65]);
  }
  return out;
}

export function amounts(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of text.matchAll(/(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d{1,2})?)/gi)) {
    const v = m[1].replace(/,/g, '');
    if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) out.push([v, 0.6]);
  }
  return out;
}

/** A value written after a label: "Policy No: 3001/123456/00/000". */
function labelled(text: string, label: RegExp, conf: number): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = new RegExp(`${label.source}\\s*[:#.\\-]*\\s*([A-Z0-9][A-Z0-9\\/\\-]{4,34})`, 'gi');
  for (const m of text.matchAll(re)) {
    const v = m[m.length - 1].replace(/[\-\/]+$/, '').toUpperCase();
    if (/\d/.test(v) && v.replace(/\D/g, '').length >= 4) out.push([v, conf]);
  }
  return out;
}

function odometerReadings(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const m of text.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{3,7})(?:\s*(?:km|kms|KM))?\b/g)) {
    const v = m[1].replace(/,/g, '');
    if (!/^(19|20)\d{2}$/.test(v)) out.push([v, /km/i.test(m[0]) ? 0.5 : 0.3]);
  }
  return out;
}

function find(kind: Kind, text: string): Array<[string, number]> {
  switch (kind) {
    case 'registration': return registrations(text);
    case 'chassis': return chassisNumbers(text);
    case 'engine': return labelled(text, /\b(?:engine|eng)\.?\s*(?:no|number|num)?\.?/, 0.6);
    case 'dl': return dlNumbers(text);
    case 'policy': return labelled(text, /\bpolicy\s*(?:no|number|num)\.?/, 0.75);
    case 'claim': return labelled(text, /\bclaim\s*(?:no|number|num|ref)\.?/, 0.75);
    case 'date': return dates(text);
    case 'amount': return amounts(text);
    case 'odometer': return odometerReadings(text);
  }
}

/**
 * Candidates for one field from one page's blocks, best first (at most `max`). Values that need a label nearby
 * (dates, amounts) get a confidence bonus when the field's hint or a word of its label is on the same line.
 */
export function suggestForField(field: FieldSpec, blocks: OcrBlock[], max = 3): Candidate[] {
  const kind = ruleKind(field);
  if (!kind) return [];
  const best = new Map<string, Candidate>();
  const lineText = new Map<number, string>();
  for (const b of blocks) lineText.set(b.line, `${lineText.get(b.line) ?? ''} ${b.text}`);
  const hint = HINTS[field.key] ?? labelWords(field.label);
  const needsContext = kind === 'date' || kind === 'amount';
  const singleDate = needsContext ? countDistinct(blocks, kind) === 1 : false;

  blocks.forEach((b, i) => {
    // labelled values: look at the whole line so "Policy No" and the number may be separate blocks
    const text = kind === 'engine' || kind === 'policy' || kind === 'claim' ? (lineText.get(b.line) ?? b.text) : b.text;
    for (const [value, base] of find(kind, text)) {
      let conf = base * (0.5 + 0.5 * (Number.isFinite(b.conf) ? b.conf : 1));
      if (needsContext) {
        // the label on the same line counts most; a label on the line above (stacked layouts) a little less
        if (hint && hint.test(lineText.get(b.line) ?? '')) conf = Math.min(1, conf + 0.25);
        else if (hint && hint.test(lineText.get(b.line - 1) ?? '')) conf = Math.min(1, conf + 0.1);
        else if (!singleDate) conf *= 0.5;
      }
      const prev = best.get(value);
      if (!prev || conf > prev.confidence) best.set(value, { value, confidence: round2(conf), block_index: i });
    }
  });
  return [...best.values()].filter((c) => c.confidence >= 0.15).sort((a, b) => b.confidence - a.confidence).slice(0, max);
}

function countDistinct(blocks: OcrBlock[], kind: Kind): number {
  const s = new Set<string>();
  for (const b of blocks) for (const [v] of find(kind, b.text)) s.add(v);
  return s.size;
}

function labelWords(label: string): RegExp | null {
  const words = label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !['date', 'time', 'number', 'amount', 'details'].includes(w));
  return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
