import { describe, expect, it } from 'vitest';
import {
  allSentEvent, allSentNotification, canSignOut, drainDoneText, drainProgress, emptyBatch, formatBytes, freshness,
  gentlePromptText, HELD_TEXT, lastTryLine, lowStorage, needsGentlePrompt, offlineBar, outboxHeader, outboxSummary,
  outboxTotals, pendingTicks,
} from './selectors';
import type { ItemState, OutboxFile, OutboxItem } from './types';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const MB = 1024 * 1024;
let n = 0;
const file = (over: Partial<OutboxFile> = {}): OutboxFile => ({
  id: `f${++n}`, local_path: `file:///o/${n}`, sha256: 'a'.repeat(64), size_bytes: MB, mime_type: 'image/jpeg', ext: 'jpg',
  evidence_type: 'photo', device_captured_at: '2026-11-14T08:00:00.000Z', gps: null, capture_source: 'gallery',
  original_filename: null, checklist_item_id: null, storage_path: null, bytes_sent: 0, ...over,
});
const msg = (state: ItemState, files: OutboxFile[], over: Partial<OutboxItem> = {}): OutboxItem => ({
  client_message_id: `m${++n}`, case_id: 'c1', task_id: 't1', kind: files.length ? 'media' : 'text', caption: null,
  category_code: null, reply_to: null, files, state, created_at: '2026-11-14T09:00:00.000Z', attempts: 0,
  last_attempt_at: null, last_error: null, held_reason: null, message_id: null, stored_at: null, split_from: null, ...over,
});

describe('totals and bar (spec 1)', () => {
  it('counts only files still on the phone', () => {
    const items = [msg('queued', [file(), file()]), msg('held', [file()]), msg('stored', [file()]), msg('uploading', [file()])];
    expect(outboxTotals(items)).toMatchObject({ items: 3, files: 4, bytes: 4 * MB, held_files: 1 });
  });
  it('offline bar texts', () => {
    expect(offlineBar({ online: false, items: [], sending: null })).toEqual({
      kind: 'offline', count: 0, bytes: 0, text: 'Offline · you can keep working',
    });
    const b = offlineBar({ online: false, items: [msg('queued', [file(), file(), file()])], sending: null });
    expect(b).toMatchObject({ kind: 'offline', count: 3, bytes: 3 * MB, text: 'Offline · 3 files saved on this phone' });
    expect(offlineBar({ online: true, items: [], sending: { k: 2, n: 5 } })).toEqual({ kind: 'sending', k: 2, n: 5, text: 'Sending 2 of 5…' });
    expect(offlineBar({ online: true, items: [msg('queued', [file()])], sending: null })).toEqual({ kind: 'hidden' });
  });
});

describe('🕓 sheet (spec 2)', () => {
  it('last try line', () => {
    expect(lastTryLine(null, NOW)).toBe('Waiting for signal');
    expect(lastTryLine('2026-11-14T11:55:00.000Z', NOW)).toBe('Last try: 5 min ago');
  });
});

describe('outbox screen (spec 3)', () => {
  it('summarises per case with k of n, bytes, last attempt and held text', () => {
    const items = [
      msg('stored', [file(), file()], { case_id: 'c1' }),
      msg('uploading', [file()], { case_id: 'c1', last_attempt_at: '2026-11-14T11:59:00.000Z' }),
      msg('queued', [file()], { case_id: 'c1', last_attempt_at: '2026-11-14T11:00:00.000Z' }),
      msg('held', [file()], { case_id: 'c2', created_at: '2026-11-14T08:00:00.000Z' }),
      msg('stored', [file()], { case_id: 'c3' }),
    ];
    const s = outboxSummary(items);
    expect(s.map((x) => x.case_id)).toEqual(['c2', 'c1']);
    const c1 = s[1]!;
    expect(c1).toMatchObject({
      total_files: 4, sent_files: 2, pending_files: 2, pending_bytes: 2 * MB, sending: true,
      last_attempt_at: '2026-11-14T11:59:00.000Z', progress: 0.5, progress_text: '2 of 4 files sent', held_text: null,
    });
    expect(s[0]!.held_text).toBe(HELD_TEXT);
  });
  it('header, menu label and empty state', () => {
    expect(outboxHeader([])).toEqual({ empty: true, text: 'Everything is sent ✓', menu_label: null });
    expect(outboxHeader([msg('queued', [file(), file({ size_bytes: 512 * 1024 })])])).toEqual({
      empty: false, text: '2 files · 1.5 MB saved on this phone', menu_label: 'Outbox (2)',
    });
    expect(formatBytes(800)).toBe('800 B');
    expect(formatBytes(3 * 1024 * MB)).toBe('3.0 GB');
  });
});

describe('freshness (spec 4)', () => {
  it('labels and staleness', () => {
    expect(freshness(null, NOW)).toEqual({ text: 'Not downloaded yet — open this case once with signal', stale: true });
    expect(freshness('2026-11-14T11:59:30.000Z', NOW)).toEqual({ text: 'Updated just now', stale: false });
    expect(freshness('2026-11-14T11:48:00.000Z', NOW)).toEqual({ text: 'Updated 12 min ago', stale: false });
    expect(freshness('2026-11-14T10:00:00.000Z', NOW)).toEqual({ text: 'Updated 2 h ago', stale: false });
    expect(freshness('2026-11-11T10:00:00.000Z', NOW)).toEqual({ text: 'Updated 3 days ago', stale: true });
    expect(freshness('2026-11-13T11:00:00.000Z', NOW).stale).toBe(true);
  });
});

