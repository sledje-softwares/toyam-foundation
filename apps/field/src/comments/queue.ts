// Comment queue (D54): comments on files are saved on the phone first and sent by themselves, oldest first,
// with the outbox's backoff (30 s → 30 min, jitter). Every retry reuses the comment's client_comment_id, so the
// server stores it once (rule 6). Pure: store, server, clock and timer are injected (tested in queue.test.ts).
import { backoffDelay } from '../outbox/backoff';
import { ServerError } from '../outbox/server';
import type { CommentServer } from './server';
import type { CommentStore } from './store';
import { COMMENT_MAX, isUnsent, type PendingComment } from './types';

export interface CommentQueueDeps {
  store: CommentStore;
  server: CommentServer;
  uuid: () => string;
  now?: () => Date;
  random?: () => number;
  /** Schedule a retry; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (m: string) => void;
}

export interface CommentSnapshot {
  comments: PendingComment[];
  online: boolean;
  /** Session refused: sending waits for the next Retry / connectivity change. */
  paused: boolean;
  next_retry_at: string | null;
}

/** A sent comment that no fetch confirmed (file withdrawn, case closed) is forgotten after this long. */
export const SENT_KEEP_MS = 7 * 24 * 3_600_000;

/** Code points, like Postgres char_length. */
export const commentLength = (s: string): number => [...s].length;

/** null when the text can be sent, else what to tell the operator. */
export function checkCommentBody(body: string): string | null {
  const t = body.trim();
  if (t === '') return 'Write a comment first.';
  const n = commentLength(t);
  if (n > COMMENT_MAX) return `A comment can be at most ${COMMENT_MAX} characters (this one has ${n}).`;
  return null;
}

export type AddResult = { ok: true; comment: PendingComment } | { ok: false; error: string };

export class CommentQueue {
  private d: Required<Omit<CommentQueueDeps, 'log'>> & { log: (m: string) => void };
  private items: PendingComment[] = [];
  private online = false;
  private paused = false;
  private failures = 0;
  private nextRetryAt: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<() => void>();
  private snap: CommentSnapshot | null = null;

  constructor(deps: CommentQueueDeps) {
    this.d = {
      now: () => new Date(),
      random: Math.random,
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      log: () => {},
      ...deps,
    };
  }

  /** Reloads the queue; a comment cut off mid-send goes back to queued; old sent copies are dropped. */
  async init(): Promise<void> {
    const loaded = await this.d.store.load();
    const now = this.d.now().getTime();
    const keep: PendingComment[] = [];
    for (const c of loaded) {
      const at = Date.parse(c.sent_at ?? c.created_at);
      if (c.state === 'sent' && !Number.isNaN(at) && now - at > SENT_KEEP_MS) {
        await this.d.store.remove(c.client_comment_id);
        continue;
      }
      if (c.state === 'sending') {
        c.state = 'queued';
        await this.d.store.put(c);
      }
      keep.push(c);
    }
    this.items = keep.sort((a, b) => a.created_at.localeCompare(b.created_at));
    this.changed();
  }

  snapshot(): CommentSnapshot {
    if (!this.snap) {
      this.snap = { comments: this.items.map((c) => ({ ...c })), online: this.online, paused: this.paused, next_retry_at: this.nextRetryAt };
    }
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    if (online) {
      this.paused = false;
      this.resetBackoff();
    }
    this.changed();
    if (online) this.kick();
  }

  /** Send pressed in the info panel. Only for files already on the server (evidence id). */
  async add(input: { case_id: string; evidence_id: string; body: string }): Promise<AddResult> {
    const error = checkCommentBody(input.body);
    if (error) return { ok: false, error };
    if (!input.evidence_id) return { ok: false, error: 'You can comment once the file is sent.' };
    const c: PendingComment = {
      client_comment_id: this.d.uuid(),
      case_id: input.case_id,
      evidence_id: input.evidence_id,
      body: input.body.trim(),
      created_at: this.d.now().toISOString(),
      state: 'queued',
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      held_reason: null,
      comment_id: null,
      sent_at: null,
    };
    await this.d.store.put(c);
    this.items.push(c);
    this.changed();
    this.kick();
    return { ok: true, comment: { ...c } };
  }

