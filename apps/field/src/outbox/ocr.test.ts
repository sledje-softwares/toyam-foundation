// Device OCR in the outbox (gap 35): read after the copies, sent after the original and its copies,
// never in post_thread_message, idempotent retries, silent drops, drain, restart, split.
import { describe, expect, it } from 'vitest';
import { FakeOcrServer, fakeMakeCopies, fakeOcr, item, newFile, setup } from './fakes.test-helpers';
import { ServerError } from './server';
import { MemoryStore } from './store';
import { MAX_COPY_ATTEMPTS, type OutboxFile, type OutboxItem, type OutboxOcr } from './types';

const photo = () => newFile();
const video = () => newFile({ mime_type: 'video/mp4', ext: 'mp4', evidence_type: 'video' });

function rig(opts: { read?: (f: OutboxFile, it: OutboxItem) => Promise<OutboxOcr | null>; store?: MemoryStore } = {}) {
  const server = new FakeOcrServer();
  const made: string[] = [];
  const reads: { path: string | undefined; category: string | null }[] = [];
  const read = opts.read ?? (async (f: OutboxFile, it: OutboxItem) => {
    reads.push({ path: f.copies?.find((c) => c.width === 1600)?.local_path, category: it.category_code });
    return fakeOcr();
  });
  const s = setup({ server, makeCopies: fakeMakeCopies(made), readOcr: read, ...(opts.store ? { store: opts.store } : {}) });
  const order: string[] = [];
  const post = server.postMessage.bind(server);
  server.postMessage = async (m) => {
    order.push('post');
    return post(m);
  };
  const record = server.recordDerivative.bind(server);
  server.recordDerivative = async (r) => {
    order.push(`record w${r.width}`);
    return record(r);
  };
  const ocr = server.recordOcr.bind(server);
  server.recordOcr = async (r) => {
    order.push('ocr');
    return ocr(r);
  };
  return { ...s, server, made, reads, order };
}

describe('device OCR: making and sending', () => {
  it('reads the 1600 px copy and records the text after the original and both copies', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    const f = photo();
    await r.outbox.enqueue(item([f], { category_code: 'rc' }));
    await r.outbox.whenIdle();
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]!.path).toMatch(/-w1600\.jpg$/);
    expect(r.reads[0]!.category).toBe('rc');
    expect(r.order).toEqual(['post', 'record w1600', 'record w384', 'ocr']);
    expect(r.server.ocrs[0]).toMatchObject({ case_id: 'case-1', original_sha256: f.sha256, source_width: 1600, text: 'MH 12 AB 3456' });
  });

  it('never sends OCR inside post_thread_message', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    for (const m of r.server.postCalls) for (const i of m.items) expect(i).not.toHaveProperty('ocr');
  });

  it('the message is not kept waiting for OCR; the 1600 px copy is kept until it is read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ read: async () => (await gate, fakeOcr()) });
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.order).toEqual(['post']); // stored ✓ while OCR still runs; copies wait for it
    expect(r.removed.some((p) => p.endsWith('-w1600.jpg'))).toBe(false);
    release();
    await r.outbox.whenIdle();
    expect(r.order).toEqual(['post', 'record w1600', 'record w384', 'ocr']);
    expect(r.outbox.snapshot().items).toHaveLength(0); // pruned once everything is sent
  });

  it('videos and documents are not read; a failed read sends nothing and blocks nothing', async () => {
    const r = rig({ read: async () => { throw new Error('ML Kit failed'); } });
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([video(), photo()]));
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(0);
    expect(r.server.recorded).toHaveLength(2);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('a photo without a 1600 px copy is not read', async () => {
    const server = new FakeOcrServer();
    let reads = 0;
    const s = setup({ server, makeCopies: async () => [], readOcr: async () => (reads++, fakeOcr()) });
    await s.outbox.init();
    s.outbox.setOnline(true);
    await s.outbox.enqueue(item([photo()]));
    await s.outbox.whenIdle();
    expect(reads).toBe(0);
    expect(server.ocrs).toHaveLength(0);
  });

  it('read offline, sent when back online', async () => {
    const r = rig();
    await r.outbox.init();
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    expect(r.reads).toHaveLength(1);
    expect(r.server.ocrs).toHaveLength(0);
    r.outbox.setOnline(true);
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(1);
  });
});

