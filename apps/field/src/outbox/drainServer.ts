// field-drain client (docs/11 "Remote sign-out contract"): no JWT; device_id + secret on every call.
import { classifyDrainError, type DrainServer, type DrainState, ServerError } from './server';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export function drainServer(opts: { baseUrl: string; anonKey: string; deviceId: string; secret: string; fetch: FetchLike }): DrainServer {
  const call = async (action: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let res;
    let body: Record<string, unknown> = {};
    try {
      res = await opts.fetch(`${opts.baseUrl}/functions/v1/field-drain`, {
        method: 'POST',
        // apikey routes the request through the gateway; no Authorization (the user is banned)
        headers: { 'content-type': 'application/json', apikey: opts.anonKey },
        body: JSON.stringify({ action, device_id: opts.deviceId, secret: opts.secret, ...extra }),
      });
      body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch (e) {
      throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
    }
    if (res.status >= 200 && res.status < 300 && body.ok === true) return body;
    const code = (body.error as { code?: string } | undefined)?.code;
    throw classifyDrainError(res.status, code);
  };
  return {
    async presign(r) {
      const b = await call('presign', { task_id: r.task_id, sha256: r.sha256, ext: r.ext, device_captured_at: r.device_captured_at });
      return { storage_path: String(b.storage_path), url: String(b.url), headers: (b.headers ?? {}) as Record<string, string> };
    },
    async postMessage(m) {
      if (m.kind === 'text') throw new ServerError('rejected', 'drain_text');
      const b = await call('post', {
        case_id: m.case_id, client_message_id: m.client_message_id, kind: m.kind, body: m.body,
        task_id: m.task_id, reply_to: m.reply_to, items: m.items,
      });
      return String(b.message_id);
    },
    async reportOutbox(r) {
      await call('outbox', { pending_count: r.pending_count, pending_bytes: r.pending_bytes, oldest_pending_at: r.oldest_pending_at });
    },
    async status() {
      const b = await call('status', {});
      return {
        state: (b.state as DrainState) ?? 'closed',
        deactivated_at: (b.deactivated_at as string | null) ?? null,
        drain_until: (b.drain_until as string | null) ?? null,
      };
    },
    async finish(discarded) {
      await call('finish', { discarded_count: discarded });
    },
  };
}
