import { describe, expect, it } from 'vitest';
import type { OutboxFile, OutboxItem } from '../outbox';
import {
  allSentContent, barView, checklistView, clockSheetView, drainView, freshnessView, outboxMenuLabel, outboxView,
  promptView, signOutView, storageView,
} from './offline';

const NOW = new Date('2026-11-14T12:00:00Z');
const MB = 1024 * 1024;
const file = (id: string, extra: Partial<OutboxFile> = {}): OutboxFile => ({
  id, local_path: `file:///x/${id}`, sha256: id, size_bytes: MB, mime_type: 'image/jpeg', ext: 'jpg', evidence_type: 'photo',
  device_captured_at: '2026-11-14T10:00:00Z', gps: null, capture_source: 'camera', original_filename: `${id}.jpg`,
  checklist_item_id: null, storage_path: null, bytes_sent: 0, ...extra,
});
const item = (id: string, over: Partial<OutboxItem> = {}, files: OutboxFile[] = [file(id + 'f')]): OutboxItem => ({
  client_message_id: id, case_id: 'c1', task_id: 't', kind: 'media', caption: null, category_code: null, reply_to: null, files,
  state: 'queued', created_at: '2026-11-14T10:00:00Z', attempts: 0, last_attempt_at: null, last_error: null, held_reason: null,
  message_id: null, stored_at: null, split_from: null, ...over,
});

describe('1 offline bar', () => {
  it('offline with files, amber', () => {
    expect(barView({ online: false, items: [item('a', {}, [file('1'), file('2')])], sending: null }))
      .toEqual({ visible: true, text: 'Offline · 2 files saved on this phone', tone: 'amber' });
  });
  it('offline, nothing waiting', () => {
    expect(barView({ online: false, items: [], sending: null }).text).toBe('Offline · you can keep working');
  });
  it('sending is neutral, then hidden', () => {
    expect(barView({ online: true, items: [item('a')], sending: { k: 3, n: 12 } })).toEqual({ visible: true, text: 'Sending 3 of 12…', tone: 'neutral' });
    expect(barView({ online: true, items: [], sending: null }).visible).toBe(false);
  });
});

describe('2 clock sheet', () => {
  it('never tried', () => {
    const v = clockSheetView(item('a'), NOW);
    expect(v).toMatchObject({ title: 'Saved on this phone', lastTry: 'Waiting for signal', primary: 'Send now', secondary: 'Open Outbox' });
    expect(v.body).toContain('nothing will be lost');
  });
  it('last try time; held wording has no blame', () => {
    const v = clockSheetView(item('a', { state: 'held', last_attempt_at: '2026-11-14T11:55:00Z' }), NOW);
    expect(v.lastTry).toBe('Last try: 5 min ago');
    expect(v.body).toBe('Waiting for the office — they can see these files');
  });
});

describe('3 outbox screen', () => {
  const names = { c1: { case_ref: 'TIV-1', title: 'R. Sharma' } };
  it('card with progress', () => {
    const items = [item('a', { state: 'stored' }), item('b', { last_attempt_at: '2026-11-14T11:00:00Z' }, [file('1'), file('2')])];
    const v = outboxView(items, names, NOW);
    expect(v.summary).toBe('2 files · 2.0 MB saved on this phone');
    expect(v.cards[0]).toMatchObject({ title: 'TIV-1 · R. Sharma', progressText: '1 of 3 files sent', showProgress: true, lastTry: 'Last try: 1 h ago', sendNowLabel: 'Send now' });
    expect(v.cards[0]?.files).toHaveLength(2);
    expect(v.remove).toMatchObject({ action: 'Remove from phone', cancel: 'Keep', confirm: 'Remove' });
    expect(outboxMenuLabel(items)).toBe('Outbox (2)');
  });
  it('held items show the spec wording instead of progress', () => {
    const v = outboxView([item('a', { state: 'held' })], names, NOW);
    expect(v.cards[0]).toMatchObject({ heldText: 'Waiting for the office — they can see these files', progressText: null, showProgress: false });
  });
  it('empty state, menu hidden', () => {
    const v = outboxView([], {}, NOW);
    expect(v).toMatchObject({ empty: true, summary: 'Everything is sent ✓' });
    expect(outboxMenuLabel([])).toBeNull();
  });
});

describe('4 freshness', () => {
  it('labels and tones', () => {
    expect(freshnessView('2026-11-14T11:59:30Z', NOW)).toEqual({ text: 'Updated just now', tone: 'grey' });
    expect(freshnessView('2026-11-14T11:40:00Z', NOW).text).toBe('Updated 20 min ago');
    expect(freshnessView('2026-11-14T09:00:00Z', NOW).text).toBe('Updated 3 h ago');
    expect(freshnessView('2026-11-11T09:00:00Z', NOW)).toEqual({ text: 'Updated 3 days ago', tone: 'amber' });
    expect(freshnessView(null, NOW).text).toBe('Not downloaded yet — open this case once with signal');
  });
});

