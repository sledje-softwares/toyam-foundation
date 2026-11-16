// Shrunk copies in the outbox (D51): upload order, backoff, silent drops, drain, late window, cleanup.
import { describe, expect, it } from 'vitest';
import { FakeDerivServer, FakeServer, fakeMakeCopies, item, newFile, setup } from './fakes.test-helpers';
import { ServerError } from './server';
import { MemoryStore } from './store';
import { MAX_COPY_ATTEMPTS } from './types';

const photo = () => newFile();
const pdf = () => newFile({ mime_type: 'application/pdf', ext: 'pdf', evidence_type: 'document' });

/** setup with a signed-in server that takes copies and a log of the calls in order. */
function rig(opts: { fail?: boolean } = {}) {
  const server = new FakeDerivServer();
  const made: string[] = [];
  const s = setup({ server, makeCopies: fakeMakeCopies(made, opts.fail) });
  const order: string[] = [];
  const post = server.postMessage.bind(server);
  server.postMessage = async (m) => {
    order.push('post');
    return post(m);
  };
  const put = s.transport.put.bind(s.transport);
  s.transport.put = async (url, h, p, cb) => {
    order.push(url.includes('/derived/') ? `put copy w${/\/w(\d+)-/.exec(url)![1]}` : 'put original');
    return put(url, h, p, cb);
  };
  const record = server.recordDerivative.bind(server);
  server.recordDerivative = async (r) => {
    order.push(`record w${r.width}`);
    return record(r);
  };
  return { ...s, server, made, order };
}

describe('copies: sending', () => {
  it('uploads the original, posts the message, then presigns / PUTs / records both copies', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    const f = photo();
    await r.outbox.enqueue(item([f]));
    await r.outbox.run();
    expect(r.order).toEqual(['put original', 'post', 'put copy w1600', 'record w1600', 'put copy w384', 'record w384']);
    expect(r.server.derivPresigns).toHaveLength(1); // both copies in one call
    expect(r.server.derivPresigns[0]).toMatchObject({ case_id: 'case-1', task_id: 'task-1', original_sha256: f.sha256 });
    expect(r.server.derivPresigns[0]!.copies.map((c) => c.width)).toEqual([1600, 384]);
    expect(r.server.recorded.map((x) => [x.width, x.pixel_width])).toEqual([[1600, 1600], [384, 384]]);
    expect(r.server.recorded[0]!.storage_path).toMatch(/^derived\/case-1\/[0-9a-f]{64}\/w1600-[0-9a-f]{64}\.jpg$/);
  });

  it('cleans up: copy files deleted, sent row pruned after the copies are done', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    for (const p of r.made) expect(r.removed).toContain(p);
    expect(r.outbox.snapshot().items).toHaveLength(0);
    expect(await r.store.load()).toHaveLength(0);
  });

  it('documents get no copies; a message with a photo and a pdf copies only the photo', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([pdf(), photo()]));
    await r.outbox.run();
    expect(r.made).toHaveLength(2);
    expect(r.server.derivPresigns).toHaveLength(1);
  });

  it('the operator sees nothing of the copies: "sending" covers messages only', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo(), photo()]));
    let sawSendingDuringCopies = false;
    const off = r.outbox.subscribe(() => {
      if (r.server.derivPresigns.length > 0 && r.outbox.snapshot().sending) sawSendingDuringCopies = true;
    });
    await r.outbox.run();
    off();
    expect(sawSendingDuringCopies).toBe(false);
  });

  it('originals first: every original is stored before any copy goes', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo(), photo()]));
    await r.outbox.run();
    const first = r.order.indexOf('post');
    expect(first).toBeGreaterThan(-1);
    expect(r.order.slice(0, first).filter((x) => x === 'put original')).toHaveLength(2);
    expect(r.order.indexOf('put copy w1600')).toBeGreaterThan(first);
  });

  it('copies are made in the background and sending waits for them: the file carries them', async () => {
    const r = rig();
    await r.outbox.init();
    const it = await r.outbox.enqueue(item([photo()]));
    r.outbox.setOnline(true);
    await r.outbox.run();
    expect(it.files[0]!.copies).toBeDefined();
  });

  it('makes no copies without a copy maker (default) and sends as before', async () => {
    const s = setup({ server: new FakeDerivServer() });
    await s.outbox.init();
    s.outbox.setOnline(true);
    await s.outbox.enqueue(item([photo()]));
    await s.outbox.run();
    expect((s.server as FakeDerivServer).derivPresigns).toHaveLength(0);
    expect(s.outbox.snapshot().items).toHaveLength(0);
  });
});

