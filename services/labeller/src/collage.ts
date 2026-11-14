// Numbered collages for the bake-off's collage arm (D36): layout, cell badges, grouping and the
// per-cell answer parser. Pure functions; the script does the image compositing.
import { extractJson, parseLabelAnswer } from './prompt.ts';
import type { LabelAnswer } from './prompt.ts';

/**
 * Claude 4.7 and later (incl. Haiku / Sonnet 5.5) accept up to 2576 px and 4784 visual tokens
 * (28×28-px patches). A square 1932-px canvas is 69 × 69 = 4761 patches, just under the limit,
 * so the model sees the collage without being downscaled.
 */
export const DEFAULT_CANVAS = 1932;
export const GUTTER = 6;

export interface CollageLayout {
  grid: number;       // cells per row and per column
  canvas: number;     // square canvas, px
  gutter: number;
  cell: number;       // cell edge, px
}

export function collageLayout(grid: number, canvas = DEFAULT_CANVAS, gutter = GUTTER): CollageLayout {
  if (!Number.isInteger(grid) || grid < 2 || grid > 8) throw new Error('grid must be 2 to 8');
  const cell = Math.floor((canvas - gutter * (grid + 1)) / grid);
  return { grid, canvas, gutter, cell };
}

/** Top-left corner of cell `index` (0-based, row-major). */
export function cellOrigin(l: CollageLayout, index: number): { x: number; y: number } {
  const row = Math.floor(index / l.grid);
  const col = index % l.grid;
  return { x: l.gutter + col * (l.cell + l.gutter), y: l.gutter + row * (l.cell + l.gutter) };
}

/** "6x6" → 6; "single" → null. */
export function parseLayout(spec: string): number | null {
  if (spec === 'single') return null;
  const m = /^(\d)x(\d)$/.exec(spec);
  if (!m || m[1] !== m[2]) throw new Error(`layout must be "single" or a square grid such as "6x6" (got "${spec}")`);
  return collageLayout(Number(m[1])).grid;
}

// Seven-segment digits drawn as rectangles, so the badge needs no fonts on the machine.
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

/** SVG of a yellow badge with the number in black; `h` is the badge height in px. */
export function badgeSvg(n: number, h = 34): string {
  const digits = String(n);
  const dh = Math.round(h * 0.7);          // digit height
  const dw = Math.round(dh * 0.55);        // digit width
  const t = Math.max(2, Math.round(dh / 7)); // stroke
  const pad = Math.round((h - dh) / 2);
  const w = pad * 2 + digits.length * dw + (digits.length - 1) * t;
  const rects: string[] = [`<rect width="${w}" height="${h}" fill="#ffd400"/>`];
  [...digits].forEach((d, i) => {
    const x = pad + i * (dw + t);
    const y = pad;
    const mid = y + Math.round((dh - t) / 2);
    const seg: Record<string, [number, number, number, number]> = {
      a: [x, y, dw, t], g: [x, mid, dw, t], d: [x, y + dh - t, dw, t],
      f: [x, y, t, Math.round(dh / 2)], b: [x + dw - t, y, t, Math.round(dh / 2)],
      e: [x, mid, t, dh - (mid - y)], c: [x + dw - t, mid, t, dh - (mid - y)],
    };
    for (const s of SEGMENTS[d]) {
      const [rx, ry, rw, rh] = seg[s];
      rects.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#000"/>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${rects.join('')}</svg>`;
}

/**
 * Split files into collages of at most grid² cells, never mixing cases: files are grouped by
 * their folder (one folder per case), in the given order.
 */
export function planCollages(files: string[], grid: number): string[][] {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const key = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const per = grid * grid;
  const out: string[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += per) out.push(g.slice(i, i + per));
  return out;
}

export function collageInstruction(cells: number): string {
  return `This picture has ${cells} numbered cells (1 to ${cells}). Label every cell.`;
}

/** Output budget: about 120 tokens per cell plus room for thinking. */
export function collageMaxTokens(cells: number): number {
  return Math.min(16000, 1024 + cells * 160);
}

/**
 * Per-cell answers, index 0 = cell 1. A cell the model skipped, numbered twice or answered
 * unusably is null in `answers` and explained in `errors`.
 */
export function parseCollageAnswer(text: string, cells: number, allowedCodes: Set<string>, allowedFields: Set<string> = new Set()):
    { answers: Array<LabelAnswer | null>; errors: string[] } {
  const answers: Array<LabelAnswer | null> = Array.from({ length: cells }, () => null);
  const errors: string[] = [];
  let items: unknown[] = [];
  const json = extractJson(text);
  try {
    const raw = json ? JSON.parse(json) : null;
    if (raw && Array.isArray((raw as Record<string, unknown>).images)) items = (raw as Record<string, unknown[]>).images;
    else errors.push('no "images" array in the answer');
  } catch {
    errors.push('answer is not valid JSON');
  }
  const seen = new Set<number>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const n = Number((item as Record<string, unknown>).n);
    if (!Number.isInteger(n) || n < 1 || n > cells) {
      errors.push(`cell number ${String((item as Record<string, unknown>).n)} out of range`);
      continue;
    }
    if (seen.has(n)) {
      errors.push(`cell ${n} answered twice`);
      answers[n - 1] = null;          // ambiguous: trust neither
      continue;
    }
    seen.add(n);
    answers[n - 1] = parseLabelAnswer(JSON.stringify(item), allowedCodes, allowedFields);
  }
  for (let i = 0; i < cells; i++) if (!seen.has(i + 1)) errors.push(`cell ${i + 1} missing`);
  return { answers, errors };
}
