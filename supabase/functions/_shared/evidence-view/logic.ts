// Pure logic of the `evidence-view` function: request validation, file names, content disposition,
// which types may open inline, the R2 read config and a per-user rate limit. No I/O, no npm imports:
// runs in Deno and in Node's type stripping (services/intake/test/evidence-view.test.ts).
import { MIME_EXT, normaliseMime } from '../evidence-upload/logic.ts';
import { type R2Config, uriEncode } from '../r2/presign.ts';

export type ErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'invalid_body'
  | 'invalid_input'
  | 'rate_limited'
  | 'storage_not_configured'
  | 'upstream_error'
  | 'internal';

/** Per-file outcome when no link is returned. `not_found` covers "missing" and "not visible to you". */
export type FileErrorCode = 'not_found' | 'no_file' | 'archived' | 'unavailable';

export interface Failure {
  status: number;
  error: { code: ErrorCode; message: string; field?: string };
  retryAfter?: number;
}
export function fail(status: number, code: ErrorCode, message: string, field?: string): Failure {
  return { status, error: field ? { code, message, field } : { code, message } };
}

export const MAX_IDS = 50;
/** Link lifetime for both stores (R2 presigned GET and Storage signed URL). */
export const VIEW_EXPIRES_SECONDS = 300;
/** Supabase Storage bucket of evidence rows with storage_backend = 'supabase' (insurer attachments, M3). */
export const SUPABASE_EVIDENCE_BUCKET = 'email-raw';

export type Disposition = 'inline' | 'attachment';
export type FileKind = 'evidence' | 'attachment';

export interface ViewRequest {
  evidence_ids: string[];
  attachment_ids: string[];
  disposition: Disposition;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Parsed = { ok: true; value: ViewRequest } | { ok: false; failure: Failure };
const bad = (field: string, message: string): Parsed => ({ ok: false, failure: fail(400, 'invalid_input', message, field) });

function ids(v: unknown, field: string): string[] | Parsed {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(field, `${field} must be a list of UUIDs.`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'string' || !UUID.test(x)) return bad(`${field}[${i}]`, 'Each id must be a UUID.');
    const id = x.toLowerCase();
    if (!out.includes(id)) out.push(id); // repeats are answered once
  }
  return out;
}

export function parseRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  const ev = ids(b.evidence_ids, 'evidence_ids');
  if (!Array.isArray(ev)) return ev;
  const at = ids(b.attachment_ids, 'attachment_ids');
  if (!Array.isArray(at)) return at;
  const n = ev.length + at.length;
  if (n === 0 || n > MAX_IDS) return bad('evidence_ids', `Send 1-${MAX_IDS} ids (evidence_ids and attachment_ids together).`);
  const d = b.disposition ?? 'inline';
  if (d !== 'inline' && d !== 'attachment') return bad('disposition', 'disposition must be "inline" or "attachment".');
  return { ok: true, value: { evidence_ids: ev, attachment_ids: at, disposition: d } };
}

// ---------------------------------------------------------------------------------------------
// Types, names, disposition
// ---------------------------------------------------------------------------------------------
/**
 * Types a browser may render inline. Everything else (HTML, SVG, XML, Office files, archives …) is
 * always served as a download, so a stored file can never run script in a page.
 */
const INLINE_TYPES = new Set<string>([
  ...Object.keys(MIME_EXT),
  'image/gif',
  'text/plain',
]);
export function canInline(mime: string): boolean {
  return INLINE_TYPES.has(mime);
}

/** The type to serve: the database's mime type (normalised) when well formed, else octet-stream. */
export function serveType(mime: string | null | undefined): string {
  const m = normaliseMime(mime ?? '');
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) ? m : 'application/octet-stream';
}

/** A file name safe for a Content-Disposition header: no path, no control characters, ≤ 120 chars. */
export function safeFileName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // deno-lint-ignore no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\s+/g, ' ').trim();
  const n = clean && clean !== '.' && clean !== '..' ? clean : fallback;
  return [...n].slice(0, 120).join('');
}

