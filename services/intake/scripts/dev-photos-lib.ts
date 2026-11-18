// Synthetic, deterministic test photos for the LOCAL stack (scripts/dev-photos.ts). No personal data: each image is a
// coloured card with a large number, a file-kind caption and "SYNTHETIC TEST IMAGE". Pure (node:zlib only).
import { deflateSync } from 'node:zlib';

/** File kinds the insurer layouts place in photo sections; names match evidence_categories.filename_patterns. */
export const PHOTO_KINDS: readonly { name: string; category: string }[] = [
  { name: 'Front View', category: 'vehicle_photo' },
  { name: 'Rear View', category: 'vehicle_photo' },
  { name: 'Left Side', category: 'vehicle_photo' },
  { name: 'Right Side', category: 'vehicle_photo' },
  { name: 'Damage close up', category: 'vehicle_photo' },
  { name: 'Odometer', category: 'odometer_photo' },
  { name: 'Spot', category: 'spot_photo' },
  { name: 'Chassis', category: 'chassis_engine_photo' },
];

/** The i-th photo (0-based): its kind and an insurer-style file name, e.g. "Front View(2).png". */
export function photoName(i: number): { name: string; category: string; fileName: string } {
  const k = PHOTO_KINDS[i % PHOTO_KINDS.length];
  const n = Math.floor(i / PHOTO_KINDS.length) + 1;
  return { ...k, fileName: `${k.name}(${n}).png` };
}

// 5×7 bitmap font (rows of 5 bits).
const FONT: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

type Rgb = [number, number, number];

function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = (yy * this.w + xx) * 3;
        this.px[o] = c[0];
        this.px[o + 1] = c[1];
        this.px[o + 2] = c[2];
      }
    }
  }
  /** Text in the 5×7 font, `scale` px per dot; returns the drawn width. Unknown characters are drawn as spaces. */
  text(s: string, x: number, y: number, scale: number, c: Rgb): number {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' '];
      for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) if (g[r][col] === '1') this.rect(cx + col * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
    return cx - x - scale;
  }
}
export function textWidth(s: string, scale: number): number {
  return s.length ? s.length * 6 * scale - scale : 0;
}

// PNG: 8-bit RGB, one IDAT, filter 0 on every row.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function encodePng(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter method, no interlace
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Photo i of a case: same inputs, same bytes (so the same SHA-256 and no duplicate evidence on a re-run). */
export function renderDevPhoto(i: number, caseRef: string, w = 1600, h = 1200): { png: Uint8Array; fileName: string; category: string } {
  const { name, category, fileName } = photoName(i);
  const c = new Canvas(w, h);
  const base = hsl((i * 47) % 360, 0.55, 0.62);
  const dark = hsl((i * 47) % 360, 0.6, 0.28);
  // soft vertical gradient + a grid, so it reads as an image and not a flat swatch
  for (let y = 0; y < h; y++) {
    const t = y / h;
    c.rect(0, y, w, 1, [Math.round(base[0] * (1.08 - 0.25 * t)), Math.round(base[1] * (1.08 - 0.25 * t)), Math.round(base[2] * (1.08 - 0.25 * t))].map((v) => Math.min(255, v)) as Rgb);
  }
  const step = Math.max(8, Math.round(w / 16));
  for (let x = 0; x < w; x += step) c.rect(x, 0, Math.max(1, Math.round(w / 800)), h, dark);
  for (let y = 0; y < h; y += step) c.rect(0, y, w, Math.max(1, Math.round(w / 800)), dark);
  const border = Math.max(2, Math.round(w / 100));
  c.rect(0, 0, w, border, dark);
  c.rect(0, h - border, w, border, dark);
  c.rect(0, 0, border, h, dark);
  c.rect(w - border, 0, border, h, dark);
  // big number in a white card
  const label = `#${String(i + 1).padStart(2, '0')}`;
  const big = Math.max(2, Math.floor(Math.min(w / textWidth(label, 1) * 0.55, h / 7 * 0.45)));
  const bw = textWidth(label, big), bh = 7 * big;
  const pad = big * 2;
  c.rect((w - bw) / 2 - pad, (h - bh) / 2 - pad, bw + 2 * pad, bh + 2 * pad, [250, 250, 250]);
  c.text(label, (w - bw) / 2, (h - bh) / 2, big, dark);
  const small = Math.max(1, Math.round(w / 200));
  c.text('SYNTHETIC TEST IMAGE', border * 3, border * 3, small, [255, 255, 255]);
  const caption = `${name} - ${caseRef}`;
  c.rect(0, h - border - 11 * small, w, 11 * small, dark);
  c.text(caption, border * 3, h - border - 9 * small, small, [255, 255, 255]);
  return { png: encodePng(w, h, c.px), fileName, category };
}