describe('5 hollow ticks', () => {
  const rows = [
    { checklist_item_id: 'i1', description: 'Front photo', category_code: 'vehicle_photo', status: 'pending', evidence_count: 0 },
    { checklist_item_id: 'i2', description: 'RC copy', category_code: 'rc', status: 'captured', evidence_count: 1 },
    { checklist_item_id: 'i3', description: 'Statement', category_code: null, status: 'pending', evidence_count: 0 },
  ];
  const q = [item('a', { category_code: 'vehicle_photo' })];
  it('online: Sending…', () => {
    const v = checklistView(rows, q, true, '2026-11-14T11:00:00Z', NOW);
    expect(v.rows.map((r) => [r.state, r.mark, r.caption])).toEqual([['pending', '○✓', 'Sending…'], ['done', '✓', null], ['todo', '○', null]]);
    expect(v.freshness.text).toBe('Updated 1 h ago');
  });
  it('offline: Saved on phone, and picked item', () => {
    const q2 = [item('b', {}, [file('1', { checklist_item_id: 'i3' })])];
    const v = checklistView(rows, q2, false, null, NOW);
    expect(v.rows[2]).toMatchObject({ state: 'pending', caption: 'Saved on phone' });
    expect(v.freshness.text).toContain('Not downloaded yet');
  });
});

describe('6 all sent', () => {
  it('text', () => expect(allSentContent(12)).toEqual({ title: 'All 12 files sent ✓', body: 'The office has them now.' }));
});

describe('7 gentle prompt', () => {
  const snap = { last_success_at: null, last_prompt_at: null };
  it('after 6 h', () => {
    const p = promptView([item('a', { created_at: '2026-11-14T05:00:00Z' }, [file('1'), file('2')])], NOW, snap);
    expect(p).toMatchObject({ title: '2 files are still on this phone', button: 'Send now' });
    expect(p!.body).toContain('tap to send');
    expect(JSON.stringify(p).toLowerCase()).not.toMatch(/fail|error/);
  });
  it('not before 6 h or when empty', () => {
    expect(promptView([item('a', { created_at: '2026-11-14T09:00:00Z' })], NOW, snap)).toBeNull();
    expect(promptView([], NOW, snap)).toBeNull();
  });
});

describe('8 low storage', () => {
  const q = [item('a', {}, [file('1'), file('2'), file('3')])];
  it('ok', () => expect(storageView(5000 * MB, q)).toEqual({ banner: null, cameraDialog: null }));
  it('warn under 500 MB', () => {
    const v = storageView(400 * MB, q);
    expect(v.banner).toBe('Phone storage is almost full. Your 3 saved files are safe — connect to send them and free space.');
    expect(v.cameraDialog).toBeNull();
  });
  it('block under 200 MB', () => {
    const v = storageView(100 * MB, q);
    expect(v.cameraDialog).toEqual({ body: 'Not enough space for more photos. Send saved files first, or free space on the phone.', primary: 'Open Outbox', secondary: 'OK' });
  });
  it('unknown free space shows nothing', () => expect(storageView(null, q).banner).toBeNull());
});

describe('9 sign-out', () => {
  it('blocked', () => {
    expect(signOutView([item('a', {}, [file('1'), file('2')])])).toEqual({
      allowed: false, title: '2 files are not sent yet',
      body: 'Signing out would delete them from this phone. Connect to the internet and wait for them to send.',
      openOutbox: 'Open Outbox', stay: 'Stay signed in',
    });
  });
  it('allowed when empty', () => expect(signOutView([])).toEqual({ allowed: true }));
});

describe('10 drain', () => {
  it('progress while sending', () => {
    const v = drainView([item('a', { state: 'stored' }), item('b', {}, [file('1'), file('2')])], 3, 'draining');
    expect(v).toMatchObject({ title: 'Your access has been removed', progress: '1 of 3 sent', done: false });
    expect(v.body).toBe('Sending the 3 files you took before that. Keep the app open or connected — this finishes by itself.');
  });
  it('done with all sent (rows already dropped)', () => {
    const v = drainView([], 4, 'draining');
    expect(v).toMatchObject({ progress: '4 of 4 sent', done: true, doneText: 'All files sent. This phone is now signed out.' });
  });
  it('some refused', () => {
    const v = drainView([item('a', { state: 'held' }, [file('1'), file('2')])], 5, 'draining');
    expect(v).toMatchObject({ done: true, sent: 3, discarded: 2, doneText: '3 files were sent. 2 could not be sent and have been removed.' });
  });
  it('closed window finishes immediately', () => {
    expect(drainView([], 0, 'done', 0).done).toBe(true);
  });
});
