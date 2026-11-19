import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../src/worker.ts';
import type { Handler, WorkerOptions } from '../src/worker.ts';
import { healthStatus } from '../src/health.ts';
import { memoryLogger } from '../src/log.ts';
import { createObjectStore, readCapped, StoreError } from '../src/storage.ts';
import { FakeDb, job } from './fakes.ts';

const opts = (over: Partial<WorkerOptions> = {}): WorkerOptions => ({
  workerId: 'w1', stages: ['text_extract', 'label', 'ocr', 'field_suggest'], concurrency: 2, pollMs: 5, maxIdleMs: 20,
  staleMinutes: 30, shutdownGraceMs: 50, ...over,
});

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('worker loop', () => {
  test('claims only stages with a handler, completes each job with the handler outcome', async () => {
    const db = new FakeDb();
    db.queue = [job({ id: 1 }), job({ id: 2, stage: 'ocr' }), job({ id: 3 })];
    const handlers: Partial<Record<string, Handler>> = {
      label: async (j) => (j.id === 1 ? { status: 'done' } : { status: 'skipped', reason: 'withdrawn' }),
      ocr: async () => { throw new Error('sidecar down'); },
    };
    const w = new Worker(db, handlers, memoryLogger(), opts());
    void w.start();
    await until(() => db.completed.length === 3);
    await w.stop();
    assert.deepEqual(db.claimCalls[0].stages, ['label', 'ocr'], 'text_extract and field_suggest have no handler here');
    const byId = Object.fromEntries(db.completed.map((c) => [c.id, c]));
    assert.deepEqual(byId[1], { id: 1, status: 'done', error: null });
    assert.deepEqual(byId[3], { id: 3, status: 'skipped', error: 'withdrawn' });
    assert.deepEqual(byId[2], { id: 2, status: 'failed', error: 'sidecar down' });
    assert.deepEqual([w.stats.done, w.stats.skipped, w.stats.failed], [1, 1, 1]);
  });

  test('never runs more than `concurrency` jobs at once', async () => {
    const db = new FakeDb();
    db.queue = Array.from({ length: 6 }, (_, i) => job({ id: i + 1 }));
    let active = 0;
    let peak = 0;
    const w = new Worker(db, { label: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { status: 'done' }; } },
      memoryLogger(), opts({ concurrency: 2 }));
    void w.start();
    await until(() => db.completed.length === 6);
    await w.stop();
    assert.equal(peak, 2);
    assert.ok(db.claimCalls.every((c) => c.limit <= 2));
  });

  test('idle polls back off up to the cap; database errors are logged and retried', async () => {
    const db = new FakeDb();
    db.claimError = new Error('connection refused');
    const log = memoryLogger();
    const w = new Worker(db, { label: async () => ({ status: 'done' }) }, log, opts());
    void w.start();
    await until(() => db.claimCalls.length >= 3);
    db.claimError = null;
    db.queue = [job({ id: 9 })];
    await until(() => db.completed.length === 1);
    await w.stop();
    assert.ok(log.lines.some((l) => l.event === 'claim_failed' && l.error === 'connection refused'));
    assert.equal(w.stats.lastPollOk, true);
  });

  test('at start, hands back jobs this worker id left running and jobs stale for too long', async () => {
    const db = new FakeDb();
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    db.runningJobs = [
      { id: 1, locked_by: 'w1', locked_at: new Date().toISOString() },
      { id: 2, locked_by: 'other', locked_at: old },
      { id: 3, locked_by: 'other', locked_at: new Date().toISOString() },
    ];
    const w = new Worker(db, { label: async () => ({ status: 'done' }) }, memoryLogger(), opts());
    void w.start();
    await until(() => db.completed.length === 2);
    await w.stop();
    assert.deepEqual(db.completed.map((c) => [c.id, c.status]), [[1, 'failed'], [2, 'failed']]);
    assert.match(db.completed[0].error!, /restarted/);
  });

  test('shutdown: stops claiming, waits for running jobs, aborts them after the grace period', async () => {
    const db = new FakeDb();
    db.queue = [job({ id: 1 }), job({ id: 2 })];
    const w = new Worker(db, {
      label: (j, signal) => new Promise((res, rej) => {
        if (j.id === 1) setTimeout(() => res({ status: 'done' }), 10);
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      }),
    }, memoryLogger(), opts({ shutdownGraceMs: 40 }));
    void w.start();
    await until(() => w.running.size === 2);
    const claimsBefore = db.claimCalls.length;
    await w.stop();
    assert.equal(db.claimCalls.length, claimsBefore, 'no claims after stop');
    const byId = Object.fromEntries(db.completed.map((c) => [c.id, c]));
    assert.equal(byId[1].status, 'done');
    assert.deepEqual(byId[2], { id: 2, status: 'failed', error: 'worker shutting down' });
  });
});

describe('health', () => {
  test('200 while polling, 503 when the last poll is old or the worker stops', () => {
    const stats = { workerId: 'w', startedAt: '', stages: [], inflight: 0, claimed: 0, done: 0, skipped: 0, failed: 0, lastPollAt: new Date(1000).toISOString(), lastPollOk: true, stopping: false };
    assert.equal(healthStatus(stats as any, {}, 2000, 60_000).code, 200);
    assert.equal(healthStatus(stats as any, {}, 100_000, 60_000).code, 503);
    assert.equal(healthStatus({ ...stats, stopping: true } as any, {}, 2000, 60_000).code, 503);
    assert.equal(healthStatus({ ...stats, lastPollOk: false } as any, {}, 2000, 60_000).code, 503);
  });
});

describe('object store', () => {
  test('R2 reads use a presigned GET on the bucket path with the read token', async () => {
    const urls: string[] = [];
    const store = createObjectStore({
      r2: { accountId: 'acc', bucket: 'toyam-evidence', accessKeyId: 'READKEY', secretAccessKey: 'secret' }, supabase: null,
      now: () => new Date('2026-11-19T00:00:00Z'),
      fetch: async (url) => { urls.push(url); return new Response('bytes'); },
    });
    const b = await store.get('r2', 'derived/c/abc/w384-def.jpg', { maxBytes: 100 });
    assert.equal(Buffer.from(b).toString(), 'bytes');
    assert.match(urls[0], /^https:\/\/acc\.r2\.cloudflarestorage\.com\/toyam-evidence\/derived\/c\/abc\/w384-def\.jpg\?/);
    assert.match(urls[0], /X-Amz-Credential=READKEY%2F20261119%2Fauto%2Fs3%2Faws4_request/);
    assert.ok(!urls[0].includes('secret'));
  });

  test('size caps and HTTP errors', async () => {
    await assert.rejects(readCapped(new Response('0123456789'), 5), /larger than 5 bytes/);
    const store = createObjectStore({ r2: { accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }, supabase: null, fetch: async () => new Response('', { status: 503 }) });
    await assert.rejects(store.get('r2', 'x', { maxBytes: 10 }), (e: unknown) => e instanceof StoreError && e.retryable);
    await assert.rejects(createObjectStore({ r2: null, supabase: null }).get('r2', 'x', { maxBytes: 1 }), /R2 is not configured/);
  });
});
