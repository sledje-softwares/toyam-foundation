// The info panel of one file (D54): what the office's reading found and the file's comments, with the phone's
// own comments merged in while they are being sent. Pure: everything the viewer / file sheet renders.
//
// Rule 4: confidence, model, OCR text and OCR summary are not part of FileLabel, so they cannot show here.
import { relativeTime } from '../lib/time';
import type { CommentSnapshot } from '../comments/queue';
import { isUnsent, type PendingComment } from '../comments/types';
import type { FileLabel, ThreadFile } from '../thread/model';

export interface InfoChip {
  key: string;
  text: string;
  /** The operator's own tag (category chip picked when sending). */
  own: boolean;
}

export interface InfoComment {
  key: string;
  /** "You" for the operator's own comments, else "Office" (field users cannot read other profiles). */
  author: string;
  time: string;
  body: string;
  mine: boolean;
  /** Where the phone's comment is ("Sending…", "Saved on phone — waiting for network", …); null once on the server. */
  status: string | null;
  /** The status is a problem the operator can act on (amber). */
  stuck: boolean;
  /** Show "Retry" (held, or waiting after an error, and online). */
  retry: boolean;
  /** Show "Remove" (never sent; only on the phone). */
  removable: boolean;
  clientCommentId: string | null;
}

export interface FileInfoView {
  chips: InfoChip[];
  description: string | null;
  /** Shown on the description line: no description yet and the AI has not finished with the file. */
  generating: boolean;
  comments: InfoComment[];
  /** Comments need the file on the server (an evidence id). */
  canComment: boolean;
  /** Shown instead of the input when the operator cannot comment yet. */
  cannotCommentText: string | null;
  /** Server comments plus the phone's own that are not on the server yet. */
  count: number;
}

export const GENERATING_TEXT = 'Description being generated…';
export const NOT_SENT_COMMENT_TEXT = 'You can add a comment once this file is sent.';
export const COMMENT_PLACEHOLDER = 'Add comment';

export const COMMENT_STATUS = {
  offline: 'Saved on phone — waiting for network',
  sending: 'Sending…',
  retrying: 'No connection to the server — will retry',
  session: 'Checking your sign-in — will retry',
  noTask: 'Not sent: you have no open task on this case. Ask the office, then tap Retry.',
  rejected: 'Not accepted by the server. Check the text, then tap Retry or Remove.',
} as const;

/** Labels from people first, then the reading, then rules; the operator's own tag last. */
const SOURCE_ORDER = ['human', 'llm', 'model', 'text_rule', 'filename_rule', 'operator'];
const rank = (s: string): number => {
  const i = SOURCE_ORDER.indexOf(s);
  return i < 0 ? SOURCE_ORDER.length - 1 : i;
};

/** One chip per category; `own` when the operator tagged it (also when the reading agrees). */
export function labelChips(labels: readonly FileLabel[]): InfoChip[] {
  const byName = new Map<string, { chip: InfoChip; rank: number }>();
  for (const l of [...labels].sort((a, b) => rank(a.source) - rank(b.source))) {
    const k = l.code ?? l.name;
    const cur = byName.get(k);
    const own = l.source === 'operator';
    if (cur) {
      if (own) cur.chip.own = true;
      continue;
    }
    byName.set(k, { chip: { key: k, text: l.name, own }, rank: rank(l.source) });
  }
  return [...byName.values()].map((x) => x.chip);
}

/** The description of the active label that has one: the LLM's first, then people, model, rules, the operator's. */
export function labelDescription(labels: readonly FileLabel[]): string | null {
  const order = ['llm', ...SOURCE_ORDER.filter((s) => s !== 'llm')];
  const r = (s: string) => (order.indexOf(s) < 0 ? order.length : order.indexOf(s));
  const withText = labels.filter((l) => l.description && l.description.trim() !== '').sort((a, b) => r(a.source) - r(b.source));
  return withText[0]?.description?.trim() ?? null;
}