describe('pending ticks (spec 5)', () => {
  const checklist = [
    { id: 'i1', category_code: 'vehicle_front', ticked: false },
    { id: 'i2', category_code: 'rc_book', ticked: false },
    { id: 'i3', category_code: 'vehicle_front', ticked: true },
    { id: 'i4', category_code: null, ticked: false },
  ];
  it('hollow ticks from the category chip or the picked item, never for ticked or sent ones', () => {
    const items = [
      msg('queued', [file()], { category_code: 'vehicle_front' }),
      msg('held', [file({ checklist_item_id: 'i4' })]),
      msg('stored', [file()], { category_code: 'rc_book' }),
    ];
    expect(pendingTicks(checklist, items, true)).toEqual([
      { checklist_item_id: 'i1', caption: 'Sending…' },
      { checklist_item_id: 'i4', caption: 'Sending…' },
    ]);
    expect(pendingTicks(checklist, items, false)[0]!.caption).toBe('Saved on phone');
    expect(pendingTicks(checklist, [], true)).toEqual([]);
  });
});

describe('all sent (spec 6)', () => {
  it('fires only when empty, something was sent, and a file waited ≥ 1 min', () => {
    const b = { sent: 4, oldest_queued_at: '2026-11-14T11:58:00.000Z', last_case_id: 'c9' };
    expect(allSentEvent(b, 0, NOW)).toEqual({ count: 4, case_id: 'c9' });
    expect(allSentEvent(b, 1, NOW)).toBeNull();
    expect(allSentEvent(emptyBatch(), 0, NOW)).toBeNull();
    expect(allSentEvent({ ...b, oldest_queued_at: '2026-11-14T11:59:30.000Z' }, 0, NOW)).toBeNull();
    expect(allSentNotification(4)).toEqual({ title: 'All 4 files sent ✓', body: 'The office has them now.' });
  });
});

describe('gentle prompt (spec 7)', () => {
  it('true after 6 h waiting, once per stretch', () => {
    expect(needsGentlePrompt(null, NOW)).toBe(false);
    expect(needsGentlePrompt('2026-11-14T06:30:00.000Z', NOW)).toBe(false);
    expect(needsGentlePrompt('2026-11-14T06:00:00.000Z', NOW)).toBe(true);
    expect(needsGentlePrompt('2026-11-14T01:00:00.000Z', NOW, { lastSuccessAt: '2026-11-14T08:00:00.000Z' })).toBe(false);
    expect(needsGentlePrompt('2026-11-14T01:00:00.000Z', NOW, { lastPromptAt: '2026-11-14T07:00:00.000Z' })).toBe(false);
    expect(needsGentlePrompt('2026-11-14T01:00:00.000Z', NOW, { lastPromptAt: '2026-11-14T05:59:00.000Z' })).toBe(true);
    const t = gentlePromptText(12);
    expect(t.title).toBe('12 files are still on this phone');
    expect(`${t.title} ${t.body}`).not.toMatch(/fail|error/i);
  });
});

describe('low storage (spec 8)', () => {
  it('ok, warn and block thresholds', () => {
    expect(lowStorage(2000 * MB, 100 * MB, 3)).toEqual({ level: 'ok' });
    expect(lowStorage(400 * MB, 0, 3)).toMatchObject({ level: 'warn' });
    expect(lowStorage(600 * MB, 450 * MB, 3)).toMatchObject({ level: 'warn' });
    const b = lowStorage(150 * MB, 0, 7);
    expect(b.level).toBe('block');
    if (b.level === 'block') {
      expect(b.banner).toBe('Phone storage is almost full. Your 7 saved files are safe — connect to send them and free space.');
      expect(b.dialog.primary).toBe('Open Outbox');
    }
  });
});

describe('sign-out (spec 9)', () => {
  it('blocked with count while anything waits', () => {
    expect(canSignOut([msg('stored', [file()])])).toEqual({ allowed: true });
    const c = canSignOut([msg('queued', [file(), file()]), msg('held', [file()])]);
    expect(c).toMatchObject({ allowed: false, count: 3, title: '3 files are not sent yet', buttons: ['Open Outbox', 'Stay signed in'] });
    expect(canSignOut([msg('queued', [])])).toMatchObject({ allowed: false, count: 1 });
  });
});

describe('drain (spec 10)', () => {
  it('progress and done text', () => {
    const items = [msg('stored', [file(), file()]), msg('held', [file()]), msg('queued', [file()])];
    expect(drainProgress(items)).toEqual({ sent: 2, total: 4, refused: 1, done: false, text: '2 of 4 sent' });
    expect(drainProgress(items.slice(0, 2)).done).toBe(true);
    expect(drainDoneText(5, 0)).toBe('All files sent. This phone is now signed out.');
    expect(drainDoneText(5, 2)).toBe('5 files were sent. 2 could not be sent and have been removed.');
  });
});
