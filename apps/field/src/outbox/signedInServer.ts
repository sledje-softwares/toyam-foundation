// Server for a signed-in field operator (JWT; RLS applies, never a service-role key — rule 4).
import { classifyPgError, type Presigned, type PresignRequest, type Server, ServerError } from './server';

/** The supabase-js surface used here (kept minimal so tests can fake it). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; hint?: string; message?: string } | null;
    status?: number;
  }>;
}

/**
 * TODO(5.x presigner): the R2 presigner for signed-in users does not exist yet. It must check
 * public.can_upload_evidence_at(task_id, device_captured_at) with the caller's JWT and answer like
 * field-drain `presign`: { storage_path: cases/{case_id}/tasks/{task_id}/{sha256}.{ext}, url,
 * headers: { 'x-amz-content-sha256': sha256 } }, refusing with hint upload_window_closed.
 * Until then uploads wait quietly (transient → backoff); nothing is lost.
 */
export const missingPresigner = async (_req: PresignRequest): Promise<Presigned> => {
  throw new ServerError('transient', 'presigner_missing', 'signed-in R2 presigner not deployed yet');
};

export function signedInServer(client: RpcClient, presign: (req: PresignRequest) => Promise<Presigned> = missingPresigner): Server {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    let res;
    try {
      res = await client.rpc(fn, args);
    } catch (e) {
      throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
    }
    if (res.error) throw classifyPgError({ ...res.error, status: res.status ?? null });
    return res.data;
  };
  return {
    presign,
    async postMessage(m) {
      const id = await call('post_thread_message', {
        p_case_id: m.case_id,
        p_client_message_id: m.client_message_id,
        p_kind: m.kind,
        p_body: m.body,
        p_task_id: m.task_id,
        p_reply_to: m.reply_to,
        p_items: m.items,
      });
      if (typeof id !== 'string') throw new ServerError('transient', 'bad_reply');
      return id;
    },
    async reportOutbox(r) {
      await call('report_outbox_status', {
        p_device_id: r.device_id,
        p_pending_count: r.pending_count,
        p_pending_bytes: r.pending_bytes,
        p_oldest_pending_at: r.oldest_pending_at,
      });
    },
  };
}
