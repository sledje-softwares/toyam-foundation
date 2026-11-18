// Request flow of the `evidence-view` function against an injected gateway (tested from Node with
// fakes). The Deno entry point (../../evidence-view/index.ts) wires the gateway to a supabase-js
// client carrying the CALLER's JWT: rows are read under RLS and Storage links are signed under the
// storage.objects policies, so no service-role key is used (rule 4). A row the caller cannot read
// is reported as `not_found`, exactly like a row that does not exist.
//
// Variants (`w384` / `w1600`): the shrunk copy's key is read from `evidence_derivatives` with the
// caller's client, only for evidence rows the caller can already see, and is signed only when it
// matches the strict key scheme AND names that row's case, original hash, the requested width and the
// copy's own recorded hash. The request never carries a key or path.
import {
  canInline, cleanSha256, contentDisposition, type DbErrorLike, derivedKeyMatches, type Disposition, type Failure, fail,
  type FileErrorCode, type FileKind, isR2EvidenceKey, isStoragePath, keyExt, mapDbError, parseRequest, type RateLimit,
  safeFileName, serveType, SUPABASE_EVIDENCE_BUCKET, type Variant, variantWidth, VIEW_EXPIRES_SECONDS,
} from './logic.ts';
import { presignEvidenceGet, type R2Config } from '../r2/presign.ts';

export const MAX_BODY_CHARS = 8_000;

export interface EvidenceRow {
  id: string;
  case_id: string;
  evidence_type: string;
  storage_backend: string;
  storage_path: string | null;
  mime_type: string | null;
  original_filename: string | null;
  cloud_purged_at: string | null;
  sha256: string | null;
  size_bytes: number | null;
}
export interface AttachmentRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
  storage_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
}
/** An `evidence_derivatives` row (shrunk JPEG copy on R2), read with the caller's client (RLS). */
export interface DerivativeRow {
  evidence_id: string;
  width: number;
  storage_path: string;
  sha256: string;
  size_bytes: number | null;
  pixel_width: number | null;
}
type Rows<T> = Promise<{ data: T[] | null; error: DbErrorLike | null }>;

export interface Gateway {
  /** auth.getUser with the bearer token; the user id, or null when the session is not valid. */
  verifyCaller(): Promise<string | null>;
  /** `evidence` rows with these ids, read with the caller's client (RLS). */
  selectEvidence(ids: string[]): Rows<EvidenceRow>;
  /** `email_attachments` rows with these ids, read with the caller's client (RLS). */
  selectAttachments(ids: string[]): Rows<AttachmentRow>;
  /**
   * `evidence_derivatives` rows of these (already visible) evidence ids at this width, read with the caller's
   * client (RLS p_derivatives_staff_r: staff on cases they manage; field users see none and get the original).
   */
  selectDerivatives(evidenceIds: string[], width: number): Rows<DerivativeRow>;
  /** Storage signed URL made with the caller's client; null when refused or failed. */
  signStorage(bucket: string, path: string, seconds: number, downloadName: string | null): Promise<string | null>;
  /** Error log without secrets (codes / ids only). */
  logError(msg: string): void;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

type Item =
  | {
    kind: FileKind;
    id: string;
    url: string;
    expires_at: string;
    content_type: string;
    file_name: string;
    disposition: Disposition;
    /** What was actually served: the copy, or the original when no copy is recorded. */
    variant: Variant;
    /** SHA-256 of the served bytes (the copy's, or the evidence / attachment row's), from the database. */
    sha256: string | null;
    size_bytes: number | null;
    /** Pixel width of a served copy when recorded; null for originals. */
    width: number | null;
    mime: string;
  }
  | { kind: FileKind; id: string; error: FileErrorCode };

const err = (f: Failure): Reply => ({
  status: f.status, body: { ok: false, error: f.error }, ...(f.retryAfter ? { retryAfter: f.retryAfter } : {}),
});

/** A target to sign: which store, which object, how to name and serve it, what the bytes are. */
interface Target {
  kind: FileKind;
  id: string;
  store: 'r2' | 'supabase';
  path: string;
  mime: string;
  fileName: string;
  variant: Variant;
  sha256: string | null;
  sizeBytes: number | null;
  width: number | null;
}

function evidenceTarget(r: EvidenceRow): Target | FileErrorCode {
  if (!r.storage_path) return 'no_file'; // a note
  if (r.cloud_purged_at) return 'archived'; // D13: only the archive copy is left
  const ext = keyExt(r.storage_path);
  const fallback = `${r.evidence_type}-${r.id.slice(0, 8)}${ext ? '.' + ext : ''}`;
  const base = {
    kind: 'evidence' as const, id: r.id, path: r.storage_path, mime: serveType(r.mime_type),
    fileName: safeFileName(r.original_filename, fallback),
    variant: 'original' as const, sha256: cleanSha256(r.sha256), sizeBytes: r.size_bytes ?? null, width: null,
  };
  if (r.storage_backend === 'r2') return isR2EvidenceKey(r.storage_path) ? { ...base, store: 'r2' } : 'unavailable';
  if (r.storage_backend === 'supabase') return isStoragePath(r.storage_path) ? { ...base, store: 'supabase' } : 'unavailable';
  return 'unavailable';
}

/**
 * The shrunk copy of a visible photo. The key comes only from the database row and is signed only when it
 * matches the strict scheme and names exactly this photo: case id, original SHA-256, width, copy SHA-256.
 */
function copyTarget(original: Target, r: EvidenceRow, d: DerivativeRow, variant: Variant): Target | 'mismatch' {
  const width = variantWidth(variant);
  const originalSha = cleanSha256(r.sha256);
  const copySha = cleanSha256(d.sha256);
  if (width === null || !originalSha || !copySha || d.width !== width) return 'mismatch';
  if (String(d.evidence_id).toLowerCase() !== r.id.toLowerCase()) return 'mismatch';
  if (typeof d.storage_path !== 'string' || typeof r.case_id !== 'string') return 'mismatch';
  if (!derivedKeyMatches(d.storage_path, { caseId: r.case_id, originalSha256: originalSha, width, copySha256: copySha })) return 'mismatch';
  const stem = original.fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '') || `photo-${r.id.slice(0, 8)}`;
  return {
    kind: 'evidence', id: r.id, store: 'r2', path: d.storage_path, mime: 'image/jpeg',
    fileName: safeFileName(`${stem}-w${width}.jpg`, `photo-w${width}.jpg`),
    variant, sha256: copySha, sizeBytes: d.size_bytes ?? null, width: d.pixel_width ?? null,
  };
}

