import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelay } from './backoff';
import { Clock, FakeServer, item, newFile, setup } from './fakes.test-helpers';
import type { OutboxEvent } from './outbox';
import { ServerError } from './server';
import { canTransition } from './stateMachine';
import { MemoryStore } from './store';

const flush = async (o: { run(): Promise<void> }) => {
  await o.run();
};

describe('state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('queued', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'stored')).toBe(true);
    expect(canTransition('uploading', 'queued')).toBe(true);
    expect(canTransition('uploading', 'held')).toBe(true);
    expect(canTransition('stored', 'processed')).toBe(true);
    expect(canTransition('processed', 'seen')).toBe(true);
    expect(canTransition('held', 'queued')).toBe(true);
    expect(canTransition('queued', 'stored')).toBe(false);
    expect(canTransition('stored', 'queued')).toBe(false);
    expect(canTransition('seen', 'processed')).toBe(false);
  });
});

describe('backoff', () => {
  it('starts at 30 s, doubles and caps at 30 min with jitter between half and all of the step', () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(1, () => 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelay(1, () => 0.999999)).toBeCloseTo(BACKOFF_BASE_MS, -1);
    expect(backoffDelay(2, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(30, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(backoffDelay(30, () => 0)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe('Outbox sending', () => {
  it('stays queued while offline and sends files then the message when online', async () => {
    const { outbox, server, transport, removed } = setup();
    await outbox.init();
    const it1 = await outbox.enqueue(item([newFile(), newFile()], { caption: ' front ' }));
    await flush(outbox);
    expect(outbox.snapshot().items[0]!.state).toBe('queued');
    expect(server.postCalls).toHaveLength(0);

    outbox.setOnline(true);
    await flush(outbox);
    const s = outbox.snapshot().items;
    expect(transport.puts).toHaveLength(2);
    expect(server.postCalls).toHaveLength(1);
    const post = server.postCalls[0]!;
    expect(post.client_message_id).toBe(it1.client_message_id);
    expect(post.body).toBe('front');
    expect(post.items[0]!.storage_path).toMatch(/^cases\/case-1\/tasks\/task-1\/[0-9a-f]{64}\.jpg$/);
    expect(post.items[0]!.latitude).toBe(19.07);
    // queue drained: stored rows pruned, sandbox files deleted
    expect(s).toHaveLength(0);
    expect(removed).toHaveLength(2);
  });

  it('never sends one client_message_id as two messages across retries (lost reply)', async () => {
    const { outbox, server, transport, clock } = setup();
    await outbox.init();
    outbox.setOnline(true);
    server.loseNextReply = true;
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    expect(server.messages.size).toBe(1);
    expect(outbox.snapshot().items[0]!.state).toBe('queued');
    clock.advance(BACKOFF_CAP_MS);
    await flush(outbox);
    expect(server.postCalls).toHaveLength(2);
    expect(new Set(server.postCalls.map((p) => p.client_message_id)).size).toBe(1);
    expect(server.messages.size).toBe(1);
    // the file was already in R2: not uploaded again
    expect(transport.puts).toHaveLength(1);
    expect(outbox.snapshot().items).toHaveLength(0);
  });

  it('backs off on transient errors, schedules a wake-up, and resets on connectivity change', async () => {
    const { outbox, server, timers, clock } = setup();
    await outbox.init();
    outbox.setOnline(true);
    server.presignErrors = [new ServerError('transient', 'network'), new ServerError('transient', 'network')];
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    expect(timers.at(-1)!.ms).toBe(backoffDelay(1, () => 0.5));
    await flush(outbox); // still inside the backoff: nothing tried
    expect(server.presignCalls).toHaveLength(1);
    clock.advance(timers.at(-1)!.ms);
    timers.at(-1)!.fn();
    await flush(outbox);
    expect(server.presignCalls).toHaveLength(2);
    expect(timers.at(-1)!.ms).toBe(backoffDelay(2, () => 0.5));
    outbox.setOnline(false);
    outbox.setOnline(true); // reset: tries at once
    await flush(outbox);
    expect(server.presignCalls).toHaveLength(3);
    expect(outbox.snapshot().items).toHaveLength(0);
    const it0 = server.postCalls[0]!;
    expect(it0).toBeDefined();
  });

  it('records attempts and the internal error but never a failed state', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    outbox.setOnline(true);
    server.postErrors = [new ServerError('transient', 'http_503')];
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    const i = outbox.snapshot().items[0]!;
    expect(i.state).toBe('queued');
    expect(i.attempts).toBe(1);
    expect(i.last_attempt_at).not.toBeNull();
    expect(i.last_error).toBe('transient:http_503');
  });

  it('exposes per-file progress while uploading', async () => {
    const { outbox, transport } = setup();
    await outbox.init();
    const seen: number[] = [];
    outbox.subscribe(() => {
      const i = outbox.snapshot().items[0];
      if (i?.state === 'uploading') seen.push(i.files[0]!.bytes_sent);
    });
    transport.errors = [];
    await outbox.enqueue(item([newFile()]));
    outbox.setOnline(true);
    await flush(outbox);
    expect(seen).toContain(50);
  });

  it('sends text-only messages', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    outbox.setOnline(true);
    await outbox.enqueue(item([], { caption: 'Reached the garage', task_id: null }));
    await flush(outbox);
    expect(server.postCalls[0]!.kind).toBe('text');
    expect(server.postCalls[0]!.items).toHaveLength(0);
  });
});

describe('restart recovery', () => {
  it('reloads the queue from the store and resumes an interrupted upload without re-uploading', async () => {
    const store = new MemoryStore();
    const server = new FakeServer();
    const a = setup({ store, server });
    await a.outbox.init();
    a.outbox.setOnline(true);
    server.postErrors = [new ServerError('transient', 'network')];
    const queued = await a.outbox.enqueue(item([newFile(), newFile()]));
    await flush(a.outbox);
    // simulate a kill mid-upload: the persisted row says uploading
    const row = JSON.parse(store.items.get(queued.client_message_id)!);
    row.state = 'uploading';
    store.items.set(queued.client_message_id, JSON.stringify(row));

    const b = setup({ store, server });
    await b.outbox.init();
    const restored = b.outbox.snapshot().items[0]!;
    expect(restored.state).toBe('queued');
    expect(restored.files.every((f) => f.storage_path !== null)).toBe(true);
    b.outbox.setOnline(true);
    await flush(b.outbox);
    expect(b.transport.puts).toHaveLength(0);
    expect(server.messages.size).toBe(1);
    expect([...server.messages.keys()]).toEqual([queued.client_message_id]);
  });
});

describe('held and late uploads (D43)', () => {
  it('splits a refused multi-file message into one message per file; refused files are held', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    outbox.setOnline(true);
    const late = newFile({ device_captured_at: '2026-11-14T09:59:00.000Z' });
    const ok1 = newFile();
    const ok2 = newFile();
    server.refuseSha.add(late.sha256);
    const parent = await outbox.enqueue(item([ok1, late, ok2], { caption: 'three', category_code: 'vehicle_front' }));
    await flush(outbox);

    const stored = [...server.messages.values()];
    expect(stored).toHaveLength(2);
    expect(stored.every((m) => m.items.length === 1 && m.client_message_id !== parent.client_message_id)).toBe(true);
    expect(stored.every((m) => m.items[0]!.category_code === 'vehicle_front')).toBe(true);
    const items = outbox.snapshot().items;
    const held = items.filter((i) => i.state === 'held');
    expect(held).toHaveLength(1);
    expect(held[0]!.files[0]!.sha256).toBe(late.sha256);
    expect(held[0]!.held_reason).toBe('upload_window_closed');
    expect(held[0]!.split_from).toBe(parent.client_message_id);
    // caption kept once
    expect(held.filter((i) => i.caption === 'three').length + stored.filter((m) => m.body === 'three').length).toBe(1);
  });

  it('holds a single refused file, reports it as pending, and sends it after the office raises a new task', async () => {
    const { outbox, server, transport } = setup();
    await outbox.init();
    outbox.setOnline(true);
    const f = newFile();
    server.presignErrors = [new ServerError('window_closed', 'upload_window_closed')];
    await outbox.enqueue(item([f]));
    await flush(outbox);
    expect(outbox.snapshot().items[0]!.state).toBe('held');
    expect(server.reports.at(-1)).toMatchObject({ device_id: 'dev-1', pending_count: 1, pending_bytes: 1000 });

    await outbox.retryHeld('case-1', 'task-2');
    expect(server.presignCalls.at(-1)!.task_id).toBe('task-2');
    expect(server.postCalls.at(-1)!.task_id).toBe('task-2');
    expect(server.postCalls.at(-1)!.items[0]!.storage_path).toContain('/tasks/task-2/');
    expect(transport.puts).toHaveLength(1);
    expect(outbox.snapshot().items).toHaveLength(0);
    expect(server.reports.at(-1)).toMatchObject({ pending_count: 0, pending_bytes: 0, oldest_pending_at: null });
  });

  it('holds other refusals and keeps going with the next message', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    outbox.setOnline(true);
    server.postErrors = [new ServerError('rejected', '23505')];
    await outbox.enqueue(item([newFile()]));
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    const s = outbox.snapshot().items;
    expect(s.filter((i) => i.state === 'held').map((i) => i.held_reason)).toEqual(['rejected']);
    expect(server.messages.size).toBe(1);
  });

  it('pauses on an auth refusal and emits auth_blocked; nothing is dropped', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    const events: OutboxEvent[] = [];
    outbox.onEvent((e) => events.push(e));
    outbox.setOnline(true);
    server.presignErrors = [new ServerError('auth', 'PGRST301')];
    await outbox.enqueue(item([newFile()]));
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    expect(events).toEqual([{ type: 'auth_blocked' }]);
    expect(outbox.snapshot().paused).toBe(true);
    expect(outbox.snapshot().items.every((i) => i.state === 'queued')).toBe(true);
    expect(server.presignCalls).toHaveLength(1);
  });

  it('drain mode: switches server, holds text-only messages, emits drain_closed', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    const events: OutboxEvent[] = [];
    outbox.onEvent((e) => events.push(e));
    await outbox.enqueue(item([], { caption: 'note', task_id: null }));
    await outbox.enqueue(item([newFile()]));
    await outbox.enqueue(item([newFile()]));
    const drain = new FakeServer();
    drain.postErrors = [undefined, new ServerError('drain_closed', 'drain_window_closed')];
    outbox.useServer(drain, 'drain');
    outbox.setOnline(true);
    await flush(outbox);
    const s = outbox.snapshot();
    expect(s.mode).toBe('drain');
    expect(s.items.find((i) => i.kind === 'text')!.held_reason).toBe('drain_text');
    expect(drain.messages.size).toBe(1);
    expect(server.postCalls).toHaveLength(0);
    expect(events).toEqual([{ type: 'drain_closed' }]);
    expect(await outbox.wipe()).toBe(1); // the unsent file (text has none)
    expect(outbox.snapshot().items).toHaveLength(0);
  });
});

describe('events, ticks and removal', () => {
  it('fires all_sent once when the queue drains after a file waited more than a minute', async () => {
    const clock = new Clock();
    const { outbox } = setup({ clock });
    await outbox.init();
    const events: OutboxEvent[] = [];
    outbox.onEvent((e) => events.push(e));
    await outbox.enqueue(item([newFile(), newFile()]));
    await outbox.enqueue(item([newFile()], { case_id: 'case-2' }));
    clock.advance(5 * 60_000);
    outbox.setOnline(true);
    await flush(outbox);
    await flush(outbox);
    expect(events).toEqual([{ type: 'all_sent', count: 3, case_id: 'case-2' }]);
  });

  it('does not fire all_sent for a file sent within a minute', async () => {
    const { outbox } = setup();
    await outbox.init();
    const events: OutboxEvent[] = [];
    outbox.onEvent((e) => events.push(e));
    outbox.setOnline(true);
    await outbox.enqueue(item([newFile()]));
    await flush(outbox);
    expect(events).toEqual([]);
  });

  it('moves ticks forward only', async () => {
    const { outbox, server } = setup();
    await outbox.init();
    outbox.setOnline(true);
    server.refuseSha.add('x'.repeat(64));
    const held = await outbox.enqueue(item([newFile({ sha256: 'x'.repeat(64) })]));
    const sent = await outbox.enqueue(item([newFile()]));
    await flush(outbox); // one held keeps the stored row in the outbox
    await outbox.markTicks([{ client_message_id: sent.client_message_id, state: 'seen' }]);
    await outbox.markTicks([{ client_message_id: sent.client_message_id, state: 'processed' }]);
    await outbox.markTicks([{ client_message_id: held.client_message_id, state: 'seen' }]);
    const s = outbox.snapshot().items;
    expect(s.find((i) => i.client_message_id === sent.client_message_id)!.state).toBe('seen');
    expect(s.find((i) => i.client_message_id === held.client_message_id)!.state).toBe('held');
  });

  it('removes an unsent file only through removeFile, deleting the sandbox copy', async () => {
    const { outbox, removed } = setup();
    await outbox.init();
    const f = newFile();
    const q = await outbox.enqueue(item([f, newFile()]));
    const fileId = outbox.snapshot().items[0]!.files[0]!.id;
    expect(await outbox.removeFile(q.client_message_id, fileId)).toBe(true);
    expect(removed).toEqual([f.local_path]);
    expect(outbox.snapshot().items[0]!.files).toHaveLength(1);
    const last = outbox.snapshot().items[0]!.files[0]!.id;
    await outbox.removeFile(q.client_message_id, last);
    expect(outbox.snapshot().items).toHaveLength(0);
  });

  it('does not report without a device id, and reports after each send when online', async () => {
    const a = setup({ deviceId: null });
    await a.outbox.init();
    a.outbox.setOnline(true);
    await a.outbox.enqueue(item([newFile()]));
    await flush(a.outbox);
    expect(a.server.reports).toHaveLength(0);

    const b = setup();
    await b.outbox.init();
    await b.outbox.enqueue(item([newFile()]));
    await flush(b.outbox);
    expect(b.server.reports).toHaveLength(0); // offline
    b.outbox.setOnline(true);
    await flush(b.outbox);
    expect(b.server.reports.at(-1)).toMatchObject({ pending_count: 0 });
  });
});
