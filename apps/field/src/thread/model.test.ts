import { describe, expect, it } from 'vitest';
import type { Msg } from '../cache/caseCache';
import { CaseCache } from '../cache/caseCache';
import { MemoryCacheStore } from '../cache/store';
import type { OutboxFile, OutboxItem } from '../outbox/types';
import { clockSheetView } from '../ui-logic/offline';
import { threadOutboxLabel } from '../ui-logic/threadMenu';
import {
  applyLocalReads, chipLabel, confirmDelivery, confirmedIds, deliveryItems, DELIVERED_KEEP_MS, emptyDelivery, fileKind, gridLayout,
  LABEL, mergeThread, newlyStored, outboxFileStates, pendingStatus, readMark, restoreDelivery, rowFallbackText, rowMeta, serverTick,
  stableOrder, STATUS, trackDelivery, type MergeInput, type ServerFile,
} from './model';

const NOW = new Date('2026-11-19T12:00:00Z');
const ME = 'u-me';
const file = (id: string, over: Partial<OutboxFile> = {}): OutboxFile => ({
  id, local_path: `file:///outbox/${id}.jpg`, sha256: `sha-${id}`, size_bytes: 1000, mime_type: 'image/jpeg', ext: 'jpg',
  evidence_type: 'photo', device_captured_at: '2026-11-19T11:00:00Z', gps: null, capture_source: 'gallery',
  original_filename: `${id}.jpg`, checklist_item_id: null, storage_path: null, bytes_sent: 0, ...over,
});
const item = (id: string, over: Partial<OutboxItem> = {}, files: OutboxFile[] = [file(`${id}f`)]): OutboxItem => ({
  client_message_id: id, case_id: 'c1', task_id: 't1', kind: 'media', caption: null, category_code: null, reply_to: null, files,
  state: 'queued', created_at: '2026-11-19T11:50:00Z', attempts: 0, last_attempt_at: null, last_error: null, held_reason: null,
  message_id: null, stored_at: null, split_from: null, ...over,
});
const msg = (id: string, over: Partial<Msg> = {}): Msg => ({
  id, kind: 'text', body: id, sender_id: 'office', created_at: '2026-11-19T10:00:00Z', withdrawn_at: null, client_message_id: null, ...over,
});
const sfile = (id: string, messageId: string, over: Partial<ServerFile> = {}): ServerFile => ({
  id, message_id: messageId, evidence_type: 'photo', mime_type: 'image/jpeg', size_bytes: 1000, original_filename: `${id}.jpg`,
  sha256: `sha-${id}`, copies: [384, 1600], processing: 'pending', ...over,
});
const base = (over: Partial<MergeInput> = {}): MergeInput => ({
  server: [], files: [], outbox: [], me: ME, staffLastReadAt: null, send: { online: true, paused: false, next_retry_at: null }, now: NOW, ...over,
});

describe('gridLayout', () => {
  it('columns by count', () => {
    expect(gridLayout(0)).toEqual({ columns: 0, shown: [], more: 0 });
    expect(gridLayout(1).columns).toBe(1);
    expect(gridLayout(2).columns).toBe(2);
    expect(gridLayout(3).columns).toBe(3);
    expect(gridLayout(4).columns).toBe(2);
    expect(gridLayout(5).columns).toBe(3);
    expect(gridLayout(6)).toEqual({ columns: 3, shown: [0, 1, 2, 3, 4, 5], more: 0 });
  });
  it('more than 6: six tiles, "+N" counts the covered tile', () => {
    expect(gridLayout(7)).toEqual({ columns: 3, shown: [0, 1, 2, 3, 4, 5], more: 2 });
    expect(gridLayout(31).more).toBe(26);
  });
});

