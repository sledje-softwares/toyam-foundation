// Accepted types and size caps, mirrored from the evidence-upload edge function
// (supabase/functions/_shared/evidence-upload/logic.ts; limits.test.ts keeps the two in sync).
// Checked before a file is queued so the operator hears about a too-large file at once instead of
// the file waiting for the office.
import type { EvidenceType } from '../outbox/types';

export const MB = 1024 * 1024;

export const MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'audio/webm': 'webm',
};

export const MAX_BYTES = { image: 20 * MB, application: 25 * MB, audio: 50 * MB, video: 300 * MB } as const;

/** Lower-case, parameters dropped ("image/JPEG; q=1" → "image/jpeg"); "image/jpg" → "image/jpeg". */
export function normaliseMime(v: string | null | undefined): string {
  const m = (v ?? '').split(';')[0]!.trim().toLowerCase();
  return m === 'image/jpg' ? 'image/jpeg' : m;
}

const EXT_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
};

/** The picker's mime type, else a guess from the file name; '' when unknown. */
export function mimeOf(mime: string | null | undefined, name: string | null | undefined): string {
  const m = normaliseMime(mime);
  if (m && m !== 'application/octet-stream') return m;
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? m;
}

export const extFor = (mime: string): string | null => MIME_EXT[normaliseMime(mime)] ?? null;

export function maxBytesFor(mime: string): number {
  const family = normaliseMime(mime).split('/')[0] as keyof typeof MAX_BYTES;
  return MAX_BYTES[family] ?? 0;
}

export function evidenceTypeFor(mime: string): EvidenceType {
  const family = normaliseMime(mime).split('/')[0];
  if (family === 'image') return 'photo';
  if (family === 'video') return 'video';
  if (family === 'audio') return 'audio';
  return 'document';
}

export type SizeCheck = { ok: true } | { ok: false; reason: 'unsupported' | 'too_large' | 'empty'; message: string };

/** Same rules as the server (type allow-list, family cap, non-empty). */
export function checkFile(mime: string, size: number): SizeCheck {
  if (!extFor(mime)) return { ok: false, reason: 'unsupported', message: 'This type of file cannot be sent. Send photos or PDF documents.' };
  if (!Number.isInteger(size) || size <= 0) return { ok: false, reason: 'empty', message: 'This file is empty and cannot be sent.' };
  const max = maxBytesFor(mime);
  if (size > max) return { ok: false, reason: 'too_large', message: `This file is larger than ${max / MB} MB and cannot be sent.` };
  return { ok: true };
}