/** `inline|attachment; filename="ascii"; filename*=UTF-8''…` (RFC 6266 / 8187). */
export function contentDisposition(d: Disposition, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${d}; filename="${ascii}"; filename*=UTF-8''${uriEncode(fileName)}`;
}

/** Extension of a storage key (`…/abc.jpg` → `jpg`), or ''. */
export function keyExt(path: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/** R2 evidence keys (docs/05; also enforced by evidence_validate). */
const R2_KEY = /^cases\/[0-9a-f-]{36}\/(tasks\/[0-9a-f-]{36}|files)\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
export function isR2EvidenceKey(path: string): boolean {
  return R2_KEY.test(path);
}
/** A Storage object path we are willing to sign (no traversal, no leading slash). */
export function isStoragePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.split('/').includes('..');
}

/**
 * The edge runtime's SUPABASE_URL can be an internal address (locally `http://kong:8000`); with
 * PUBLIC_SUPABASE_URL set, signed Storage links are rewritten to that origin.
 */
export function publicStorageUrl(signed: string, publicBase: string | undefined): string {
  if (!publicBase) return signed;
  try {
    const s = new URL(signed);
    const p = new URL(publicBase);
    return `${p.origin}${s.pathname}${s.search}`;
  } catch {
    return signed;
  }
}

// ---------------------------------------------------------------------------------------------
// R2 read credentials
// ---------------------------------------------------------------------------------------------
/**
 * evidence-view signs GETs. With R2_READ_ACCESS_KEY_ID / R2_READ_SECRET_ACCESS_KEY set it uses that
 * (read-only) token; otherwise the shared R2_ACCESS_KEY_ID pair, which then needs object read too.
 */
export function readViewR2Config(get: (k: string) => string | undefined): R2Config | null {
  const accountId = get('R2_ACCOUNT_ID'), bucket = get('R2_BUCKET');
  const readId = get('R2_READ_ACCESS_KEY_ID'), readSecret = get('R2_READ_SECRET_ACCESS_KEY');
  const accessKeyId = readId && readSecret ? readId : get('R2_ACCESS_KEY_ID');
  const secretAccessKey = readId && readSecret ? readSecret : get('R2_SECRET_ACCESS_KEY');
  return accountId && bucket && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
}

// ---------------------------------------------------------------------------------------------
// Rate limit (best effort, per isolate)
// ---------------------------------------------------------------------------------------------
export interface RateLimit {
  /** null = allowed (and counted); otherwise seconds until the caller may try again. */
  take(uid: string, ids: number, nowMs: number): number | null;
}

/**
 * Sliding one-minute window per user: at most `calls` requests and `ids` file ids. Kept in memory,
 * so it limits a runaway page or script on one isolate; it is not a hard global quota (the links
 * still need RLS-visible rows, and each one lives 5 minutes).
 */
export function createRateLimit(limits: { calls: number; ids: number; windowMs?: number; maxUsers?: number }): RateLimit {
  const windowMs = limits.windowMs ?? 60_000;
  const maxUsers = limits.maxUsers ?? 5_000;
  const seen = new Map<string, { at: number; n: number }[]>();
  return {
    take(uid, n, nowMs) {
      const recent = (seen.get(uid) ?? []).filter((e) => e.at > nowMs - windowMs);
      const used = recent.reduce((s, e) => s + e.n, 0);
      if (recent.length >= limits.calls || used + n > limits.ids) {
        seen.set(uid, recent);
        const oldest = recent.length ? recent[0].at : nowMs;
        return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      }
      recent.push({ at: nowMs, n });
      seen.delete(uid);
      seen.set(uid, recent); // re-insert: Map order = least recently used first
      if (seen.size > maxUsers) seen.delete(seen.keys().next().value as string);
      return null;
    },
  };
}
export const DEFAULT_LIMITS = { calls: 60, ids: 1_000 } as const;

// ---------------------------------------------------------------------------------------------
// Database errors
// ---------------------------------------------------------------------------------------------
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}
export function mapDbError(e: DbErrorLike): Failure {
  if (e.code === 'PGRST301' || e.code === 'PGRST302' || e.code === 'PGRST303') return fail(401, 'unauthorized', 'Sign in again.');
  return fail(502, 'upstream_error', 'Something went wrong. Try again later.');
}