describe('device OCR: errors', () => {
  it('a refusal drops the OCR silently (the file stays sent)', async () => {
    const r = rig();
    r.server.ocrErrors.push(new ServerError('rejected', '42501'));
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(0);
    expect(r.outbox.snapshot().items).toHaveLength(0);
    expect(r.outbox.snapshot().next_retry_at).toBeNull();
  });

  it('transient errors back off and retry with the same payload; dropped after MAX_COPY_ATTEMPTS', async () => {
    const r = rig();
    r.server.ocrErrors.push(new ServerError('transient', 'network'));
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(0);
    expect(r.outbox.snapshot().next_retry_at).not.toBeNull();
    expect(r.outbox.snapshot().items).toHaveLength(1); // kept (invisible) until the text is sent
    r.clock.advance(60 * 60 * 1000);
    await r.outbox.run();
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(1);

    const w = rig();
    for (let i = 0; i < MAX_COPY_ATTEMPTS; i++) w.server.ocrErrors.push(new ServerError('transient', 'network'));
    await w.outbox.init();
    w.outbox.setOnline(true);
    await w.outbox.enqueue(item([photo()]));
    for (let i = 0; i < MAX_COPY_ATTEMPTS + 1; i++) {
      w.clock.advance(60 * 60 * 1000);
      await w.outbox.run();
      await w.outbox.whenIdle();
    }
    expect(w.server.ocrs).toHaveLength(0);
    expect(w.outbox.snapshot().items).toHaveLength(0);
  });

  it('an expired session pauses like for files', async () => {
    const r = rig();
    r.server.ocrErrors.push(new ServerError('auth', 'PGRST301'));
    const events: string[] = [];
    r.outbox.onEvent((e) => events.push(e.type));
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    expect(r.outbox.snapshot().paused).toBe(true);
    expect(events).toContain('auth_blocked');
  });
});

describe('device OCR: restart, drain, split, removal', () => {
  it('after a restart a stored photo whose 1600 px copy was not read yet is read then', async () => {
    const store = new MemoryStore();
    const first = rig({ store, read: () => new Promise(() => {}) }); // app killed while reading
    await first.outbox.init();
    await first.outbox.enqueue(item([photo()]));
    await new Promise((res) => setTimeout(res, 0));
    const saved = (await store.load())[0]!;
    expect(saved.files[0]!.copies).toHaveLength(2);
    expect(saved.files[0]!.ocr).toBeUndefined();

    const again = rig({ store });
    await again.outbox.init();
    again.outbox.setOnline(true);
    await again.outbox.whenIdle();
    expect(again.reads).toHaveLength(1);
    expect(again.server.ocrs).toHaveLength(1);
  });

  it('a recorded result is persisted, so a restart does not read again', async () => {
    const store = new MemoryStore();
    const first = rig({ store });
    await first.outbox.init();
    await first.outbox.enqueue(item([photo()]));
    await first.outbox.whenIdle();
    expect((await store.load())[0]!.files[0]!.ocr).toMatchObject({ text: 'MH 12 AB 3456' });
    const again = rig({ store });
    await again.outbox.init();
    again.outbox.setOnline(true);
    await again.outbox.whenIdle();
    expect(again.reads).toHaveLength(0);
    expect(again.server.ocrs).toHaveLength(1);
  });

  it('drain mode (remote sign-out) neither reads nor sends OCR', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.useServer(r.server, 'drain');
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    expect(r.reads).toHaveLength(0);
    expect(r.server.ocrs).toHaveLength(0);
  });

  it('the result finds its file after a late-upload split', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ read: async () => (await gate, fakeOcr()) });
    const a = photo();
    const b = photo();
    r.server.refuseSha.add(b.sha256);
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([a, b]));
    await r.outbox.run();
    release();
    await r.outbox.whenIdle();
    expect(r.server.ocrs.map((o) => o.original_sha256)).toEqual([a.sha256]); // b is held: not stored, no OCR sent
  });

  it('a removed file is not read and its result is discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ read: async () => (await gate, fakeOcr()) });
    await r.outbox.init();
    const it0 = await r.outbox.enqueue(item([photo(), photo()]));
    await new Promise((res) => setTimeout(res, 0));
    await r.outbox.removeFile(it0.client_message_id, it0.files[0]!.id);
    release();
    await r.outbox.whenIdle();
    const left = r.outbox.snapshot().items[0]!;
    expect(left.files).toHaveLength(1);
    expect(left.files[0]!.ocr).toMatchObject({ text: 'MH 12 AB 3456' });
  });

  it('wipe discards pending OCR', async () => {
    const r = rig();
    await r.outbox.init();
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.whenIdle();
    await r.outbox.wipe();
    r.outbox.setOnline(true);
    await r.outbox.whenIdle();
    expect(r.server.ocrs).toHaveLength(0);
  });
});