  /** Retry: resets the backoff and the session pause and tries held comments again (optionally of one case). */
  async sendNow(caseId?: string): Promise<void> {
    for (const c of this.items) {
      if (c.state === 'held' && (caseId === undefined || c.case_id === caseId)) {
        c.state = 'queued';
        c.held_reason = null;
        await this.d.store.put(c);
      }
    }
    this.paused = false;
    this.resetBackoff();
    this.changed();
    this.kick();
  }

  /** The operator got a new open task on this case: held comments get another go. */
  retryHeld(caseId: string): Promise<void> {
    return this.items.some((c) => c.case_id === caseId && c.state === 'held') ? this.sendNow(caseId) : Promise.resolve();
  }

  /** "Remove" on a comment that was not sent (never while it is being sent). */
  async remove(clientCommentId: string): Promise<boolean> {
    const c = this.items.find((x) => x.client_comment_id === clientCommentId);
    if (!c || c.state === 'sending' || c.state === 'sent') return false;
    this.items = this.items.filter((x) => x !== c);
    await this.d.store.remove(clientCommentId);
    this.changed();
    return true;
  }

  /** A thread fetch returned these comments: the phone's copies are no longer needed. */
  async confirm(serverClientIds: ReadonlySet<string>): Promise<void> {
    const gone = this.items.filter((c) => c.state !== 'sending' && serverClientIds.has(c.client_comment_id));
    if (gone.length === 0) return;
    this.items = this.items.filter((c) => !gone.includes(c));
    for (const c of gone) await this.d.store.remove(c.client_comment_id);
    this.changed();
  }

  /** Sign-out: everything goes. Returns how many comments were never sent. */
  async wipe(): Promise<number> {
    const unsent = this.items.filter(isUnsent).length;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.items = [];
    this.paused = false;
    this.resetBackoff();
    await this.d.store.clear();
    this.changed();
    return unsent;
  }

  /** One sending pass (also from the background task). Resolves when it stops. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Tests: resolves once no pass is running. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  // ---------------------------------------------------------------- internals

  private kick(): void {
    void this.run();
  }

  private resetBackoff(): void {
    this.failures = 0;
    this.nextRetryAt = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private async pass(): Promise<void> {
    while (this.online && !this.paused && this.nextRetryAt === null) {
      const c = this.items.find((x) => x.state === 'queued');
      if (!c) return;
      c.state = 'sending';
      c.attempts += 1;
      c.last_attempt_at = this.d.now().toISOString();
      await this.d.store.put(c);
      this.changed();
      try {
        const id = await this.d.server.addComment({ evidence_id: c.evidence_id, body: c.body, client_comment_id: c.client_comment_id });
        c.state = 'sent';
        c.comment_id = id;
        c.sent_at = this.d.now().toISOString();
        c.last_error = null;
        this.failures = 0;
        await this.d.store.put(c);
        this.changed();
      } catch (e) {
        const err = e instanceof ServerError ? e : new ServerError('transient', 'client', String(e));
        c.last_error = `${err.kind}:${err.code}`;
        if (err.kind === 'rejected' || err.kind === 'window_closed') {
          c.state = 'held';
          c.held_reason = err.code === '42501' ? 'no_task' : 'rejected';
          await this.d.store.put(c);
          this.d.log(`comment ${c.client_comment_id} held: ${err.code}`);
          this.changed();
          continue; // the next comment may be on another case
        }
        c.state = 'queued';
        await this.d.store.put(c);
        if (err.kind === 'auth') {
          this.paused = true; // until Retry or a connectivity change
        } else {
          this.failures += 1;
          const ms = backoffDelay(this.failures, this.d.random);
          this.nextRetryAt = new Date(this.d.now().getTime() + ms).toISOString();
          this.cancelTimer = this.d.setTimer(() => {
            this.cancelTimer = null;
            this.nextRetryAt = null;
            this.changed();
            this.kick();
          }, ms);
        }
        this.changed();
        return;
      }
    }
  }

  private changed(): void {
    this.snap = null;
    for (const l of this.listeners) l();
  }
}
