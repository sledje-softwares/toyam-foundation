// Aadhaar masking at report time (D55). OCR text and blocks are stored as read; only the copy of a photo that is
// placed in a generated report gets the first 8 digits of every Aadhaar-like number blacked out (UIDAI "masked
// Aadhaar": the last 4 may stay). Report text is not masked. The evidence file and its copies are never changed
// (rule 2): the painter works on the bytes fetched for the report.
//
// Pure: finds the numbers in OCR blocks (one block per text line, bbox [x, y, w, h] in the pixels of the image that
// was read: the 1600 px copy for device OCR, `evidence_ocr.source_width`; the original for server OCR), estimates
// the x-range of the first 8 digits inside a block by character widths, pads generously and scales to the embedded
// image. The pixel work is an injected Painter (browser canvas, apps/web/lib/report-build/mask-image.ts).
// No npm imports (Deno + Node type stripping).
import type { PhotoMasker } from './assemble.ts';
import type { ReportImage } from './bind.ts';

export interface OcrBlockLike {
  text: string;
  bbox: [number, number, number, number];
}

/** The evidence_ocr columns used here (any row of the file, current or not: each is a reading of the same picture). */
export interface OcrRowLike {
  evidence_id: string;
  page_no?: number | null;
  engine?: string | null;
  text?: string | null;
  blocks?: unknown;
  /** 1600 / 384 = blocks are in that device copy's pixels; null = the original's pixels. */
  source_width?: number | null;
  is_current?: boolean | null;
}

/** A rectangle; OCR-space boxes may be fractional, image rectangles are whole pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AadhaarHit {
  /** The text already read "XXXX XXXX 1234" (rows stored before D55 were masked on the phone). */
  premasked: boolean;
  /** Last 4 digits (for tests and logs; never printed). */
  last4: string;
  /** Boxes covering the first 8 digits, padded, in OCR coordinates (one per block the digits span). */
  boxes: Box[];
}

/** Extra width on each side of the estimated range, in digit widths. */
export const PAD_CHARS = 1;
/** Extra height above and below, as a share of the block height. */
export const PAD_Y = 0.15;
/** Two blocks of one row further apart than this many block heights are not read as one text. */
const JOIN_GAP = 1.5;
/** Largest relative difference of aspect ratio between OCR space and image that still maps. */
const ASPECT_TOLERANCE = 0.03;

/** Evidence categories that hold identity documents: a photo of one must be masked or reported. */
export const ID_CATEGORIES = new Set(['id_document']);
export const isIdCategory = (code: string | null | undefined): boolean =>
  typeof code === 'string' && (ID_CATEGORIES.has(code) || /aadha+r|kyc/i.test(code));

// ---------------------------------------------------------------------------------------------
// Blocks

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Valid blocks of an evidence_ocr.blocks value (anything malformed is dropped). */
export function readBlocks(v: unknown): OcrBlockLike[] {
  if (!Array.isArray(v)) return [];
  const out: OcrBlockLike[] = [];
  for (const b of v) {
    if (typeof b !== 'object' || b === null) continue;
    const o = b as Record<string, unknown>;
    if (typeof o.text !== 'string' || !o.text.trim() || !Array.isArray(o.bbox) || o.bbox.length !== 4) continue;
    const [x, y, w, h] = o.bbox.map(num);
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0 || x < 0 || y < 0) continue;
    out.push({ text: o.text, bbox: [x, y, w, h] });
  }
  return out;
}