describe('file kinds and labels', () => {
  it('kind from evidence type, then mime', () => {
    expect(fileKind('photo', null)).toBe('image');
    expect(fileKind('document', 'application/pdf')).toBe('document');
    expect(fileKind('document', 'image/png')).toBe('image');
    expect(fileKind('video', 'video/mp4')).toBe('video');
    expect(fileKind('audio', null)).toBe('audio');
  });
  it('chip label with size', () => {
    expect(chipLabel({ name: 'bill.pdf', sizeBytes: 1_258_291 })).toBe('bill.pdf · 1.2 MB');
    expect(chipLabel({ name: 'Document', sizeBytes: null })).toBe('Document');
  });
});

describe('per-file states while on the phone', () => {
  it('uploading: sent, sending with progress, waiting', () => {
    const it0 = item('a', { state: 'uploading' }, [
      file('1', { storage_path: 'cases/x/1.jpg' }), file('2', { bytes_sent: 250 }), file('3'),
    ]);
    expect(outboxFileStates(it0)).toEqual([
      { state: 'sent', progress: null }, { state: 'sending', progress: 0.25 }, { state: 'waiting', progress: null },
    ]);
  });
  it('queued: all waiting (already uploaded ones stay sent); held; stored', () => {
    expect(outboxFileStates(item('a', {}, [file('1', { storage_path: 'p' }), file('2')])).map((x) => x.state)).toEqual(['sent', 'waiting']);
    expect(outboxFileStates(item('a', { state: 'held' })).map((x) => x.state)).toEqual(['held']);
    expect(outboxFileStates(item('a', { state: 'stored' })).map((x) => x.state)).toEqual(['sent']);
  });
});

describe('status line (gap 30)', () => {
  const ctx = { online: true, paused: false, next_retry_at: null };
  it('offline', () => expect(pendingStatus(item('a'), { ...ctx, online: false }, NOW)).toBe(STATUS.offline));
  it('refused upload with the next try', () => {
    expect(pendingStatus(item('a', { last_error: 'transient:r2_403' }), { ...ctx, next_retry_at: '2026-11-19T12:04:30Z' }, NOW))
      .toBe('Upload refused — will retry · next try in 5 min');
  });
  it('no connection to the server', () => {
    expect(pendingStatus(item('a', { last_error: 'transient:network' }), ctx, NOW)).toBe(STATUS.noServer);
  });
  it('held for the office, sign-in, sending, waiting', () => {
    expect(pendingStatus(item('a', { state: 'held', held_reason: 'upload_window_closed' }), ctx, NOW)).toBe('Waiting for the office — they can see these files');
    expect(pendingStatus(item('a'), { ...ctx, paused: true }, NOW)).toBe(STATUS.session);
    expect(pendingStatus(item('a', { state: 'uploading' }), ctx, NOW)).toBeNull(); // the label says "Sending k of n"
    expect(pendingStatus(item('a'), ctx, NOW)).toBeNull(); // saved, about to go: nothing is wrong
    expect(pendingStatus(item('a'), { ...ctx, next_retry_at: '2026-11-19T12:00:20Z' }, NOW)).toBe('Waiting to send · next try within a minute');
  });
  it('none once stored; never says failed', () => {
    expect(pendingStatus(item('a', { state: 'stored', message_id: 'm' }), ctx, NOW)).toBeNull();
    for (const e of ['transient:r2_500', 'transient:http_502', 'rejected:x', 'auth:401']) {
      expect((pendingStatus(item('a', { last_error: e }), ctx, NOW) ?? '').toLowerCase()).not.toContain('fail');
    }
  });
  it('the 🕓 sheet shows the reason, but not twice for held items', () => {
    expect(clockSheetView(item('a'), NOW, STATUS.offline).reason).toBe(STATUS.offline);
    expect(clockSheetView(item('a', { state: 'held' }), NOW, 'Waiting for the office — they can see these files').reason).toBeNull();
  });
  it('the thread menu always lists the Outbox', () => {
    expect(threadOutboxLabel([])).toBe('Outbox');
    expect(threadOutboxLabel([item('a', {}, [file('1'), file('2')])])).toBe('Outbox (2)');
  });
});

