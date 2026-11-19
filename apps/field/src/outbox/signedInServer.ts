// Server for a signed-in field operator (JWT; RLS applies, never a service-role key — rule 4).
import {
  classifyPgError, type DerivativePresign, type DerivativePresignRequest, type Presigned, type PresignRequest, type Server, ServerError,
} from './server';

/** The supabase-js surface used here (kept minimal so tests can fake it). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; hint?: string; message?: string } | null;
    status?: number;
  }>;
}

/**
 * supabase-js `functions`: invoke() sends the signed-in session's access token. A non-2xx reply comes
 * back as an error whose `context` is the Response (FunctionsHttpError); a network failure has no
 * status (FunctionsFetchError).
 */
export interface FunctionsClient {
  functions: {
    invoke(fn: string, opts: { body: Record<string, unknown> }): PromiseLike<{ data: unknown; error: unknown }>;
  };
}

type ErrorContext = { status?: unknown; json?: () => Promise<unknown> };

/** Map an evidence-upload failure (supabase/functions/evidence-upload/README.md) to the outbox classes. */
export async function classifyUploadError(error: unknown): Promise<ServerError> {
  const ctx = (error as { context?: ErrorContext } | null)?.context;
  if (!ctx || typeof ctx.status !== 'number') {
    return new ServerError('transient', 'network', error instanceof Error ? error.message : String(error));
  }
  const status = ctx.status;
  let code: string | undefined;
  try {
    const body = (await ctx.json?.()) as { error?: { code?: unknown } } | undefined;
    if (typeof body?.error?.code === 'string') code = body.error.code;
  } catch {
    // body unreadable: classify by status
  }
  if (status === 401) return new ServerError('auth', code ?? 'unauthorized');
  if (code === 'upload_window_closed') return new ServerError('window_closed', code);
  if (status === 400 || status === 403 || status === 413) return new ServerError('rejected', code ?? `http_${status}`);
  return new ServerError('transient', code ?? `http_${status}`);
}

/** Default presigner: the `evidence-upload` edge function, one file per call. */
export function evidenceUploadPresigner(client: FunctionsClient): (req: PresignRequest) => Promise<Presigned> {
  return async (req) => {
    let res;
    try {
      res = await client.functions.invoke('evidence-upload', {
        body: {
          task_id: req.task_id,
          case_id: req.case_id,
          files: [{ sha256: req.sha256, size: req.size_bytes, mime: req.mime_type, device_captured_at: req.device_captured_at }],
        },
      });
    } catch (e) {
      throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
    }
    if (res.error) throw await classifyUploadError(res.error);
    const files = (res.data as { files?: unknown } | null)?.files;
    const f = Array.isArray(files)
      ? (files as Record<string, unknown>[]).find((x) => x && x.sha256 === req.sha256)
      : undefined;
    if (!f || typeof f.storage_path !== 'string') throw new ServerError('transient', 'bad_reply');
    if (f.status === 'already_stored') return { storage_path: f.storage_path, url: '', headers: {}, already_stored: true };
    if (f.status !== 'upload' || typeof f.url !== 'string') throw new ServerError('transient', 'bad_reply');
    return { storage_path: f.storage_path, url: f.url, headers: (f.headers ?? {}) as Record<string, string> };
  };
}

/** evidence-upload `derivatives`: both copies of one photo in one call (no `files`). */
export function derivativePresigner(client: FunctionsClient): (req: DerivativePresignRequest) => Promise<DerivativePresign[]> {
  return async (req) => {
    let res;
    try {
      res = await client.functions.invoke('evidence-upload', {
        body: {
          task_id: req.task_id,
          case_id: req.case_id,
          files: [],
          derivatives: req.copies.map((c) => ({ original_sha256: req.original_sha256, width: c.width, sha256: c.sha256, size: c.size_bytes })),
        },
      });
    } catch (e) {
      throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
    }
    if (res.error) throw await classifyUploadError(res.error);
    const list = (res.data as { derivatives?: unknown } | null)?.derivatives;
    if (!Array.isArray(list)) throw new ServerError('transient', 'bad_reply');
    return (list as Record<string, unknown>[]).flatMap((d) => {
      if (!d || typeof d.width !== 'number') return [];
      const status = d.status === 'upload' || d.status === 'already_stored' ? d.status : 'skipped';
      return [{
        width: d.width,
        status,
        ...(typeof d.storage_path === 'string' ? { storage_path: d.storage_path } : {}),
        ...(typeof d.url === 'string' ? { url: d.url } : {}),
        ...(d.headers && typeof d.headers === 'object' ? { headers: d.headers as Record<string, string> } : {}),
      } satisfies DerivativePresign];
    });
  };
}

export function signedInServer(
  client: RpcClient & FunctionsClient,
  presign: (req: PresignRequest) => Promise<Presigned> = evidenceUploadPresigner(client),
  presignDerivatives: (req: DerivativePresignRequest) => Promise<DerivativePresign[]> = derivativePresigner(client),
): Server {
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
    presignDerivatives,
    async recordDerivative(r) {
      try {
        await call('record_device_derivative', {
          p_case_id: r.case_id,
          p_original_sha256: r.original_sha256,
          p_width: r.width,
          p_storage_path: r.storage_path,
          p_sha256: r.sha256,
          p_size_bytes: r.size_bytes,
          p_pixel_width: r.pixel_width,
          p_pixel_height: r.pixel_height,
        });
      } catch (e) {
        // P0002 (photo not found among the caller's uploads) and 55000 (withdrawn) never get better
        if (e instanceof ServerError && e.kind === 'transient' && (e.code === 'P0002' || e.code === '55000')) {
          throw new ServerError('rejected', e.code, e.message);
        }
        throw e;
      }
    },
    async recordOcr(r) {
      try {
        await call('record_device_ocr', {
          p_case_id: r.case_id,
          p_original_sha256: r.original_sha256,
          p_source_width: r.source_width,
          p_engine_version: r.engine_version,
          p_lang: r.lang,
          p_text: r.text,
          p_blocks: r.blocks,
          p_mean_confidence: r.mean_confidence,
          p_description: r.description,
        });
      } catch (e) {
        if (e instanceof ServerError && e.kind === 'transient' && (e.code === 'P0002' || e.code === '55000')) {
          throw new ServerError('rejected', e.code, e.message);
        }
        throw e;
      }
    },
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
