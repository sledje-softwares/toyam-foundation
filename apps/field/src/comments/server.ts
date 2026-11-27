// add_evidence_comment for a signed-in operator (JWT; RLS and the function's own checks apply, rule 4).
import { classifyPgError, ServerError, type PgErrorLike } from '../outbox/server';
import type { RpcClient } from '../outbox/signedInServer';

export interface CommentServer {
  /** Idempotent on client_comment_id; returns the server comment id. Throws ServerError. */
  addComment(req: { evidence_id: string; body: string; client_comment_id: string }): Promise<string>;
}

/**
 * Same classes as the outbox: 42501 (no open task on an open case / not your file) → held as `no_task`;
 * invalid input or unknown file (22023, 22P02, 23503, 23514, P0002), client id already used (23505), file
 * withdrawn (55000), 50-comment cap (54000) → held as `rejected`; session refused → auth;
 * anything else (network, 5xx) → transient.
 */
const COMMENT_REJECTED = new Set(['P0002', '23514', '23505', '55000', '54000']);

export function classifyCommentError(e: PgErrorLike): ServerError {
  const code = e.code ?? '';
  if (COMMENT_REJECTED.has(code)) return new ServerError('rejected', code, e.message ?? code);
  const c = classifyPgError(e);
  // a window_closed hint cannot apply to comments; treat it like any other permission refusal
  return c.kind === 'window_closed' ? new ServerError('rejected', '42501', c.message) : c;
}

export function commentServer(client: RpcClient): CommentServer {
  return {
    async addComment(req) {
      let res;
      try {
        res = await client.rpc('add_evidence_comment', {
          p_evidence_id: req.evidence_id,
          p_body: req.body,
          p_client_comment_id: req.client_comment_id,
        });
      } catch (e) {
        throw new ServerError('transient', 'network', e instanceof Error ? e.message : String(e));
      }
      if (res.error) throw classifyCommentError({ ...res.error, status: res.status ?? null });
      if (typeof res.data !== 'string' || res.data === '') throw new ServerError('transient', 'bad_reply');
      return res.data;
    },
  };
}