describe('ticks (gap 7)', () => {
  it('stored, processed when every file is done, seen when the office read after it', () => {
    expect(serverTick('2026-11-19T10:00:00Z', [], null)).toBe('stored');
    expect(serverTick('2026-11-19T10:00:00Z', [{ processing: 'done' }, { processing: 'pending' }], null)).toBe('stored');
    expect(serverTick('2026-11-19T10:00:00Z', [{ processing: 'done' }, { processing: 'done' }], null)).toBe('processed');
    expect(serverTick('2026-11-19T10:00:00.5+00:00', [], '2026-11-19T10:00:01+00:00')).toBe('seen');
    expect(serverTick('2026-11-19T10:00:01.25+00:00', [], '2026-11-19T10:00:01+00:00')).toBe('stored');
  });
  it('meta line: count from 2 files, blue only when seen', () => {
    expect(rowMeta({ fileCount: 12, tick: 'processed', label: 'Processed' })).toEqual({ count: '12 files', label: 'Processed', tick: '✓✓', blue: false });
    expect(rowMeta({ fileCount: 1, tick: 'seen' })).toEqual({ count: null, label: null, tick: '✓✓', blue: true });
    expect(rowMeta({ fileCount: 0, tick: 'clock' }).tick).toBe('🕓');
    expect(rowMeta({ fileCount: 0, tick: null }).tick).toBeNull();
  });
});