// Devanagari digits ०-९ (U+0966-U+096F) read as ASCII digits; one UTF-16 unit each, so indices stay aligned.
const DEVA_ZERO = 0x0966;
const strictDigit = (c: string): string | null => {
  if (c >= '0' && c <= '9') return c;
  const k = c.charCodeAt(0) - DEVA_ZERO;
  return k >= 0 && k <= 9 ? String(k) : null;
};
// OCR confusions accepted inside a number (a match still needs 10 real digits)
const LENIENT: Record<string, string> = { O: '0', o: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', B: '8' };
const lenientDigit = (c: string): string => strictDigit(c) ?? LENIENT[c] ?? c;

/**
 * Relative advance width of a character (digit = 1): spaces and punctuation are narrow, capitals wide. Used to place
 * the number inside a block that holds more text ("Aadhaar No.: 2345 6789 0123").
 */
export function charWeight(c: string): number {
  if (strictDigit(c) !== null) return 1;
  if (c === ' ' || c === '\t') return 0.45;
  if ('.,:;|!\'`'.includes(c)) return 0.4;
  if (c === '-' || c === '/' || c === '(' || c === ')') return 0.6;
  const code = c.charCodeAt(0);
  // Devanagari signs and matras: narrow (or drawn over the consonant)
  if ((code >= 0x0900 && code <= 0x0903) || (code >= 0x093a && code <= 0x094f) || (code >= 0x0951 && code <= 0x0957) ||
      code === 0x0962 || code === 0x0963) return 0.3;
  if (c >= 'A' && c <= 'Z') return 1.15;
  if (c >= 'a' && c <= 'z') return c === 'i' || c === 'l' || c === 'j' || c === 't' || c === 'f' || c === 'r' ? 0.5 : 0.9;
  return 1;
}

/** Blocks on one text row (vertical centres within half a line), left to right; rows top to bottom. */
export function rowsOf(blocks: OcrBlockLike[]): OcrBlockLike[][] {
  const cy = (b: OcrBlockLike) => b.bbox[1] + b.bbox[3] / 2;
  const sorted = [...blocks].sort((a, b) => cy(a) - cy(b));
  const rows: OcrBlockLike[][] = [];
  for (const b of sorted) {
    const row = rows.find((r) => r.some((o) => Math.abs(cy(o) - cy(b)) <= Math.min(o.bbox[3], b.bbox[3]) / 2));
    if (row) row.push(b);
    else rows.push([b]);
  }
  for (const r of rows) r.sort((a, b) => a.bbox[0] - b.bbox[0]);
  return rows;
}

// 12 digits, first 2-9, plain or 4-4-4 with up to three spaces / hyphens / dots between groups.
const NUMBER = /([2-9][0-9]{3})([ \-.]{0,3})([0-9]{4})([ \-.]{0,3})([0-9]{4})/g;
// Already masked on the phone before D55: "XXXX XXXX 1234"
const PREMASKED = /([Xx*]{4})([ \-.]{0,3})([Xx*]{4})([ \-.]{0,3})([0-9]{4})/g;

interface Span {
  start: number;
  /** End of the first 8 digits (exclusive). */
  end8: number;
  end: number;
  premasked: boolean;
  last4: string;
}

/** Aadhaar-like numbers in one line of text (not part of a longer digit run). */
export function findNumbers(text: string): Span[] {
  const strict = text; // UTF-16 indices throughout
  const isDigitAt = (i: number) => i >= 0 && i < strict.length && strictDigit(strict[i]) !== null;
  const mapped = strict.split('').map(lenientDigit).join('');
  const out: Span[] = [];
  const scan = (re: RegExp, source: string, premasked: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const bad = isDigitAt(start - 1) || isDigitAt(end) ||
        (premasked ? /[Xx*]/.test(strict[start - 1] ?? '') : false);
      const real = premasked ? 4 : [...strict.slice(start, end)].filter((c) => strictDigit(c) !== null).length;
      if (bad || real < (premasked ? 4 : 10) || (!premasked && strictDigit(strict[start]) === null)) {
        re.lastIndex = start + 1;
        continue;
      }
      if (out.some((s) => start < s.end && end > s.start)) continue;
      out.push({ start, end8: start + m[1].length + m[2].length + m[3].length, end, premasked, last4: m[5] });
    }
  };
  scan(NUMBER, mapped, false);
  scan(PREMASKED, strict.replace(/[०-९]/g, (c) => strictDigit(c) ?? c), true);
  return out.sort((a, b) => a.start - b.start);
}