function attachmentTarget(r: AttachmentRow): Target | FileErrorCode {
  if (!r.storage_path || !isStoragePath(r.storage_path)) return 'unavailable';
  const ext = keyExt(r.storage_path);
  return {
    kind: 'attachment', id: r.id, store: 'supabase', path: r.storage_path, mime: serveType(r.mime_type),
    fileName: safeFileName(r.filename, `attachment-${r.id.slice(0, 8)}${ext ? '.' + ext : ''}`),
    variant: 'original', sha256: cleanSha256(r.sha256), sizeBytes: r.size_bytes ?? null, width: null,
  };
}

export async function handleEvidenceView(
  method: string,
  hasAuth: boolean,
  bodyText: string,
  gw: Gateway,
  r2: R2Config | null,
  limit: RateLimit,
  now: () => Date = () => new Date(),
): Promise<Reply> {
  if (method !== 'POST') return err(fail(405, 'method_not_allowed', 'Use POST.'));
  if (!hasAuth) return err(fail(401, 'unauthorized', 'Sign in again.'));
  if (bodyText.length > MAX_BODY_CHARS) return err(fail(400, 'invalid_body', 'The request is too large.'));
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return err(fail(400, 'invalid_body', 'Send a JSON object.'));
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return err(parsed.failure);
  const req = parsed.value;

  const uid = await gw.verifyCaller();
  if (!uid) return err(fail(401, 'unauthorized', 'Sign in again.'));
  const wait = limit.take(uid, req.evidence_ids.length + req.attachment_ids.length, now().getTime());
  if (wait !== null) {
    return err({ ...fail(429, 'rate_limited', 'Too many file requests. Wait a moment and try again.'), retryAfter: wait });
  }

  // 1. Rows the caller may read (RLS). Missing and invisible look the same.
  const [ev, at] = await Promise.all([
    req.evidence_ids.length ? gw.selectEvidence(req.evidence_ids) : Promise.resolve({ data: [] as EvidenceRow[], error: null }),
    req.attachment_ids.length ? gw.selectAttachments(req.attachment_ids) : Promise.resolve({ data: [] as AttachmentRow[], error: null }),
  ]);
  for (const [name, r] of [['evidence', ev], ['email_attachments', at]] as const) {
    if (r.error) {
      const f = mapDbError(r.error);
      if (f.status >= 500) gw.logError(`${name} select failed: ${r.error.code ?? 'unknown'} user ${uid}`);
      return err(f);
    }
  }
  const evById = new Map((ev.data ?? []).map((r) => [r.id.toLowerCase(), r]));
  const atById = new Map((at.data ?? []).map((r) => [r.id.toLowerCase(), r]));

  // 2. Originals first; for a copy variant, the recorded copy of each visible row replaces it.
  const originals = new Map<string, Target | FileErrorCode>();
  for (const id of req.evidence_ids) {
    const r = evById.get(id);
    originals.set(id, r ? evidenceTarget(r) : 'not_found');
  }
  const width = variantWidth(req.variant);
  const copies = new Map<string, DerivativeRow>();
  if (width !== null) {
    const wanted = req.evidence_ids.filter((id) => typeof originals.get(id) !== 'string');
    if (wanted.length) {
      const d = await gw.selectDerivatives(wanted, width);
      if (d.error) {
        const f = mapDbError(d.error);
        if (f.status >= 500) gw.logError(`evidence_derivatives select failed: ${d.error.code ?? 'unknown'} user ${uid}`);
        return err(f);
      }
      for (const row of d.data ?? []) {
        const id = String(row.evidence_id).toLowerCase();
        if (wanted.includes(id) && row.width === width && !copies.has(id)) copies.set(id, row);
      }
    }
  }

  const plan: (Target | { kind: FileKind; id: string; error: FileErrorCode })[] = [];
  for (const id of req.evidence_ids) {
    const t = originals.get(id) ?? 'not_found';
    if (typeof t === 'string') {
      plan.push({ kind: 'evidence', id, error: t });
      continue;
    }
    const copy = copies.get(id);
    if (!copy) {
      plan.push(t); // no copy recorded: the original; the reply says so (variant 'original')
      continue;
    }
    const c = copyTarget(t, evById.get(id)!, copy, req.variant);
    if (c === 'mismatch') {
      gw.logError(`derivative key mismatch: evidence ${id} ${req.variant} user ${uid}`);
      plan.push({ kind: 'evidence', id, error: 'unavailable' });
    } else plan.push(c);
  }
  for (const id of req.attachment_ids) {
    const r = atById.get(id);
    const t = r ? attachmentTarget(r) : 'not_found';
    plan.push(typeof t === 'string' ? { kind: 'attachment', id, error: t } : t);
  }
  if (!r2 && plan.some((p) => 'store' in p && p.store === 'r2')) {
    gw.logError('R2 is not configured');
    return err(fail(503, 'storage_not_configured', 'File storage is not available. Try again later.'));
  }

  // 3. One short-lived link per visible file.
  const at0 = now();
  const expires_at = new Date(at0.getTime() + VIEW_EXPIRES_SECONDS * 1000).toISOString();
  const files: Item[] = await Promise.all(plan.map(async (p): Promise<Item> => {
    if (!('store' in p)) return p;
    const disposition: Disposition = req.disposition === 'inline' && canInline(p.mime) ? 'inline' : 'attachment';
    const shown = {
      kind: p.kind, id: p.id, expires_at, content_type: p.mime, file_name: p.fileName, disposition,
      variant: p.variant, sha256: p.sha256, size_bytes: p.sizeBytes, width: p.width, mime: p.mime,
    };
    if (p.store === 'r2') {
      const g = await presignEvidenceGet(r2!, p.path, at0, {
        contentType: p.mime, contentDisposition: contentDisposition(disposition, p.fileName), expiresSeconds: VIEW_EXPIRES_SECONDS,
      });
      return { ...shown, url: g.url };
    }
    // Insurer attachments and their evidence rows (storage_backend 'supabase') both live in email-raw.
    const url = await gw.signStorage(SUPABASE_EVIDENCE_BUCKET, p.path, VIEW_EXPIRES_SECONDS, disposition === 'attachment' ? p.fileName : null);
    if (!url) {
      gw.logError(`storage sign refused: ${p.kind} ${p.id} user ${uid}`);
      return { kind: p.kind, id: p.id, error: 'unavailable' };
    }
    return { ...shown, url };
  }));
  return { status: 200, body: { ok: true, expires_in: VIEW_EXPIRES_SECONDS, files } };
}