describe('mergeThread', () => {
  it('server messages with their files, oldest first; pending items after them', () => {
    const rows = mergeThread(base({
      server: [
        msg('m2', { created_at: '2026-11-19T11:00:00Z', sender_id: ME, kind: 'media', body: 'Garage', client_message_id: 'cm2' }),
        msg('m1', { created_at: '2026-11-19T09:00:00Z' }),
      ],
      files: [sfile('e1', 'm2', { processing: 'done' }), sfile('e2', 'm2', { evidence_type: 'document', mime_type: 'application/pdf', processing: 'done' })],
      outbox: [item('p1', { created_at: '2026-11-19T08:00:00Z' })],
    }));
    expect(rows.map((r) => r.key)).toEqual(['m1', 'cm2', 'p1']);
    const own = rows[1]!;
    expect(own).toMatchObject({ mine: true, text: 'Garage', fileCount: 2, tick: 'processed', pending: false, status: null });
    expect(own.images.map((f) => f.evidenceId)).toEqual(['e1']);
    expect(own.others.map((f) => f.kind)).toEqual(['document']);
    expect(rows[0]).toMatchObject({ mine: false, tick: null });
    expect(rows[2]).toMatchObject({ mine: true, tick: 'clock', pending: true, status: null, label: 'Saved on this phone', retry: false });
  });

  it('an outbox item and its server message are one row with the same key and file keys (no flicker)', () => {
    const it0 = item('cm', { state: 'stored', message_id: 'm9', caption: 'Front' }, [file('x', { copies: [] })]);
    const before = mergeThread(base({ outbox: [it0] }));
    const after = mergeThread(base({
      outbox: [it0],
      server: [msg('m9', { sender_id: ME, kind: 'media', body: 'Front', client_message_id: 'cm', created_at: '2026-11-19T11:51:00Z' })],
      files: [sfile('ev', 'm9', { sha256: 'sha-x' })],
    }));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(before[0]!.key);
    expect(after[0]!.images[0]!.key).toBe(before[0]!.images[0]!.key);
    expect(after[0]!.images[0]!.evidenceId).toBe('ev');
    expect(before[0]!.tick).toBe('stored');
  });

  it('the phone keeps its local copies as sources on the server row while they exist', () => {
    const f = file('x', { copies: [{ width: 384, local_path: 'file:///outbox/copy-x-w384.jpg', sha256: 'c', size_bytes: 1, pixel_width: 384, pixel_height: 288, storage_path: null, attempts: 0 }] });
    const rows = mergeThread(base({
      outbox: [item('cm', { state: 'stored', message_id: 'm9' }, [f])],
      server: [msg('m9', { sender_id: ME, kind: 'media', client_message_id: 'cm' })],
      files: [sfile('ev', 'm9', { sha256: 'sha-x' })],
    }));
    expect(rows[0]!.images[0]!.local).toEqual({ original: null, w384: 'file:///outbox/copy-x-w384.jpg', w1600: null });
  });

  it('pending items show local files with per-file state; originals only while pending', () => {
    const rows = mergeThread(base({ outbox: [item('a', { state: 'uploading' }, [file('1', { bytes_sent: 500 })])] }));
    expect(rows[0]!.images[0]).toMatchObject({ state: 'sending', progress: 0.5, local: { original: 'file:///outbox/1.jpg' } });
    const stored = mergeThread(base({ outbox: [item('a', { state: 'stored', message_id: 'm' })] }));
    expect(stored[0]!.images[0]!.local?.original).toBeNull();
    expect(stored[0]!.pending).toBe(false);
  });

  it('withdrawn messages show no files; system messages no ticks; ticks never go back', () => {
    const rows = mergeThread(base({
      server: [
        msg('m1', { sender_id: ME, kind: 'media', withdrawn_at: '2026-11-19T10:05:00Z', body: null }),
        msg('m2', { sender_id: null, kind: 'system', body: 'Field work assigned' }),
        msg('m3', { sender_id: ME, client_message_id: 'c3' }),
      ],
      files: [sfile('e1', 'm1')],
      outbox: [item('c3', { state: 'seen', message_id: 'm3', kind: 'text', files: [] })],
    }));
    expect(rows[0]).toMatchObject({ withdrawn: true, fileCount: 0, tick: null, text: null });
    expect(rowFallbackText(rows[0]!)).toBe('Message withdrawn');
    expect(rows[1]!.tick).toBeNull();
    expect(rows[2]!.tick).toBe('seen');
  });

  it('server row without fetched files falls back to the phone list as sent', () => {
    const rows = mergeThread(base({
      outbox: [item('cm', { state: 'stored', message_id: 'm9' }, [file('1'), file('2')])],
      server: [msg('m9', { sender_id: ME, kind: 'media', client_message_id: 'cm' })],
    }));
    expect(rows[0]!.fileCount).toBe(2);
    expect(rows[0]!.images.every((f) => f.state === 'sent')).toBe(true);
  });
});

describe('delivered items stay until fetched (gap 6)', () => {
  it('a stored item dropped by the outbox stays until the server copy arrives', () => {
    const a = item('a', { state: 'stored', message_id: 'm1' });
    let d = trackDelivery(emptyDelivery(), [a], new Set());
    d = trackDelivery(d, [], new Set()); // pruned by the outbox, not fetched yet
    expect(deliveryItems(d).map((i) => i.client_message_id)).toEqual(['a']);
    expect(mergeThread(base({ outbox: deliveryItems(d) }))).toHaveLength(1);
    d = trackDelivery(d, [], new Set(['a'])); // fetched
    expect(deliveryItems(d)).toEqual([]);
  });
  it('items removed while pending, or replaced by the late-upload split, are not kept', () => {
    const removed = item('r');
    const parent = item('p', { state: 'uploading' });
    let d = trackDelivery(emptyDelivery(), [removed, parent], new Set());
    d = trackDelivery(d, [item('child', { split_from: 'p' })], new Set());
    expect(deliveryItems(d).map((i) => i.client_message_id)).toEqual(['child']);
  });
  it('trackDelivery is idempotent for the same input', () => {
    const d1 = trackDelivery(trackDelivery(emptyDelivery(), [item('a', { message_id: 'm', state: 'stored' })], new Set()), [], new Set());
    const d2 = trackDelivery(d1, [], new Set());
    expect([...d2.delivered.keys()]).toEqual([...d1.delivered.keys()]);
  });
  it('newlyStored fires once when an item gets its message id', () => {
    const a = item('a');
    const d = trackDelivery(emptyDelivery(), [a], new Set());
    expect(newlyStored(d, [a])).toBe(false);
    const stored = { ...a, state: 'stored' as const, message_id: 'm1' };
    expect(newlyStored(d, [stored])).toBe(true);
    expect(newlyStored(trackDelivery(d, [stored], new Set()), [stored])).toBe(false);
  });
});