/** Status line of one of the phone's comments; null once it is on the server. */
export function commentStatus(c: PendingComment, q: Pick<CommentSnapshot, 'online' | 'paused'>): { text: string | null; stuck: boolean; retry: boolean } {
  if (c.state === 'sent') return { text: null, stuck: false, retry: false };
  if (c.state === 'held') {
    return { text: c.held_reason === 'no_task' ? COMMENT_STATUS.noTask : COMMENT_STATUS.rejected, stuck: true, retry: q.online };
  }
  if (!q.online) return { text: COMMENT_STATUS.offline, stuck: false, retry: false };
  if (c.state === 'sending') return { text: COMMENT_STATUS.sending, stuck: false, retry: false };
  if (q.paused || c.last_error?.startsWith('auth:')) return { text: COMMENT_STATUS.session, stuck: true, retry: true };
  if (c.last_error) return { text: COMMENT_STATUS.retrying, stuck: true, retry: true };
  return { text: COMMENT_STATUS.sending, stuck: false, retry: false };
}

export function fileInfoView(
  f: Pick<ThreadFile, 'evidenceId' | 'labels' | 'comments' | 'processing'>,
  q: CommentSnapshot,
  me: string | null,
  now: Date,
): FileInfoView {
  const chips = labelChips(f.labels);
  const description = labelDescription(f.labels);
  // An 'llm' label means the AI has answered (it describes only where useful, D35), even if other stages still run.
  // Comments never depend on this: they need only the file on the server.
  const answered = description !== null || f.labels.some((l) => l.source === 'llm');
  const generating = !answered && (f.processing === 'pending' || f.processing === 'processing');

  const onServer = new Set(f.comments.map((c) => c.client_comment_id).filter((x): x is string => !!x));
  const comments: InfoComment[] = f.comments.map((c) => {
    const mine = me !== null && c.author_id === me;
    return {
      key: c.client_comment_id ?? c.id, author: mine ? 'You' : 'Office', time: relativeTime(c.created_at, now), body: c.body, mine,
      status: null, stuck: false, retry: false, removable: false, clientCommentId: c.client_comment_id,
    };
  });
  // the phone's own, not fetched yet: after the server's, oldest first (they move into place once fetched)
  const local = f.evidenceId
    ? q.comments.filter((c) => c.evidence_id === f.evidenceId && !onServer.has(c.client_comment_id)).sort((a, b) => a.created_at.localeCompare(b.created_at))
    : [];
  for (const c of local) {
    const st = commentStatus(c, q);
    comments.push({
      key: c.client_comment_id, author: 'You', time: relativeTime(c.sent_at ?? c.created_at, now), body: c.body, mine: true,
      status: st.text, stuck: st.stuck, retry: st.retry, removable: isUnsent(c) && c.state !== 'sending', clientCommentId: c.client_comment_id,
    });
  }
  const canComment = f.evidenceId !== null;
  return {
    chips, description, generating, comments, canComment,
    cannotCommentText: canComment ? null : NOT_SENT_COMMENT_TEXT,
    count: comments.length,
  };
}

/** The 💬 count on a thumbnail (server comments; the phone's own show inside the viewer). */
export const commentBadge = (f: Pick<ThreadFile, 'comments'>): string | null => (f.comments.length > 0 ? `💬 ${f.comments.length}` : null);

/** True when a comment of this case was sent since `prev` (fetch the thread soon so it shows from the server). */
export function newlySentComments(prev: ReadonlySet<string>, comments: readonly PendingComment[], caseId: string): string[] | null {
  const sent = comments.filter((c) => c.case_id === caseId && c.state === 'sent').map((c) => c.client_comment_id);
  return sent.some((id) => !prev.has(id)) ? sent : null;
}

export interface CommentSignOut {
  allowed: boolean;
  count: number;
  title: string;
  body: string;
  sendNow: string;
  signOut: string;
  stay: string;
}

/** Sign-out with comments still on the phone: say so (they are lost); the operator may still sign out. */
export function commentSignOutView(comments: readonly PendingComment[]): CommentSignOut {
  const n = comments.filter(isUnsent).length;
  return {
    allowed: n === 0,
    count: n,
    title: n === 1 ? '1 comment not sent yet' : `${n} comments not sent yet`,
    body: `${n === 1 ? 'A comment on a file is' : `${n} comments on files are`} still only on this phone. If you sign out now, ${n === 1 ? 'it is' : 'they are'} lost.`,
    sendNow: 'Send now',
    signOut: 'Sign out anyway',
    stay: 'Stay signed in',
  };
}
