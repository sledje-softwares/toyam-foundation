import { describe, expect, it } from 'vitest';
import { ServerError } from '../outbox/server';
import { checkCommentBody, CommentQueue, commentLength, SENT_KEEP_MS } from './queue';
import { classifyCommentError, commentServer, type CommentServer } from './server';
import { MemoryCommentStore } from './store';
import type { PendingComment } from './types';

class FakeCommentServer implements CommentServer {
  /** What the database holds, by client_comment_id (idempotent like add_evidence_comment). */
  stored = new Map<string, { evidence_id: string; body: string }>();
  calls: { evidence_id: string; body: string; client_comment_id: string }[] = [];
  errors: (ServerError | undefined)[] = [];
  loseNextReply = false;
  async addComment(req: { evidence_id: string; body: string; client_comment_id: string }): Promise<string> {
    this.calls.push(req);
    if (this.stored.has(req.client_comment_id)) return `c-${req.client_comment_id}`;
    const e = this.errors.shift();
    if (e) throw e;
    this.stored.set(req.client_comment_id, { evidence_id: req.evidence_id, body: req.body });
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new ServerError('transient', 'network');
    }
    return `c-${req.client_comment_id}`;
  }
}

function setup(opts: { store?: MemoryCommentStore; start?: string } = {}) {
  const store = opts.store ?? new MemoryCommentStore();
  const server = new FakeCommentServer();
  let t = Date.parse(opts.start ?? '2026-11-27T10:00:00Z');
  let n = 0;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const q = new CommentQueue({
    store, server,
    uuid: () => `cc-${++n}`,
    now: () => new Date(t),
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const tm = { fn, ms, cancelled: false };
      timers.push(tm);
      return () => { tm.cancelled = true; };
    },
  });
  const fire = async () => {
    const tm = timers.filter((x) => !x.cancelled).pop();
    if (!tm) throw new Error('no timer');
    tm.cancelled = true;
    t += tm.ms;
    tm.fn();
    await q.whenIdle();
  };
  return { q, store, server, timers, fire, advance: (ms: number) => { t += ms; } };
}

const add = (q: CommentQueue, body = 'Rear bumper dent is old', evidence_id = 'e1') => q.add({ case_id: 'c1', evidence_id, body });

describe('checkCommentBody', () => {
  it('1–1000 characters after trimming, counted as code points', () => {
    expect(checkCommentBody('   ')).toBe('Write a comment first.');
    expect(checkCommentBody('ok')).toBeNull();
    expect(checkCommentBody('x'.repeat(1000))).toBeNull();
    expect(checkCommentBody('x'.repeat(1001))).toBe('A comment can be at most 1000 characters (this one has 1001).');
    expect(commentLength('नमस्ते😀')).toBe(7);
    expect(checkCommentBody('😀'.repeat(1000))).toBeNull(); // 2000 UTF-16 units, 1000 code points
  });
});

