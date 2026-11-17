// Shrunk copies of every image the app sends (D51). Pure planning; the native pieces (image decoder,
// hashing, sandbox files) are injected through `CopyEngine`, so this runs under vitest.
//
// For each image: a JPEG at 1600 px (reports) and one at 384 px (labelling) on the long edge, quality
// 0.8, never enlarged (an image smaller than the target keeps its own size), upright and without any
// metadata (a re-encode by the platform's bitmap encoder writes no EXIF / GPS). Copies are a
// rebuildable cache, not evidence: any failure drops that copy silently and the report uses the
// original. The server never decodes images.
import type { OutboxCopy } from '../outbox/types';
import { MB, normaliseMime } from './limits';

/** Longest edge in pixels, largest first. */
export const COPY_WIDTHS = [1600, 384] as const;
export const COPY_QUALITY = 0.8;
/** Same cap as the evidence-upload function (MAX_DERIVATIVE_BYTES). */
export const COPY_MAX_BYTES = 3 * MB;
/** Sources that get copies (what the manipulator decodes). PDFs, video and audio get none. */
export const COPY_SOURCE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

export const wantsCopies = (mime: string, evidenceType: string): boolean =>
  evidenceType === 'photo' && COPY_SOURCE_MIMES.includes(normaliseMime(mime));

/** Resize action for a target long edge; null = keep the size (never enlarges). */
export function copyResize(width: number, height: number, edge: number): { width: number } | { height: number } | null {
  if (!(width > 0 && height > 0)) return null; // unknown size: keep it, never guess an enlargement
  if (Math.max(width, height) <= edge) return null;
  return width >= height ? { width: edge } : { height: edge };
}

/** An image already decoded (upright) by the platform; `save` re-encodes it as JPEG without metadata. */
export interface OpenedImage {
  /** Upright pixel size of the source. */
  width: number;
  height: number;
  save(resize: { width: number } | { height: number } | null, quality: number): Promise<{ uri: string; width: number; height: number }>;
}

export interface CopyEngine {
  open(uri: string): Promise<OpenedImage>;
  /** SHA-256 hex of a file on disk. */
  sha256(uri: string): Promise<string>;
  /** Size in bytes of a file on disk. */
  fileSize(uri: string): Promise<number>;
  /** Move a temp file into the outbox sandbox under `name`; returns its sandbox URI. */
  adopt(uri: string, name: string): Promise<string>;
  /** Delete a file (idempotent, never throws for a missing file). */
  remove(uri: string): Promise<void>;
}

const positive = (n: number): boolean => Number.isInteger(n) && n > 0;

/**
 * Make both copies of one image in the sandbox. Never throws: a copy that cannot be made is left out
 * (a failure of `open` leaves both out). `fileId` only names the files.
 */
export async function makeCopies(engine: CopyEngine, source: { local_path: string; mime_type: string; evidence_type: string }, fileId: string): Promise<OutboxCopy[]> {
  if (!wantsCopies(source.mime_type, source.evidence_type)) return [];
  let img: OpenedImage;
  try {
    img = await engine.open(source.local_path);
  } catch {
    return [];
  }
  const out: OutboxCopy[] = [];
  for (const edge of COPY_WIDTHS) {
    let tmp: string | null = null;
    try {
      const saved = await img.save(copyResize(img.width, img.height, edge), COPY_QUALITY);
      tmp = saved.uri;
      const size = await engine.fileSize(saved.uri);
      if (!positive(size) || size > COPY_MAX_BYTES || !positive(saved.width) || !positive(saved.height)) continue;
      const sha256 = await engine.sha256(saved.uri); // the bytes that will be uploaded
      const local = await engine.adopt(saved.uri, `copy-${fileId}-w${edge}.jpg`);
      out.push({ width: edge, local_path: local, sha256, size_bytes: size, pixel_width: saved.width, pixel_height: saved.height, storage_path: null, attempts: 0 });
    } catch {
      // dropped silently: the report falls back to the original
    } finally {
      if (tmp) await engine.remove(tmp).catch(() => {});
    }
  }
  return out;
}
