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

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
