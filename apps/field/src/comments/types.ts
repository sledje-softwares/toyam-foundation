// Comments on a file (D54), saved on the phone first and sent by themselves (sibling of the outbox).
// Pure types: no React Native imports.

/**
 * queued → sending → sent (until a thread fetch returns it, then dropped); `held` = refused by the server
 * (no open task on an open case, or invalid), kept on the phone with a reason until Retry or Remove.
 */
export type CommentState = 'queued' | 'sending' | 'sent' | 'held';

/** Why a comment is held. */
export type CommentHeldReason = 'no_task' | 'rejected';

export interface PendingComment {
  /** Created on the device; every retry reuses it (rule 6: add_evidence_comment is idempotent on it). */
  client_comment_id: string;
  case_id: string;
  evidence_id: string;
  body: string;
  /** Device clock: when Send was pressed. */
  created_at: string;
  state: CommentState;
  attempts: number;
  last_attempt_at: string | null;
  /** Internal (`<kind>:<code>`), for the status line and logs; never shown as "failed". */
  last_error: string | null;
  held_reason: CommentHeldReason | null;
  /** Server comment id once sent. */
  comment_id: string | null;
  sent_at: string | null;
}

/** Still only on the phone (lost on sign-out). */
export const isUnsent = (c: Pick<PendingComment, 'state'>): boolean => c.state !== 'sent';

/** evidence_comments.body: 1–1000 characters (Postgres counts code points). */
export const COMMENT_MAX = 1000;