describe('CommentQueue', () => {
  it('offline: saved on the phone, sent with the same id when the network comes back', async () => {
    const { q, store, server } = setup();
    await q.init();
    const r = await add(q, '  Rear bumper dent is old  ');
    expect(r.ok).toBe(true);
    await q.whenIdle();
    expect(server.calls).toHaveLength(0);
    expect(q.snapshot().comments.map((c) => [c.state, c.body])).toEqual([['queued', 'Rear bumper dent is old']]);
    expect(store.rows.size).toBe(1);
    q.setOnline(true);
    await q.whenIdle();
    expect(server.calls).toEqual([{ evidence_id: 'e1', body: 'Rear bumper dent is old', client_comment_id: 'cc-1' }]);
    const c = q.snapshot().comments[0]!;
    expect([c.state, c.comment_id]).toEqual(['sent', 'c-cc-1']);
  });

  it('refuses empty, too long and files not on the server, without queueing', async () => {
    const { q } = setup();
    await q.init();
    expect(await add(q, '  ')).toEqual({ ok: false, error: 'Write a comment first.' });
    expect((await add(q, 'x'.repeat(1001))).ok).toBe(false);
    expect(await add(q, 'fine', '')).toEqual({ ok: false, error: 'You can comment once the file is sent.' });
    expect(q.snapshot().comments).toHaveLength(0);
  });

  it('transient errors back off (30 s doubling) and retry with the same client id; a lost reply is not stored twice', async () => {
    const { q, server, timers, fire } = setup();
    await q.init();
    q.setOnline(true);
    server.errors.push(new ServerError('transient', 'http_503'));
    await add(q);
    await q.whenIdle();
    expect(q.snapshot().comments[0]!.state).toBe('queued');
    expect(q.snapshot().comments[0]!.last_error).toBe('transient:http_503');
    expect(q.snapshot().next_retry_at).not.toBeNull();
    expect(timers.at(-1)!.ms).toBe(22_500); // 30 s step, equal jitter at 0.5
    server.loseNextReply = true;
    await fire();
    expect(timers.at(-1)!.ms).toBe(45_000);
    await fire();
    expect(server.calls.map((c) => c.client_comment_id)).toEqual(['cc-1', 'cc-1', 'cc-1']);
    expect(server.stored.size).toBe(1);
    expect(q.snapshot().comments[0]!.state).toBe('sent');
    expect(q.snapshot().next_retry_at).toBeNull();
  });

  it('no open task (42501): held with a reason, the next comment still goes; Retry sends it again', async () => {
    const { q, server } = setup();
    await q.init();
    q.setOnline(true);
    server.errors.push(new ServerError('rejected', '42501'));
    await add(q, 'first', 'e1');
    await q.whenIdle();
    await add(q, 'second', 'e2');
    await q.whenIdle();
    const [a, b] = q.snapshot().comments;
    expect([a!.state, a!.held_reason]).toEqual(['held', 'no_task']);
    expect(b!.state).toBe('sent');
    await q.sendNow();
    await q.whenIdle();
    expect(q.snapshot().comments.map((c) => c.state)).toEqual(['sent', 'sent']);
  });

  it('other refusals are held as rejected; retryHeld only acts on that case', async () => {
    const { q, server } = setup();
    await q.init();
    q.setOnline(true);
    server.errors.push(new ServerError('rejected', '22023'));
    await add(q);
    await q.whenIdle();
    expect(q.snapshot().comments[0]!.held_reason).toBe('rejected');
    await q.retryHeld('other-case');
    await q.whenIdle();
    expect(q.snapshot().comments[0]!.state).toBe('held');
    await q.retryHeld('c1');
    await q.whenIdle();
    expect(q.snapshot().comments[0]!.state).toBe('sent');
  });

  it('session refused pauses sending until Retry or a connectivity change', async () => {
    const { q, server } = setup();
    await q.init();
    q.setOnline(true);
    server.errors.push(new ServerError('auth', 'PGRST301'));
    await add(q, 'a');
    await q.whenIdle();
    expect(q.snapshot().paused).toBe(true);
    await add(q, 'b');
    await q.whenIdle();
    expect(server.calls).toHaveLength(1);
    q.setOnline(false);
    q.setOnline(true);
    await q.whenIdle();
    expect(q.snapshot().comments.map((c) => c.state)).toEqual(['sent', 'sent']);
  });

  it('restart: a comment cut off mid-send is queued again; old sent copies are dropped', async () => {
    const store = new MemoryCommentStore();
    const base: PendingComment = {
      client_comment_id: 'x', case_id: 'c1', evidence_id: 'e1', body: 'b', created_at: '2026-11-27T09:00:00Z', state: 'sending',
      attempts: 1, last_attempt_at: null, last_error: null, held_reason: null, comment_id: null, sent_at: null,
    };
    await store.put(base);
    await store.put({ ...base, client_comment_id: 'old', state: 'sent', sent_at: new Date(Date.parse('2026-11-27T10:00:00Z') - SENT_KEEP_MS - 1).toISOString() });
    await store.put({ ...base, client_comment_id: 'recent', state: 'sent', sent_at: '2026-11-27T09:30:00Z' });
    const { q } = setup({ store });
    await q.init();
    expect(q.snapshot().comments.map((c) => [c.client_comment_id, c.state])).toEqual([['x', 'queued'], ['recent', 'sent']]);
    expect(store.rows.has('old')).toBe(false);
  });

  it('confirm drops the phone copies a fetch returned; remove only unsent ones; wipe counts unsent', async () => {
    const { q, server, store } = setup();
    await q.init();
    q.setOnline(true);
    await add(q, 'sent one');
    await q.whenIdle();
    server.errors.push(new ServerError('rejected', '42501'));
    await add(q, 'held one');
    await q.whenIdle();
    expect(await q.remove('cc-1')).toBe(false); // sent: stays until confirmed
    await q.confirm(new Set(['cc-1']));
    expect(q.snapshot().comments.map((c) => c.client_comment_id)).toEqual(['cc-2']);
    q.setOnline(false);
    await add(q, 'queued one');
    expect(await q.wipe()).toBe(2);
    expect(store.rows.size).toBe(0);
    await add(q, 'again');
    expect(await q.remove('cc-4')).toBe(true);
    expect(q.snapshot().comments).toHaveLength(0);
  });

  it('snapshot is stable between changes and listeners hear changes', async () => {
    const { q } = setup();
    await q.init();
    let calls = 0;
    q.subscribe(() => calls++);
    const s1 = q.snapshot();
    expect(q.snapshot()).toBe(s1);
    await add(q);
    expect(calls).toBeGreaterThan(0);
    expect(q.snapshot()).not.toBe(s1);
  });
});

describe('commentServer / classifyCommentError', () => {
  it('calls add_evidence_comment with the client id and returns the comment id', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const s = commentServer({ rpc: async (fn, args) => { calls.push([fn, args]); return { data: 'id-1', error: null }; } });
    expect(await s.addComment({ evidence_id: 'e1', body: 'b', client_comment_id: 'cc' })).toBe('id-1');
    expect(calls).toEqual([['add_evidence_comment', { p_evidence_id: 'e1', p_body: 'b', p_client_comment_id: 'cc' }]]);
  });
  it('maps refusals, session and network errors', async () => {
    const fail = (error: { code?: string; hint?: string; message?: string }, status?: number) =>
      commentServer({ rpc: async () => ({ data: null, error, status }) }).addComment({ evidence_id: 'e', body: 'b', client_comment_id: 'c' });
    await expect(fail({ code: '42501', message: 'No open task' })).rejects.toMatchObject({ kind: 'rejected', code: '42501' });
    await expect(fail({ code: '22023' })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(fail({ code: 'P0002' })).rejects.toMatchObject({ kind: 'rejected', code: 'P0002' });
    for (const code of ['23505', '55000', '54000']) {
      await expect(fail({ code })).rejects.toMatchObject({ kind: 'rejected', code });
    }
    await expect(fail({ code: 'PGRST301' })).rejects.toMatchObject({ kind: 'auth' });
    await expect(fail({ code: '' }, 503)).rejects.toMatchObject({ kind: 'transient' });
    const thrown = commentServer({ rpc: async () => { throw new Error('Network request failed'); } });
    await expect(thrown.addComment({ evidence_id: 'e', body: 'b', client_comment_id: 'c' })).rejects.toMatchObject({ kind: 'transient', code: 'network' });
    expect(classifyCommentError({ code: '42501', hint: 'upload_window_closed' }).kind).toBe('rejected');
  });
});