/** Number of Aadhaar-like numbers in a text (e.g. evidence_ocr.text when there are no blocks). */
export function countNumbers(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\r?\n/).reduce((n, line) => n + findNumbers(line).length, 0);
}

/** Box of characters [s, e) of a block, by character weights, padded. */
function segmentBox(b: OcrBlockLike, s: number, e: number): Box {
  const [x, y, w, h] = b.bbox;
  // UTF-16 units, like the indices findAadhaar works with (digits and Devanagari are one unit each)
  const weights = b.text.split('').map(charWeight);
  const total = weights.reduce((a, v) => a + v, 0) || 1;
  const before = weights.slice(0, s).reduce((a, v) => a + v, 0);
  const upto = weights.slice(0, e).reduce((a, v) => a + v, 0);
  const unit = w / total;
  const x0 = x + before * unit - PAD_CHARS * unit;
  const x1 = x + upto * unit + PAD_CHARS * unit;
  return { x: x0, y: y - h * PAD_Y, w: x1 - x0, h: h * (1 + 2 * PAD_Y) };
}

/**
 * Aadhaar-like numbers in OCR blocks, with boxes over their first 8 digits. Blocks of one row are read together
 * (a number split over two blocks is found); blocks far apart on a row are not joined.
 */
export function findAadhaar(blocks: OcrBlockLike[]): AadhaarHit[] {
  const hits: AadhaarHit[] = [];
  for (const row of rowsOf(blocks)) {
    // the row's text, with the block and character behind each position (-1 = joiner)
    let text = '';
    const at: { block: number; char: number }[] = [];
    row.forEach((b, bi) => {
      if (bi > 0) {
        const prev = row[bi - 1];
        const gap = b.bbox[0] - (prev.bbox[0] + prev.bbox[2]);
        text += gap <= JOIN_GAP * Math.min(prev.bbox[3], b.bbox[3]) ? ' ' : '\n';
        at.push({ block: -1, char: -1 });
      }
      for (let i = 0; i < b.text.length; i++) {
        text += b.text[i];
        at.push({ block: bi, char: i });
      }
    });
    for (const line of splitKeep(text)) {
      for (const span of findNumbers(line.text)) {
        // characters of the first 8 digits, grouped per block
        const per = new Map<number, { s: number; e: number }>();
        for (let i = line.offset + span.start; i < line.offset + span.end8; i++) {
          const p = at[i];
          if (p.block < 0) continue;
          const r = per.get(p.block);
          if (r) r.e = p.char + 1;
          else per.set(p.block, { s: p.char, e: p.char + 1 });
        }
        const boxes = [...per.entries()].map(([bi, r]) => segmentBox(row[bi], r.s, r.e));
        if (boxes.length) hits.push({ premasked: span.premasked, last4: span.last4, boxes });
      }
    }
  }
  return hits;
}

