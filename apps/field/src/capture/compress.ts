// Photo compression plan (pure). Target ~0.5–1 MB per photo (docs/11 "Sending" 2): resize the long edge,
// re-encode as JPEG, and step down once or twice if the result is still above 1 MB.
import { MB, normaliseMime } from './limits';

export interface Pass {
  /** Longest side in pixels after the resize. */
  maxEdge: number;
  /** JPEG quality 0–1. */
  quality: number;
}

export const TARGET_MAX_BYTES = 1 * MB;
export const PASSES: readonly Pass[] = [
  { maxEdge: 2048, quality: 0.7 },
  { maxEdge: 1600, quality: 0.6 },
  { maxEdge: 1280, quality: 0.5 },
];

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * Camera photos are always compressed. Picked images only when they are large (> 1 MB or long edge
 * > 2048 px); a small picked image is kept byte for byte, with its embedded EXIF.
 */
export function needsCompression(source: 'camera' | 'picked', mime: string, size: number, width: number, height: number): boolean {
  if (!COMPRESSIBLE.has(normaliseMime(mime))) return false;
  if (source === 'camera') return true;
  return size > TARGET_MAX_BYTES || Math.max(width, height) > PASSES[0]!.maxEdge;
}

/** Resize action keeping the aspect ratio; null when the image is already small enough (never enlarges). */
export function resizeFor(width: number, height: number, maxEdge: number): { width: number } | { height: number } | null {
  if (!(width > 0 && height > 0)) return { width: maxEdge }; // unknown size: let the manipulator scale
  if (Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}

/** Next pass to try after a result of `size` bytes from pass `index`, or null to keep the result. */
export function nextPass(index: number, size: number): number | null {
  if (size <= TARGET_MAX_BYTES) return null;
  return index + 1 < PASSES.length ? index + 1 : null;
}
