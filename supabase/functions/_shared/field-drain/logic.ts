// Pure logic of the `field-drain` function (D43): request validation, DB error mapping and the
// AWS SigV4 presigned PUT for R2. No I/O, no npm imports: runs in Deno (edge function) and in
// Node's type stripping (services/intake/test/field-drain.test.ts). Uses WebCrypto (crypto.subtle).

export type ErrorCode =
  | 'method_not_allowed'
  | 'invalid_body'
  | 'invalid_input'
  | 'device_unknown'
  | 'not_deactivated'
  | 'drain_window_closed'
  | 'drain_finished'
  | 'upload_window_closed'
  | 'storage_not_configured'
  | 'internal';

export interface Failure {
  status: number;
  error: { code: ErrorCode; message: string; field?: string };
}
export function fail(status: number, code: ErrorCode, message: string, field?: string): Failure {
  return { status, error: field ? { code, message, field } : { code, message } };
}

interface Device {
  device_id: string;
  secret: string;
}
export type DrainRequest =
  | (Device & { action: 'status' })
  | (Device & {
    action: 'presign';
    task_id: string;
    sha256: string;
    ext: string;
    device_captured_at: string;
  })
  | (Device & {
    action: 'post';
    case_id: string;
    client_message_id: string;
    kind: 'media' | 'voice';
    body: string | null;
    task_id: string | null;
    reply_to: string | null;
    items: Record<string, unknown>[];
  })
  | (Device & { action: 'outbox'; pending_count: number; pending_bytes: number; oldest_pending_at: string | null })
  | (Device & { action: 'finish'; discarded_count: number });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
export const MAX_ITEMS = 30;

type Parsed = { ok: true; value: DrainRequest } | { ok: false; failure: Failure };
const bad = (field: string, message: string): Parsed => ({ ok: false, failure: fail(400, 'invalid_input', message, field) });

function isTime(v: unknown): v is string {
  return typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
}
function isCount(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}
function optUuid(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined;
}

export function parseRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.device_id !== 'string' || !UUID.test(b.device_id)) return bad('device_id', 'device_id must be a UUID.');
  if (typeof b.secret !== 'string' || !HEX64.test(b.secret)) return bad('secret', 'secret must be 64 lower-case hex characters.');
  const dev = { device_id: b.device_id.toLowerCase(), secret: b.secret };

  switch (b.action) {
    case 'status':
      return { ok: true, value: { ...dev, action: 'status' } };
    case 'presign': {
      const task = optUuid(b.task_id);
      if (!task) return bad('task_id', 'task_id must be a UUID.');
      if (typeof b.sha256 !== 'string' || !HEX64.test(b.sha256)) return bad('sha256', 'sha256 must be 64 lower-case hex characters.');
      if (typeof b.ext !== 'string' || !EXT.test(b.ext)) return bad('ext', 'ext must be 1-8 lower-case letters or digits.');
      if (!isTime(b.device_captured_at)) return bad('device_captured_at', 'device_captured_at must be an ISO 8601 time.');
      return {
        ok: true,
        value: { ...dev, action: 'presign', task_id: task, sha256: b.sha256, ext: b.ext, device_captured_at: b.device_captured_at },
      };
    }
    case 'post': {
      const caseId = optUuid(b.case_id);
      if (!caseId) return bad('case_id', 'case_id must be a UUID.');
      const cmid = optUuid(b.client_message_id);
      if (!cmid) return bad('client_message_id', 'client_message_id must be a UUID.');
      if (b.kind !== 'media' && b.kind !== 'voice') return bad('kind', 'Only media and voice messages are sent after sign-out.');
      const task = optUuid(b.task_id);
      if (task === undefined) return bad('task_id', 'task_id must be a UUID.');
      const reply = optUuid(b.reply_to);
      if (reply === undefined) return bad('reply_to', 'reply_to must be a UUID.');
      if (b.body !== undefined && b.body !== null && (typeof b.body !== 'string' || b.body.length > 4000)) {
        return bad('body', 'body must be text of at most 4000 characters.');
      }
      if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > MAX_ITEMS) {
        return bad('items', `items must hold 1-${MAX_ITEMS} files.`);
      }
      for (const it of b.items) {
        if (typeof it !== 'object' || it === null || Array.isArray(it)) return bad('items', 'Each file must be an object.');
        if (!isTime((it as Record<string, unknown>).device_captured_at)) {
          return bad('items', 'Each file needs device_captured_at (ISO 8601).');
        }
      }
      return {
        ok: true,
        value: {
          ...dev, action: 'post', case_id: caseId, client_message_id: cmid, kind: b.kind,
          body: typeof b.body === 'string' ? b.body : null, task_id: task, reply_to: reply,
          items: b.items as Record<string, unknown>[],
        },
      };
    }
    case 'outbox': {
      if (!isCount(b.pending_count, 100_000)) return bad('pending_count', 'pending_count must be a whole number 0-100000.');
      if (!isCount(b.pending_bytes, Number.MAX_SAFE_INTEGER)) return bad('pending_bytes', 'pending_bytes must be a whole number.');
      const oldest = b.oldest_pending_at ?? null;
      if (oldest !== null && !isTime(oldest)) return bad('oldest_pending_at', 'oldest_pending_at must be an ISO 8601 time.');
      return {
        ok: true,
        value: { ...dev, action: 'outbox', pending_count: b.pending_count, pending_bytes: b.pending_bytes, oldest_pending_at: oldest },
      };
    }
    case 'finish': {
      const n = b.discarded_count ?? 0;
      if (!isCount(n, 100_000)) return bad('discarded_count', 'discarded_count must be a whole number.');
      return { ok: true, value: { ...dev, action: 'finish', discarded_count: n } };
    }
    default:
      return bad('action', 'action must be status, presign, post, outbox or finish.');
  }
}

/** PostgREST error from an rpc call. */
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

/** Hints raised by the drain_* functions (20261114400000_offline_drain.sql) → HTTP. */
export function mapDbError(e: DbErrorLike): Failure {
  switch (e.hint) {
    case 'device_unknown':
      return fail(401, 'device_unknown', 'This phone is not recognised. Nothing was sent.');
    case 'not_deactivated':
      return fail(409, 'not_deactivated', 'Your account is active. Sign in to send files.');
    case 'drain_window_closed':
      return fail(410, 'drain_window_closed', 'The time to send files after sign-out has ended.');
    case 'drain_finished':
      return fail(410, 'drain_finished', 'This phone has already finished sending.');
    case 'upload_window_closed':
      return fail(422, 'upload_window_closed', 'These files were taken after access ended and cannot be sent.');
  }
  if (e.code === '22023' || e.code === '22P02' || e.code === '22007' || e.code === '23514') {
    return fail(400, 'invalid_input', e.message ?? 'Invalid input.');
  }
  return fail(500, 'internal', 'Something went wrong. Try again later.');
}

// R2 key scheme and SigV4 presigning are shared with `evidence-upload` (../r2/presign.ts).
export {
  amzDate, evidenceKey, presignEvidencePut, type PresignInput, presignUrl, PUT_EXPIRES_SECONDS, type R2Config, readR2Config,
  uriEncode,
} from '../r2/presign.ts';
