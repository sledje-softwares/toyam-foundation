// Pure logic of the `evidence-upload` function (build plan 1.4): request validation, per-type size
// caps, the mime allow-list and DB error mapping. No I/O, no npm imports: runs in Deno and in Node's
// type stripping (services/intake/test/evidence-upload.test.ts).

export type ErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'invalid_body'
  | 'invalid_input'
  | 'unsupported_type'
  | 'file_too_large'
  | 'upload_window_closed'
  | 'forbidden'
  | 'storage_not_configured'
  | 'upstream_error'
  | 'internal';

export interface Failure {
  status: number;
  error: { code: ErrorCode; message: string; field?: string };
}
export function fail(status: number, code: ErrorCode, message: string, field?: string): Failure {
  return { status, error: field ? { code, message, field } : { code, message } };
}

const MB = 1024 * 1024;

/**
 * Allowed types → object extension. Photos arrive compressed (~0.5–1 MB, docs/11); gallery / shared
 * images may be larger; video and audio are the share-target types of docs/11.
 */
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

/** Largest accepted file per type family (bytes). */
export const MAX_BYTES = { image: 20 * MB, application: 25 * MB, audio: 50 * MB, video: 300 * MB } as const;

export function maxBytesFor(mime: string): number {
  const family = mime.split('/')[0] as keyof typeof MAX_BYTES;
  return MAX_BYTES[family] ?? 0;
}

/** Lower-case, parameters dropped ("audio/mp4; codecs=aac" → "audio/mp4"). */
export function normaliseMime(v: string): string {
  return v.split(';')[0].trim().toLowerCase();
}

export interface UploadFile {
  sha256: string;
  size: number;
  mime: string;
  ext: string;
  device_captured_at: string;
}
export interface UploadRequest {
  task_id: string;
  case_id: string;
  files: UploadFile[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
export const MAX_FILES = 30;

type Parsed = { ok: true; value: UploadRequest } | { ok: false; failure: Failure };
const bad = (field: string, message: string, status = 400, code: ErrorCode = 'invalid_input'): Parsed => ({
  ok: false,
  failure: fail(status, code, message, field),
});

export function parseRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.task_id !== 'string' || !UUID.test(b.task_id)) return bad('task_id', 'task_id must be a UUID.');
  if (typeof b.case_id !== 'string' || !UUID.test(b.case_id)) return bad('case_id', 'case_id must be a UUID.');
  if (!Array.isArray(b.files) || b.files.length === 0 || b.files.length > MAX_FILES) {
    return bad('files', `files must hold 1-${MAX_FILES} entries.`);
  }
  const files: UploadFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < b.files.length; i++) {
    const f = b.files[i] as Record<string, unknown>;
    const at = `files[${i}]`;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return bad(at, 'Each file must be an object.');
    if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) return bad(`${at}.sha256`, 'sha256 must be 64 lower-case hex characters.');
    if (seen.has(f.sha256)) return bad(`${at}.sha256`, 'The same file is listed twice.');
    seen.add(f.sha256);
    if (typeof f.mime !== 'string') return bad(`${at}.mime`, 'mime is required.');
    const mime = normaliseMime(f.mime);
    const ext = MIME_EXT[mime];
    if (!ext) return bad(`${at}.mime`, 'This file type cannot be uploaded.', 400, 'unsupported_type');
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size <= 0) {
      return bad(`${at}.size`, 'size must be a positive whole number of bytes.');
    }
    if (f.size > maxBytesFor(mime)) {
      return bad(`${at}.size`, `This file is larger than ${maxBytesFor(mime) / MB} MB.`, 413, 'file_too_large');
    }
    const t = f.device_captured_at;
    if (typeof t !== 'string' || !ISO.test(t) || Number.isNaN(Date.parse(t))) {
      return bad(`${at}.device_captured_at`, 'device_captured_at must be an ISO 8601 time.');
    }
    files.push({ sha256: f.sha256, size: f.size, mime, ext, device_captured_at: t });
  }
  return { ok: true, value: { task_id: b.task_id.toLowerCase(), case_id: b.case_id.toLowerCase(), files } };
}

/** PostgREST error from an rpc call made with the caller's JWT. */
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

export function mapDbError(e: DbErrorLike): Failure {
  if (e.code === 'PGRST301' || e.code === 'PGRST302' || e.code === 'PGRST303') {
    return fail(401, 'unauthorized', 'Sign in again.');
  }
  if (e.hint === 'upload_window_closed') {
    return fail(403, 'upload_window_closed', 'These files were taken after access ended and cannot be sent.');
  }
  if (e.code === '42501') return fail(403, 'forbidden', 'You cannot send files on this task.');
  if (e.code === '22023' || e.code === '22P02' || e.code === '22007') return fail(400, 'invalid_input', e.message ?? 'Invalid input.');
  return fail(502, 'upstream_error', 'Something went wrong. Try again later.');
}
