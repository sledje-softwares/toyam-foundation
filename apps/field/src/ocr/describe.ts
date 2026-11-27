// Short description of a photo, built on the phone from the operator's tag and the OCR of the 1600 px
// copy (no model; the test phone is a low-end Galaxy F12). Stored once per file (evidence_ocr.summary)
// and shown to staff for the original and both copies (they show the same picture).
//
//   "<category name if tagged, else Photo / Document>; text read from the 1600 px copy: <line> · <line> · <line>"
//   "<…>; no text read"
// At most DESCRIPTION_MAX characters. Text is quoted as read (D55: no masking before the report step).

export const DESCRIPTION_MAX = 200;
const MAX_LINES = 3;

/** Text density guess when the operator gave no tag: lots of text = a document photographed. */
export function guessKind(lines: readonly string[], coverage: number): 'Photo' | 'Document' {
  const chars = lines.reduce((n, l) => n + l.length, 0);
  return coverage >= 0.12 || (lines.length >= 8 && chars >= 120) ? 'Document' : 'Photo';
}

/** A line worth quoting: at least 3 letters / digits and mostly letters / digits (not OCR noise). */
export function meaningful(line: string): boolean {
  const t = line.trim();
  const alnum = (t.match(/[A-Za-z0-9\u00C0-\u024F\u0900-\u097F]/g) ?? []).length; // no \p{…}: keep Hermes-safe
  return alnum >= 3 && alnum / t.replace(/\s/g, '').length >= 0.6;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export function describePhoto(input: { categoryName: string | null; lines: readonly string[]; coverage: number }): string {
  const tag = input.categoryName?.replace(/\s+/g, ' ').trim();
  const kind = tag ? tag.slice(0, 60) : guessKind(input.lines, input.coverage);
  const seen = new Set<string>();
  const quoted: string[] = [];
  for (const raw of input.lines) {
    const l = raw.replace(/\s+/g, ' ').trim();
    const key = l.toLowerCase();
    if (!meaningful(l) || seen.has(key)) continue;
    seen.add(key);
    quoted.push(l);
    if (quoted.length === MAX_LINES) break;
  }
  if (quoted.length === 0) return `${kind}; no text read`;
  return clip(`${kind}; text read from the 1600 px copy: ${quoted.join(' · ')}`, DESCRIPTION_MAX);
}