describe('unread (gap 9)', () => {
  const row = (id: string, last: string | null, unread: number) => ({ case_id: id, last_message_at: last, unread_count: unread });
  it('a thread read on this phone shows no badge for what was on screen', () => {
    const rows = [row('c1', '2026-11-19T10:00:00+00:00', 3), row('c2', '2026-11-19T11:00:00+00:00', 2), row('c3', null, 1)];
    const got = applyLocalReads(rows, { c1: '2026-11-19T10:00:00.000Z', c2: '2026-11-19T10:30:00Z', c3: '2026-11-19T09:00:00Z' });
    expect(got.map((r) => r.unread_count)).toEqual([0, 2, 0]);
  });
  it('no local read: the server count stands', () => {
    expect(applyLocalReads([row('c1', '2026-11-19T10:00:00Z', 4)], {})[0]!.unread_count).toBe(4);
  });
  it('read mark = newest message shown', () => {
    expect(readMark([msg('a', { created_at: '2026-11-19T10:00:00.5+00:00' }), msg('b', { created_at: '2026-11-19T10:00:00.25+00:00' })]))
      .toBe('2026-11-19T10:00:00.5+00:00');
    expect(readMark([])).toBeNull();
  });
  it('the cache keeps the newest read per case, across instances', async () => {
    const store = new MemoryCacheStore();
    const c = new CaseCache(store);
    await c.markRead('c1', '2026-11-19T10:00:00Z');
    await c.markRead('c1', '2026-11-19T09:00:00Z');
    await c.markRead('c2', '2026-11-19T08:00:00Z');
    expect(await new CaseCache(store).getReads()).toEqual({ c1: '2026-11-19T10:00:00Z', c2: '2026-11-19T08:00:00Z' });
  });
  it('thread files are cached only for the cached messages', async () => {
    const c = new CaseCache(new MemoryCacheStore());
    await c.putFiles('c1', { files: [sfile('e1', 'm1'), sfile('e2', 'gone')], staff_last_read_at: null }, [{ id: 'm1' }]);
    expect((await c.getFiles('c1'))!.data.files.map((f) => f.id)).toEqual(['e1']);
  });
});

// ---------------------------------------------------------------- 2026-11-19 user feedback:
// one bubble from "Saved on this phone" to "Processed ✓✓", never disappearing or jumping