/** Splits at '\n' (joiners between distant blocks), keeping each piece's offset. */
function splitKeep(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const part of text.split('\n')) {
    out.push({ text: part, offset });
    offset += part.length + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Coordinate spaces

export interface Size {
  width: number;
  height: number;
}

export type SourceKind = 'copy384' | 'copy1600' | 'original';

interface DerivativeLike {
  width: number;
  pixel_width: number | null;
  pixel_height: number | null;
}

/**
 * Pixel size of the image an OCR row was read from, or null when it cannot be known here. Device OCR names the copy
 * (`source_width` 1600 / 384; its recorded pixel size, else the embedded image when that is the copy, else the
 * embedded image scaled to that long edge); server OCR read the original, known only when the original is embedded.
 */
export function ocrSpace(row: OcrRowLike, derivatives: DerivativeLike[] | null | undefined, kind: SourceKind, image: Size): Size | null {
  const sw = row.source_width;
  if (sw === 1600 || sw === 384) {
    const d = (derivatives ?? []).find((x) => x.width === sw);
    if (d && d.pixel_width && d.pixel_height) return { width: d.pixel_width, height: d.pixel_height };
    if (kind === (sw === 1600 ? 'copy1600' : 'copy384')) return image;
    const long = Math.max(image.width, image.height);
    if (long <= sw) return image; // copies are never enlarged
    const k = sw / long;
    return { width: Math.round(image.width * k), height: Math.round(image.height * k) };
  }
  if (sw === null || sw === undefined) return kind === 'original' ? image : null;
  return null;
}

/**
 * OCR-space boxes → whole-pixel rectangles of the embedded image (rounded outwards, clipped). null when the aspect
 * ratios differ (e.g. the OCR read the picture rotated): nothing can be placed safely.
 */
export function scaleBoxes(boxes: Box[], from: Size, to: Size): Box[] | null {
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return null;
  const a = from.width / from.height;
  const b = to.width / to.height;
  if (Math.abs(a - b) / b > ASPECT_TOLERANCE) return null;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const out: Box[] = [];
  for (const r of boxes) {
    const x0 = Math.max(0, Math.floor(r.x * sx));
    const y0 = Math.max(0, Math.floor(r.y * sy));
    const x1 = Math.min(to.width, Math.ceil((r.x + r.w) * sx));
    const y1 = Math.min(to.height, Math.ceil((r.y + r.h) * sy));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One photo

export const MASK_WARNING_PREFIX = 'Aadhaar masking: ';
const ADVICE = 'Check it in the report and cover the number before sending, or mark the photo not relevant.';

/** `Photo "x" (Section)` → `ID photo "x" (Section)` for an identity document. */
const subject = (label: string, id: boolean) => (id ? label.replace(/^Photo\b/, 'ID photo') : label);

export function maskWarning(label: string, id: boolean, reason: string): string {
  return `${MASK_WARNING_PREFIX}${subject(label, id)} could not be masked automatically: ${reason}. ${ADVICE}`;
}

export interface MaskPhotoInput {
  /** OCR rows of this file (page 1); null = they could not be loaded. */
  rows: OcrRowLike[] | null;
  categoryCode?: string | null;
  derivatives?: DerivativeLike[] | null;
  kind: SourceKind;
  label: string;
}

export interface MaskPlan {
  /** Numbers found in the text read from the photo (best reading). */
  found: number;
  /** Rectangles to black out, given the embedded image's decoded size. */
  rectsFor(image: Size): { rects: Box[]; mapped: number; unmapped: number };
  /** Warning before any pixel work (nothing found on an ID photo, OCR not loaded), or null. */
  warning: string | null;
}

/** What has to be done to one photo, from its OCR rows; no pixel work. */
export function planPhotoMask(input: MaskPhotoInput): MaskPlan {
  const id = isIdCategory(input.categoryCode);
  if (input.rows === null) {
    return {
      found: 0,
      rectsFor: () => ({ rects: [], mapped: 0, unmapped: 0 }),
      warning: id ? maskWarning(input.label, true, 'the text read from it could not be loaded') : null,
    };
  }
  const rows = input.rows.filter((r) => (r.page_no ?? 1) === 1).map((r) => {
    const hits = findAadhaar(readBlocks(r.blocks));
    return { row: r, hits, inText: countNumbers(r.text) };
  });
  const found = rows.reduce((n, r) => Math.max(n, r.hits.length, r.inText), 0);
  let warning: string | null = null;
  if (found === 0 && id) {
    warning = maskWarning(input.label, true, rows.length === 0
      ? 'no text has been read from it yet'
      : 'no Aadhaar number was found in the text read from it');
  }
  return {
    found,
    warning,
    rectsFor(image) {
      const rects: Box[] = [];
      let mapped = 0;
      let unmapped = 0;
      for (const r of rows) {
        if (r.hits.length) {
          const space = ocrSpace(r.row, input.derivatives, input.kind, image);
          const scaled = space ? scaleBoxes(r.hits.flatMap((h) => h.boxes), space, image) : null;
          if (scaled) {
            rects.push(...scaled);
            mapped = Math.max(mapped, r.hits.length);
          } else unmapped = Math.max(unmapped, r.hits.length);
        }
        // numbers in the text that no block placed (no or different blocks)
        if (r.inText > r.hits.length) unmapped = Math.max(unmapped, r.inText);
      }
      return { rects, mapped, unmapped };
    },
  };
}

/** Blacks out rectangles on a copy of the image (decoded upright, re-encoded without metadata); throws on failure. */
export type Painter = (image: ReportImage, rectsFor: (decoded: Size) => Box[]) => Promise<ReportImage>;

export interface MaskResult {
  /** The image to place (masked copy, the input unchanged, or null = print the placeholder). */
  image: ReportImage | null;
  warnings: string[];
  /** Rectangles painted. */
  masked: number;
}

/**
 * Masks one fetched photo. `paint` null (no canvas, e.g. the edge function): a photo with a number is not placed.
 * A photo whose number cannot be placed on the image, or an ID photo with no number found, is placed as it is with a
 * warning (generation is never blocked; the office user decides).
 */
export async function maskPhoto(image: ReportImage, input: MaskPhotoInput, paint: Painter | null): Promise<MaskResult> {
  const plan = planPhotoMask(input);
  const id = isIdCategory(input.categoryCode);
  const warnings = plan.warning ? [plan.warning] : [];
  if (plan.found === 0) return { image, warnings, masked: 0 };
  if (!paint) {
    return {
      image: null,
      warnings: [`${MASK_WARNING_PREFIX}${subject(input.label, id)} shows an Aadhaar number, which cannot be masked here; an empty box with the caption is printed instead.`],
      masked: 0,
    };
  }
  let outcome = { rects: [] as Box[], mapped: 0, unmapped: 0 };
  let out: ReportImage;
  try {
    out = await paint(image, (decoded) => {
      outcome = plan.rectsFor(decoded);
      return outcome.rects;
    });
  } catch {
    return { image, warnings: [maskWarning(input.label, id, 'the photo could not be edited in this browser')], masked: 0 };
  }
  if (outcome.unmapped > outcome.mapped) {
    warnings.push(maskWarning(input.label, id, outcome.mapped
      ? 'not every number read from it could be placed on the image'
      : 'the number read from it could not be placed on the image'));
  }
  return { image: outcome.rects.length ? out : image, warnings, masked: outcome.rects.length };
}

/** Rows grouped by evidence id. */
export function ocrByEvidence(rows: OcrRowLike[]): Map<string, OcrRowLike[]> {
  const m = new Map<string, OcrRowLike[]>();
  for (const r of rows) {
    if (typeof r?.evidence_id !== 'string') continue;
    const k = r.evidence_id.toLowerCase();
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** The warning when the OCR rows of the report's photos could not be read at all. */
export const OCR_UNAVAILABLE_WARNING =
  `${MASK_WARNING_PREFIX}the text read from the photos could not be loaded, so no Aadhaar number on them was masked. Generate the report again before sending it.`;

/**
 * loadReportPhotos' `mask` for a report: OCR rows by evidence id (ocrByEvidence; null = they could not be loaded,
 * add OCR_UNAVAILABLE_WARNING once), and the painter (null where no canvas exists: photos with a number are not
 * placed).
 */
export function createAadhaarMasker(ocr: Map<string, OcrRowLike[]> | null, paint: Painter | null): PhotoMasker {
  return async (photo, src, image, label) => {
    const input: MaskPhotoInput = {
      rows: ocr ? (ocr.get(photo.evidence_id.toLowerCase()) ?? []) : null,
      categoryCode: photo.category_code ?? null,
      derivatives: photo.derivatives ?? null,
      kind: src.kind,
      label,
    };
    try {
      const r = await maskPhoto(image, input, paint);
      return { image: r.image, warnings: r.warnings };
    } catch {
      return { image, warnings: [maskWarning(label, isIdCategory(input.categoryCode), 'an unexpected error occurred')] };
    }
  };
}
