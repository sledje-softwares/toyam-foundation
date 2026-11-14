// Request flow of the `field-drain` function (D43) against an injected gateway, so the whole flow
// is tested from Node with fakes. The Deno entry point (../../field-drain/index.ts) wires `rpc` to
// a service-role supabase-js client. Every decision (device secret, deactivation, windows, audit)
// is made by the drain_* SQL functions; this layer validates, maps errors and presigns R2 PUTs.
import {
  type DbErrorLike,
  evidenceKey,
  type Failure,
  fail,
  mapDbError,
  parseRequest,
  presignEvidencePut,
  type R2Config,
} from './logic.ts';

/** 30 files with on-device OCR text fit comfortably. */
export const MAX_BODY_CHARS = 1_000_000;

export interface Gateway {
  /** Service-role rpc to a public.drain_* function. */
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbErrorLike | null }>;
  /** Error log without secrets (codes / ids only). */
  logError(msg: string): void;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const ok = (data: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...data } });
const err = (f: Failure): Reply => ({ status: f.status, body: { ok: false, error: f.error } });

export async function handleFieldDrain(
  method: string,
  bodyText: string,
  gw: Gateway,
  r2: R2Config | null,
  now: () => Date = () => new Date(),
): Promise<Reply> {
  if (method !== 'POST') return err(fail(405, 'method_not_allowed', 'Use POST.'));
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
  const dev = { p_device_id: req.device_id, p_secret: req.secret };

  const call = async (fn: string, args: Record<string, unknown>): Promise<{ data: unknown } | Reply> => {
    const { data, error } = await gw.rpc(fn, { ...dev, ...args });
    if (error) {
      const f = mapDbError(error);
      if (f.status >= 500) gw.logError(`${fn} failed: ${error.code ?? 'unknown'} device ${req.device_id}`);
      return err(f);
    }
    return { data };
  };
  const isReply = (r: { data: unknown } | Reply): r is Reply => 'status' in r;

  switch (req.action) {
    case 'status': {
      const r = await call('drain_status', {});
      if (isReply(r)) return r;
      const row = (Array.isArray(r.data) ? r.data[0] : r.data) as Record<string, unknown> | undefined;
      return ok({ state: row?.state ?? 'closed', deactivated_at: row?.deactivated_at ?? null, drain_until: row?.drain_until ?? null });
    }
    case 'presign': {
      if (!r2) {
        gw.logError('R2 is not configured');
        return err(fail(503, 'storage_not_configured', 'File storage is not available. Try again later.'));
      }
      const r = await call('drain_authorize_upload', {
        p_task_id: req.task_id, p_sha256: req.sha256, p_device_captured_at: req.device_captured_at,
      });
      if (isReply(r)) return r;
      if (typeof r.data !== 'string') return err(fail(500, 'internal', 'Something went wrong. Try again later.'));
      const key = evidenceKey(r.data, req.task_id, req.sha256, req.ext);
      const put = await presignEvidencePut(r2, key, req.sha256, now());
      return ok({ case_id: r.data, storage_path: key, method: 'PUT', ...put });
    }
    case 'post': {
      const r = await call('drain_post_message', {
        p_case_id: req.case_id, p_client_message_id: req.client_message_id, p_kind: req.kind, p_body: req.body,
        p_task_id: req.task_id, p_reply_to: req.reply_to, p_items: req.items,
      });
      if (isReply(r)) return r;
      return ok({ message_id: r.data });
    }
    case 'outbox': {
      const r = await call('drain_report_outbox', {
        p_pending_count: req.pending_count, p_pending_bytes: req.pending_bytes, p_oldest_pending_at: req.oldest_pending_at,
      });
      return isReply(r) ? r : ok({});
    }
    case 'finish': {
      const r = await call('drain_finish', { p_discarded_count: req.discarded_count });
      return isReply(r) ? r : ok({ wipe: true });
    }
  }
}
