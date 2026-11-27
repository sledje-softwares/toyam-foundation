// Native adapter (untested here; logic lives in the pure modules next to it): compress → copy into the
// sandbox → size check → SHA-256 of the sandbox copy, i.e. exactly the bytes the outbox uploads.
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { newUuid } from '../outbox/runtime';
import { adoptIntoSandbox, removeSandboxFile } from '../outbox/transport';
import type { CaptureSource, Gps } from '../outbox/types';
import { needsCompression, nextPass, PASSES, resizeFor } from './compress';
import { cleanExif, pickCaptureTime } from './exif';
import { SELF_TEST_BYTES, SELF_TEST_SHA256, sha256OfFile, type FileDigester } from './hash';
import type { ScannedPage } from '../scan/native';
import { originalName, sandboxName, scanName, type PreparedFile } from './item';
import { checkFile, evidenceTypeFor, extFor, mimeOf } from './limits';

/** Native streaming digest over the file on disk (lower-case hex). */
export const nativeDigest: FileDigester = (uri) => new File(uri).digest('SHA-256');

let selfTest: Promise<void> | null = null;

/** Once per process: hash a known 256-byte vector written to disk and compare. Refuse to queue on mismatch. */
export function ensureDigestWorks(): Promise<void> {
  selfTest ??= (async () => {
    const f = new File(Paths.cache, `sha256-selftest-${newUuid()}.bin`);
    try {
      f.create();
      await f.write(SELF_TEST_BYTES());
      const h = await sha256OfFile(f.uri, nativeDigest);
      if (h !== SELF_TEST_SHA256) throw new Error('File check failed on this phone. Please update the app.');
    } finally {
      if (f.exists) f.delete();
    }
  })().catch((e: unknown) => {
    selfTest = null;
    throw e;
  });
  return selfTest;
}

export class CaptureError extends Error {}

/** Deletes our own cache copies only (camera output, picker copies, manipulator output); never a gallery file. */
const deleteQuietly = (uri: string) => {
  if (!uri.startsWith(Paths.cache.uri)) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // cache files are cleaned by the system anyway
  }
};

/** JPEG re-encode with the stepped plan; returns a cache file (or the input when no compression is due). */
async function compress(uri: string, source: 'camera' | 'picked', mime: string, size: number, width: number, height: number) {
  if (!needsCompression(source, mime, size, width, height)) return { uri, mime, temp: false };
  let index = 0;
  let out: string | null = null;
  for (;;) {
    const pass = PASSES[index]!;
    const ctx = ImageManipulator.manipulate(uri);
    const resize = resizeFor(width, height, pass.maxEdge);
    if (resize) ctx.resize(resize);
    const ref = await ctx.renderAsync();
    const res = await ref.saveAsync({ compress: pass.quality, format: SaveFormat.JPEG });
    if (out) deleteQuietly(out);
    out = res.uri;
    const next = nextPass(index, new File(out).size);
    if (next === null) return { uri: out, mime: 'image/jpeg', temp: true };
    index = next;
  }
}

async function finish(args: {
  uri: string; mime: string; source: CaptureSource; capturedAt: string; gps: Gps | null; pickedName: string | null;
  exif: Record<string, unknown> | null | undefined; tempUris: string[];
}): Promise<PreparedFile> {
  const ext = extFor(args.mime);
  if (!ext) throw new CaptureError('This type of file cannot be sent. Send photos or PDF documents.');
  await ensureDigestWorks();
  const local = await adoptIntoSandbox(args.uri, sandboxName(newUuid(), ext));
  for (const t of args.tempUris) deleteQuietly(t);
  const size = new File(local).size;
  const check = checkFile(args.mime, size);
  if (!check.ok) {
    await removeSandboxFile(local);
    throw new CaptureError(check.message);
  }
  const sha256 = await sha256OfFile(local, nativeDigest); // the sandbox copy = the uploaded bytes
  return {
    local_path: local,
    sha256,
    size_bytes: size,
    mime_type: args.mime,
    ext,
    evidence_type: evidenceTypeFor(args.mime),
    device_captured_at: args.capturedAt,
    gps: args.source === 'camera' ? args.gps : null,
    capture_source: args.source,
    original_filename: originalName(args.source, args.pickedName, args.capturedAt, ext),
    checklist_item_id: null,
    ...(cleanExif(args.exif) ? { exif: cleanExif(args.exif) } : {}),
  };
}

export interface Shot {
  uri: string;
  width: number;
  height: number;
  exif?: Record<string, unknown> | null;
  /** Device clock at the shutter. */
  capturedAt: string;
  gps: Gps | null;
}

export async function prepareCameraShot(shot: Shot): Promise<PreparedFile> {
  const size = new File(shot.uri).size;
  const c = await compress(shot.uri, 'camera', 'image/jpeg', size, shot.width, shot.height);
  return finish({
    uri: c.uri, mime: c.mime, source: 'camera', capturedAt: shot.capturedAt, gps: shot.gps, pickedName: null,
    exif: shot.exif, tempUris: c.temp ? [c.uri, shot.uri] : [shot.uri],
  });
}

/**
 * One page from the document scanner. The scanner's gallery import is off, so it is a camera capture;
 * it carries no GPS. `capturedAt` is the device clock when the scanner returned the pages.
 */
export async function prepareScanPage(page: ScannedPage, capturedAt: string, pageNumber: number): Promise<PreparedFile> {
  const size = new File(page.uri).size;
  const c = await compress(page.uri, 'camera', 'image/jpeg', size, page.width, page.height);
  return finish({
    uri: c.uri, mime: c.mime, source: 'camera', capturedAt, gps: null, pickedName: scanName(capturedAt, pageNumber),
    exif: null, tempUris: c.temp ? [c.uri, page.uri] : [page.uri],
  });
}

export interface Picked {
  uri: string;
  mimeType?: string | null;
  name?: string | null;
  size?: number | null;
  width?: number;
  height?: number;
  exif?: Record<string, unknown> | null;
  /** Document picker's lastModified (ms); the image picker gives none. */
  lastModified?: number | null;
}

/** Gallery and document files: accepted like camera files (D18), origin kept in capture_source. */
export async function preparePicked(p: Picked, source: CaptureSource = 'gallery'): Promise<PreparedFile> {
  const mime = mimeOf(p.mimeType, p.name);
  const size = p.size ?? new File(p.uri).size;
  const pre = checkFile(mime, Math.max(size, 1));
  if (!pre.ok && pre.reason === 'unsupported') throw new CaptureError(pre.message);
  const capturedAt = pickCaptureTime(p.exif, p.lastModified ?? null, Date.now(), new Date().getTimezoneOffset());
  const c = await compress(p.uri, 'picked', mime, size, p.width ?? 0, p.height ?? 0);
  return finish({
    uri: c.uri, mime: c.mime, source, capturedAt, gps: null, pickedName: p.name ?? null, exif: p.exif,
    // picker copies live in the app cache; delete them once the sandbox copy exists
    tempUris: c.temp ? [c.uri, p.uri] : [p.uri],
  });
}

/** A picked / shot file the operator removed before Send. */
export const discardPrepared = (f: PreparedFile): Promise<void> => removeSandboxFile(f.local_path);