describe('copies: failures are silent', () => {
  it('copies that could not be made leave the message untouched', async () => {
    const r = rig({ fail: true });
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.server.postCalls).toHaveLength(1);
    expect(r.server.derivPresigns).toHaveLength(0);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('a copy refused by the server (rejected) is dropped; the message stays stored, never held', async () => {
    const r = rig();
    r.server.derivPresignErrors = [new ServerError('rejected', 'invalid_input')];
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.server.postCalls).toHaveLength(1);
    expect(r.server.recorded).toHaveLength(0);
    expect(r.outbox.snapshot().items).toHaveLength(0);
    for (const p of r.made) expect(r.removed).toContain(p);
  });

  it('record refused (photo not found / withdrawn): that copy is dropped, no retry loop', async () => {
    const r = rig();
    r.server.recordErrors = [new ServerError('rejected', 'P0002')];
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.server.postCalls).toHaveLength(1);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('skipped / already_stored answers drop the copy without a PUT or a record', async () => {
    const r = rig();
    r.server.statusByWidth = { 1600: 'skipped', 384: 'already_stored' };
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.order).toEqual(['put original', 'post']);
    expect(r.server.recorded).toHaveLength(0);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('a window closed for copies drops them (the message is already stored)', async () => {
    const r = rig();
    r.server.derivPresignErrors = [new ServerError('window_closed', 'upload_window_closed')];
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.server.postCalls).toHaveLength(1);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('transient errors back off like everything else and keep the copy; success later', async () => {
    const r = rig();
    r.server.derivPresignErrors = [new ServerError('transient', 'network')];
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(r.outbox.snapshot().next_retry_at).not.toBeNull();
    expect(r.timers.length).toBe(1); // a wake-up is scheduled for the copies
    expect(r.server.recorded).toHaveLength(0);
    r.clock.advance(31 * 60_000);
    await r.outbox.run();
    expect(r.server.recorded.map((x) => x.width)).toEqual([1600, 384]);
    expect(r.outbox.snapshot().items).toHaveLength(0);
  });

  it('a copy that keeps failing is dropped after the attempt cap', async () => {
    const r = rig();
    r.server.derivPresignErrors = Array.from({ length: MAX_COPY_ATTEMPTS }, () => new ServerError('transient', 'r2_403'));
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    for (let i = 0; i < MAX_COPY_ATTEMPTS + 1; i++) {
      await r.outbox.run();
      r.clock.advance(31 * 60_000);
    }
    expect(r.server.derivPresigns).toHaveLength(MAX_COPY_ATTEMPTS);
    expect(r.server.recorded).toHaveLength(0);
    expect(r.outbox.snapshot().items).toHaveLength(0);
    expect(r.server.postCalls).toHaveLength(1);
  });

  it('a PUT that worked but a record that failed is not uploaded again', async () => {
    const r = rig();
    r.server.recordErrors = [new ServerError('transient', 'network')];
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    r.clock.advance(31 * 60_000);
    await r.outbox.run();
    expect(r.order.filter((x) => x === 'put copy w1600')).toHaveLength(1);
    expect(r.server.recorded.map((x) => x.width)).toEqual([1600, 384]);
  });

  it('an expired session pauses sending like for files (auth_blocked) and keeps the copies', async () => {
    const r = rig();
    r.server.derivPresignErrors = [new ServerError('auth', 'unauthorized')];
    const events: string[] = [];
    r.outbox.onEvent((e) => events.push(e.type));
    await r.outbox.init();
    r.outbox.setOnline(true);
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(events).toContain('auth_blocked');
    expect(r.outbox.snapshot().paused).toBe(true);
    expect(r.outbox.snapshot().items[0]!.files[0]!.copies).toHaveLength(2);
  });
});

describe('copies: drain mode, removal, restart', () => {
  it('drain mode (server without copy calls): copies are skipped and deleted at wipe', async () => {
    const r = rig();
    await r.outbox.init();
    r.outbox.setOnline(true);
    const drain = new FakeServer(); // field-drain has no copy support
    r.outbox.useServer(drain, 'drain');
    await r.outbox.enqueue(item([photo()]));
    await r.outbox.run();
    expect(drain.postCalls).toHaveLength(1);
    expect(r.server.derivPresigns).toHaveLength(0);
    await r.outbox.wipe();
    expect(r.made).toHaveLength(0); // never made in drain mode
  });

  it('copies made before a drain began are skipped, then deleted at wipe', async () => {
    const r = rig();
    await r.outbox.init();
    const it = await r.outbox.enqueue(item([photo()])); // offline: copies get made, nothing sent
    await r.outbox.run();
    r.outbox.setOnline(true);
    const drain = new FakeServer();
    r.outbox.useServer(drain, 'drain');
    await r.outbox.run();
    expect(drain.postCalls).toHaveLength(1);
    expect(r.server.derivPresigns).toHaveLength(0);
    expect(it.files[0]!.copies).toHaveLength(2);
    await r.outbox.wipe();
    for (const p of r.made) expect(r.removed).toContain(p);
  });

  it('removing an unsent file deletes its copies too', async () => {
    const r = rig();
    await r.outbox.init();
    const it = await r.outbox.enqueue(item([photo(), photo()]));
    await r.outbox.run(); // offline: nothing sent
    await new Promise((res) => setTimeout(res, 0));
    const id = it.files[0]!.id;
    await r.outbox.removeFile(it.client_message_id, id);
    expect(r.removed).toContain(`file:///data/outbox/copy-${id}-w1600.jpg`);
    expect(r.removed).toContain(`file:///data/outbox/copy-${id}-w384.jpg`);
  });

  it('a file removed while its copies are being made leaves no copy files behind', async () => {
    const made: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const inner = fakeMakeCopies(made);
    const s = setup({
      server: new FakeDerivServer(),
      makeCopies: async (f) => {
        await gate;
        return inner(f);
      },
    });
    await s.outbox.init();
    const it = await s.outbox.enqueue(item([photo()]));
    await s.outbox.removeFile(it.client_message_id, it.files[0]!.id);
    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(made.length).toBeGreaterThan(0);
    for (const p of made) expect(s.removed).toContain(p);
  });

  it('copies survive a restart: the saved file carries them and they are sent afterwards', async () => {
    const store = new MemoryStore();
    const server = new FakeDerivServer();
    const s1 = setup({ store, server, makeCopies: fakeMakeCopies() });
    await s1.outbox.init();
    s1.outbox.setOnline(true);
    server.derivPresignErrors = [new ServerError('transient', 'network')];
    await s1.outbox.enqueue(item([photo()]));
    await s1.outbox.run();
    const s2 = setup({ store, server, makeCopies: fakeMakeCopies() });
    await s2.outbox.init();
    expect(s2.outbox.snapshot().items[0]!.files[0]!.copies).toHaveLength(2);
    s2.outbox.setOnline(true);
    await s2.outbox.run();
    expect(server.recorded.map((x) => x.width)).toEqual([1600, 384]);
  });

  it('a queued photo saved without copies (app closed early) gets them after a restart', async () => {
    const store = new MemoryStore();
    const s1 = setup({ store, server: new FakeDerivServer() }); // no copy maker: saved with copies undefined
    await s1.outbox.init();
    await s1.outbox.enqueue(item([photo()]));
    const server = new FakeDerivServer();
    const s2 = setup({ store, server, makeCopies: fakeMakeCopies() });
    await s2.outbox.init();
    s2.outbox.setOnline(true);
    await s2.outbox.run();
    expect(server.recorded.map((x) => x.width)).toEqual([1600, 384]);
  });
});