describe('one bubble through the whole send', () => {
  const caseFiles = (m: string, processing: ServerFile['processing']) => [sfile('ea', m, { sha256: 'sha-1', processing }), sfile('eb', m, { sha256: 'sha-2', processing })];
  const server = (over: Partial<Msg> = {}) => msg('m1', { sender_id: ME, kind: 'media', body: 'Garage', client_message_id: 'c1', created_at: '2026-11-19T11:55:00Z', ...over });

  it('saved → sending 2 of 2 → sent → processed → seen: same key, same tiles, label changes in place', () => {
    const files = [file('1'), file('2')];
    const saved = item('c1', { caption: 'Garage' }, files);
    const steps: Partial<MergeInput>[] = [
      { outbox: [saved] },
      { outbox: [{ ...saved, state: 'uploading', files: [{ ...files[0]!, storage_path: 'p1' }, { ...files[1]!, bytes_sent: 400 }] }] },
      { outbox: [{ ...saved, state: 'stored', message_id: 'm1' }] },
      { outbox: [{ ...saved, state: 'stored', message_id: 'm1' }], server: [server()], files: caseFiles('m1', 'pending') },
      { outbox: [], server: [server()], files: caseFiles('m1', 'pending') },
      { server: [server()], files: caseFiles('m1', 'done') },
      { server: [server()], files: caseFiles('m1', 'done'), staffLastReadAt: '2026-11-19T11:59:00Z' },
    ];
    const rows = steps.map((st) => mergeThread(base(st)));
    for (const r of rows) {
      expect(r).toHaveLength(1);
      expect(r[0]!.key).toBe('c1');
      expect(r[0]!.images.map((f) => f.key)).toEqual(['sha-1', 'sha-2']);
    }
    expect(rows.map((r) => r[0]!.label)).toEqual([
      LABEL.saved, 'Sending 2 of 2 files', LABEL.sent, LABEL.sent, LABEL.sent, LABEL.processed, LABEL.seen,
    ]);
    expect(rows[1]![0]!.images.map((f) => f.state)).toEqual(['sent', 'sending']);
    expect(rows.map((r) => r[0]!.tick)).toEqual(['clock', 'clock', 'stored', 'stored', 'stored', 'processed', 'seen']);
  });

  it('stuck items say why and offer Retry (online only)', () => {
    const stuck = item('c1', { last_error: 'transient:r2_403' });
    expect(mergeThread(base({ outbox: [stuck] }))[0]).toMatchObject({ status: STATUS.refused, retry: true, label: LABEL.saved });
    expect(mergeThread(base({ outbox: [stuck], send: { online: false, paused: false, next_retry_at: null } }))[0])
      .toMatchObject({ status: STATUS.offline, retry: false });
    expect(mergeThread(base({ outbox: [item('c2', { state: 'held', held_reason: 'upload_window_closed' })] }))[0])
      .toMatchObject({ label: LABEL.held, retry: true });
  });

  it('a file the case already held: shown with its earlier thumbnail, marked, row not confirmed', () => {
    const it0 = item('c1', { state: 'stored', message_id: 'm1' }, [file('1'), file('old')]);
    const rows = mergeThread(base({
      outbox: [it0],
      server: [msg('m0', { created_at: '2026-11-19T09:00:00Z', sender_id: ME, kind: 'media' }), server()],
      files: [sfile('e-old', 'm0', { sha256: 'sha-old' }), sfile('e1', 'm1', { sha256: 'sha-1' })],
    }));
    const r = rows[1]!;
    expect(r.images.map((f) => [f.key, f.evidenceId, f.state])).toEqual([['sha-1', 'e1', null], ['sha-old', 'e-old', 'duplicate']]);
    expect(r.hasDuplicates).toBe(true);
    expect(confirmedIds(rows)).toEqual([]); // m0 has no client id; c1 waits (keeps the duplicate mark)
  });

  it('a message whose every file was already on the case is never an empty bubble', () => {
    const only = mergeThread(base({ server: [server()], files: [] }))[0]!;
    expect(only.fileCount).toBe(0);
    expect(rowFallbackText(only)).toBe('Files already sent earlier');
    const known = mergeThread(base({
      outbox: [item('c1', { state: 'stored', message_id: 'm1' }, [file('old')])],
      server: [msg('m0', { created_at: '2026-11-19T09:00:00Z' }), server()],
      files: [sfile('e-old', 'm0', { sha256: 'sha-old' })],
    }))[1]!;
    expect(known.images[0]).toMatchObject({ state: 'duplicate', evidenceId: 'e-old' });
  });

  it('dedupes: the outbox item and its server message present together give one row, then it is confirmed', () => {
    const rows = mergeThread(base({ outbox: [item('c1', { state: 'stored', message_id: 'm1' }, [file('1'), file('2')])], server: [server()], files: caseFiles('m1', 'pending') }));
    expect(rows.filter((r) => r.clientMessageId === 'c1')).toHaveLength(1);
    expect(confirmedIds(rows)).toEqual(['c1']);
  });
});

