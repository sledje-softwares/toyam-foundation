// Image helpers for the report writers: type sniffing, pixel size from JPEG / PNG headers, base64.
// Pure; no imports. Images are never decoded or re-encoded.

export type ImageMime = 'image/jpeg' | 'image/png';

/** The real type from the magic bytes; null for anything that is not a JPEG or PNG. */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  return null;
}

/** Pixel size from the header (JPEG SOFn, PNG IHDR); null when it cannot be read. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const type = sniffImage(b);
  if (type === 'image/png') {
    if (b.length < 24) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const width = dv.getUint32(16);
    const height = dv.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (b[i + 5] << 8) | b[i + 6];
        const width = (b[i + 7] << 8) | b[i + 8];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
  }
  return null;
}

// Table-driven base64 (12 bits → two output bytes per lookup). About 7x less CPU than
// String.fromCharCode + btoa, which matters inside the edge function's 2 s CPU limit
// (30 photos of 500 kB: ~220 ms instead of ~2 s, measured in report-generate-cpu.test.ts).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_1 = new Uint8Array(64).map((_, i) => B64.charCodeAt(i));
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const B64_2 = new Uint16Array(4096).map((_, i) =>
  LITTLE_ENDIAN ? B64_1[i >> 6] | (B64_1[i & 63] << 8) : (B64_1[i >> 6] << 8) | B64_1[i & 63]);
const ascii = new TextDecoder();

export function toBase64(b: Uint8Array): string {
  const n = b.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  const o16 = new Uint16Array(out.buffer);
  const whole = n - (n % 3);
  let o = 0;
  let i = 0;
  for (; i < whole; i += 3) {
    const x = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    o16[o++] = B64_2[x >>> 12];
    o16[o++] = B64_2[x & 4095];
  }
  if (i < n) {
    const two = i + 1 < n;
    const x = (b[i] << 16) | ((two ? b[i + 1] : 0) << 8);
    let k = o * 2;
    out[k++] = B64_1[x >>> 18];
    out[k++] = B64_1[(x >>> 12) & 63];
    out[k++] = two ? B64_1[(x >>> 6) & 63] : 61; // '='
    out[k] = 61;
  }
  return ascii.decode(out);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
