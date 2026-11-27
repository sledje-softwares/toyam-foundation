// ML Kit result → the documented evidence_ocr shape (docs/10 "Contracts"):
//   blocks: [{ text, bbox: [x, y, w, h], conf: 0-1 | null, line: n }]   one entry per text line, in the
//   pixel coordinates of the image that was read (the 1600 px copy), reading order, `line` = index.
// Pure; the native module (modules/toyam-ocr) returns `NativeOcrResult`.
import type { OcrBlock } from '../outbox/types';

export interface NativeFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeLine {
  text: string;
  frame: NativeFrame | null;
  /** ML Kit line confidence (0-1); null when the engine gave none. */
  confidence: number | null;
}

export interface NativeText {
  blocks: { lines: NativeLine[] }[];
}

/** What ToyamOcr.recognize() resolves to: one result per script model that ran. */
export interface NativeOcrResult {
  width: number;
  height: number;
  latin?: NativeText | null;
  devanagari?: NativeText | null;
}

export interface ReadText {
  text: string;
  blocks: OcrBlock[];
  mean_confidence: number | null;
  /** Scripts present in the text: 'latin', 'devanagari', 'latin+devanagari'; null = no text. */
  lang: string | null;
  /** Share of the image covered by text lines (0-1), for the photo / document guess. */
  coverage: number;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z0-9]/;

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function lineOf(l: NativeLine): OcrBlock | null {
  const text = (typeof l.text === 'string' ? l.text : '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const f = l.frame;
  // ML Kit may report a frame partly outside the image (negative left / top): clamp, whole pixels
  const x = Math.max(0, Math.round(num(f?.left)));
  const y = Math.max(0, Math.round(num(f?.top)));
  const w = Math.max(0, Math.round(num(f?.width) + Math.min(0, num(f?.left))));
  const h = Math.max(0, Math.round(num(f?.height) + Math.min(0, num(f?.top))));
  const c = l.confidence;
  const conf = typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, Math.round(c * 1000) / 1000)) : null;
  return { text, bbox: [x, y, w, h], conf, line: 0 };
}

const linesOf = (t: NativeText | null | undefined): OcrBlock[] =>
  (t?.blocks ?? []).flatMap((b) => (b?.lines ?? []).flatMap((l) => {
    const o = l ? lineOf(l) : null;
    return o ? [o] : [];
  }));

/** Overlap of two boxes relative to the smaller one (0-1). */
export function overlap(a: OcrBlock['bbox'], b: OcrBlock['bbox']): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const smaller = Math.min(a[2] * a[3], b[2] * b[3]);
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

/**
 * Merge the Latin and Devanagari readings: the Latin model is the base (better on numbers and English);
 * a Devanagari-model line that contains Devanagari script replaces the Latin lines it overlaps (there
 * the Latin model read noise). Reading order: top to bottom, then left to right within a line height.
 * Text is kept as read (D55: no masking before the report step).
 */
export function mergeReadings(r: NativeOcrResult): ReadText {
  const latin = linesOf(r.latin);
  const deva = linesOf(r.devanagari).filter((l) => DEVANAGARI.test(l.text));
  const kept = latin.filter((l) => !deva.some((d) => overlap(l.bbox, d.bbox) >= 0.5));
  const all = [...kept, ...deva].map((b) => ({ ...b }));
  all.sort((a, b) => {
    const rowTol = Math.max(4, Math.min(a.bbox[3], b.bbox[3]) / 2);
    const ca = a.bbox[1] + a.bbox[3] / 2;
    const cb = b.bbox[1] + b.bbox[3] / 2;
    return Math.abs(ca - cb) <= rowTol ? a.bbox[0] - b.bbox[0] : ca - cb;
  });
  const blocks = all.map((b, i) => ({ ...b, line: i }));
  let weighted = 0;
  let weight = 0;
  for (const b of blocks) {
    if (b.conf === null) continue;
    weighted += b.conf * b.text.length;
    weight += b.text.length;
  }
  const text = blocks.map((b) => b.text).join('\n');
  const hasDeva = blocks.some((b) => DEVANAGARI.test(b.text));
  const hasLatin = blocks.some((b) => LATIN.test(b.text));
  const lang = hasLatin && hasDeva ? 'latin+devanagari' : hasDeva ? 'devanagari' : hasLatin ? 'latin' : null;
  const area = num(r.width) * num(r.height);
  const covered = blocks.reduce((s, b) => s + b.bbox[2] * b.bbox[3], 0);
  return {
    text,
    blocks,
    mean_confidence: weight > 0 ? Math.round((weighted / weight) * 1000) / 1000 : null,
    lang,
    coverage: area > 0 ? Math.min(1, covered / area) : 0,
  };
}