describe('app-wide delivery (leaving the thread, restarts)', () => {
  const stored = item('c1', { state: 'stored', message_id: 'm1', stored_at: '2026-11-19T11:55:00Z' });
  it('kept after the outbox drops it until a thread confirms; then gone for good', () => {
    let d = trackDelivery(emptyDelivery(), [stored], new Set(), NOW);
    d = trackDelivery(d, [], new Set(), NOW);
    expect(deliveryItems(d, 'c1').map((i) => i.client_message_id)).toEqual(['c1']);
    expect(deliveryItems(d, 'other')).toEqual([]);
    d = confirmDelivery(d, ['c1']);
    expect(deliveryItems(d)).toEqual([]);
    expect(confirmDelivery(d, ['c1'])).toBe(d); // nothing to do: same object (no re-render)
  });
  it('confirmed while still in the outbox: not kept when it is pruned later', () => {
    let d = trackDelivery(emptyDelivery(), [stored], new Set(), NOW);
    d = confirmDelivery(d, ['c1']);
    d = trackDelivery(d, [], new Set(), NOW);
    expect(deliveryItems(d)).toEqual([]);
    expect(d.confirmed.size).toBe(0);
  });
  it('restored from the phone after a restart; live outbox items win; old ones expire', () => {
    let d = trackDelivery(emptyDelivery(), [item('live')], new Set(), NOW);
    d = restoreDelivery(d, [stored, item('live', { state: 'stored', message_id: 'x' })]);
    expect([...d.delivered.keys()]).toEqual(['c1']);
    const later = new Date(NOW.getTime() + DELIVERED_KEEP_MS + 60_000);
    expect(deliveryItems(trackDelivery(d, [], new Set(), later), 'c1')).toEqual([]);
  });
  it('restart while sending: an item cut off mid-upload is back to "Saved", uploaded files stay sent', () => {
    const r = mergeThread(base({ outbox: [item('c1', { state: 'queued', attempts: 1 }, [file('1', { storage_path: 'p' }), file('2')])] }))[0]!;
    expect(r.label).toBe(LABEL.saved);
    expect(r.images.map((f) => f.state)).toEqual(['sent', 'waiting']);
  });
  it('the read cache keeps delivered items across instances', async () => {
    const store = new MemoryCacheStore();
    await new CaseCache(store).putDelivered([stored]);
    expect((await new CaseCache(store).getDelivered()).map((i) => i.client_message_id)).toEqual(['c1']);
  });
});

describe('stableOrder (no jumps)', () => {
  const k = (...keys: string[]) => keys.map((key) => ({ key }));
  it('first render: natural order', () => expect(stableOrder([], k('a', 'b', 'c'))).toEqual(['a', 'b', 'c']));
  it('a delivered row keeps its place even if the natural order moves it', () => {
    // shown: s1, then an older held item and c1; c1 is delivered and its server copy sorts above the held one
    expect(stableOrder(['s1', 'p-held', 'c1'], k('s1', 'c1', 'p-held'))).toEqual(['s1', 'p-held', 'c1']);
  });
  it('new rows go after the nearest earlier row; removed rows drop out; stable when applied again', () => {
    const once = stableOrder(['s1', 'c1'], k('s1', 'o2', 'c1', 'n3'));
    expect(once).toEqual(['s1', 'o2', 'c1', 'n3']);
    expect(stableOrder(once, k('s1', 'o2', 'c1', 'n3'))).toEqual(once);
    expect(stableOrder(['s1', 'gone', 'c1'], k('s1', 'c1'))).toEqual(['s1', 'c1']);
    expect(stableOrder(['s1'], k('s0', 's1'))).toEqual(['s0', 's1']);
  });
});
