// Request flow of the `evidence-upload` function against an injected gateway (tested from Node with
// fakes). The Deno entry point (../../evidence-upload/index.ts) wires the gateway to a supabase-js
// client carrying the CALLER's JWT: no service-role key is used (rule 4). The database decides who
// may upload (can_upload_evidence_at, evidence_upload_target); this layer validates, maps errors and
// presigns R2 PUTs bound to each file's SHA-256 and size.
import { type DbErrorLike, type Failure, fail, mapDbError, parseRequest } from './logic.ts';
import { evidenceKey, presignEvidencePut, type R2Config } from '../r2/presign.ts';

export const MAX_BODY_CHARS = 64_000;

export interface Gateway {
  /** auth.getUser with the bearer token; the user id, or null when the session is not valid. */
  verifyCaller(): Promise<string | null>;
  /** rpc with the caller's own client. */
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbErrorLike | null }>;
  /** Error log without secrets (codes / ids only). */
  logError(msg: string): void;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const err = (f: Failure): Reply => ({ status: f.status, body: { ok: false, error: f.error } });

export async function handleEvidenceUpload(
  method: string,
  hasAuth: boolean,
  bodyText: string,
  gw: Gateway,
  r2: R2Config | null,
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
  if (!r2) {
    gw.logError('R2 is not configured');
    return err(fail(503, 'storage_not_configured', 'File storage is not available. Try again later.'));
  }

  const uid = await gw.verifyCaller();
  if (!uid) return err(fail(401, 'unauthorized', 'Sign in again.'));

  const call = async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown } | Reply> => {
    const { data, error } = await gw.rpc(fn, args);
    if (error) {
      const f = mapDbError(error);
      if (f.status >= 500) gw.logError(`${fn} failed: ${error.code ?? 'unknown'} user ${uid} task ${req.task_id}`);
      return err(f);
    }
    return { data };
  };
  const isReply = (r: { data: unknown } | Reply): r is Reply => 'status' in r;

  // 1. Upload window per capture time (open task, or the D43 late / drain window).
  const refused: string[] = [];
  const times = [...new Set(req.files.map((f) => f.device_captured_at))];
  for (const t of times) {
    const r = await call('can_upload_evidence_at', { p_task_id: req.task_id, p_device_captured_at: t });
    if (isReply(r)) return r;
    if (r.data !== true) refused.push(...req.files.filter((f) => f.device_captured_at === t).map((f) => f.sha256));
  }
  if (refused.length > 0) {
    const f = fail(403, 'upload_window_closed', 'These files were taken after access ended and cannot be sent.');
    return { status: f.status, body: { ok: false, error: { ...f.error, refused } } };
  }

  // 2. The task's case and which files it already stores.
  const t = await call('evidence_upload_target', { p_task_id: req.task_id, p_sha256: req.files.map((f) => f.sha256) });
  if (isReply(t)) return t;
  const row = (Array.isArray(t.data) ? t.data[0] : t.data) as { case_id?: unknown; stored_sha256?: unknown } | undefined;
  if (!row || typeof row.case_id !== 'string') {
    gw.logError(`evidence_upload_target returned no case: user ${uid} task ${req.task_id}`);
    return err(fail(502, 'upstream_error', 'Something went wrong. Try again later.'));
  }
  if (row.case_id !== req.case_id) return err(fail(400, 'invalid_input', 'task_id does not belong to case_id.', 'case_id'));
  const stored = new Set(Array.isArray(row.stored_sha256) ? (row.stored_sha256 as string[]) : []);

  // 3. One short-lived PUT per new file, bound to its hash and size.
  const at = now();
  const files = [];
  for (const f of req.files) {
    const storage_path = evidenceKey(req.case_id, req.task_id, f.sha256, f.ext);
    if (stored.has(f.sha256)) {
      files.push({ sha256: f.sha256, status: 'already_stored', storage_path });
      continue;
    }
    const put = await presignEvidencePut(r2, storage_path, f.sha256, at, f.size);
    files.push({ sha256: f.sha256, status: 'upload', storage_path, method: 'PUT', ...put });
  }
  return { status: 200, body: { ok: true, case_id: req.case_id, files } };
}
