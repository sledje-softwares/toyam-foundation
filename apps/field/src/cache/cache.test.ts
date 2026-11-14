import { describe, expect, it } from 'vitest';
import { freshness } from '../outbox';
import { checklistMenuLabel, sendingNotificationText } from '../ui-logic/threadMenu';
import { CaseCache, type CaseHeader, type Msg } from './caseCache';
import { newTasksForHeld, trimMessages } from './logic';
import { MemoryCacheStore } from './store';

const hdr: CaseHeader = {
  case_ref: 'INV-1', title: 'A', insurer_name: 'X', policy_no: 'P1', incident_date: null, suspicion_summary: null,
  parties: [], intake_values: [],
};
const msg = (i: number): Msg => ({ id: `m${i}`, kind: 'text', body: `b${i}`, sender_id: null, created_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`, withdrawn_at: null });

describe('CaseCache', () => {
  it('keeps data and synced_at across a new instance on the same store (restart)', async () => {
    const store = new MemoryCacheStore();
    const at = await new CaseCache(store, () => '2026-11-14T10:00:00.000Z').putHeader('c1', hdr);
    const again = new CaseCache(store);
    const got = await again.getHeader('c1');
    expect(got).toEqual({ data: hdr, synced_at: at });
    expect(await again.getHeader('c2')).toBeNull();
  });

  it('feeds the freshness label from the stored synced_at, and "not downloaded" only when empty', async () => {
    const cache = new CaseCache(new MemoryCacheStore(), () => '2026-11-14T08:00:00.000Z');
    const now = new Date('2026-11-14T10:00:00.000Z');
    expect(freshness((await cache.syncedAt()).c1, now).text).toMatch(/Not downloaded yet/);
    await cache.putHeader('c1', hdr);
    await cache.putChecklist('c1', []);
    const map = await cache.syncedAt();
    expect(freshness(map.c1, now).text).toBe('Updated 2 h ago');
    expect(freshness(map['checklist:c1'], now).stale).toBe(false);
  });

  it('stores only the newest 200 messages, oldest first', async () => {
    const cache = new CaseCache(new MemoryCacheStore());
    const many = Array.from({ length: 250 }, (_, i) => ({ ...msg(0), id: `m${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    await cache.putMessages('c1', many);
    const got = (await cache.getMessages('c1'))!.data;
    expect(got).toHaveLength(200);
    expect(got[0]!.id).toBe('m50');
    expect(got[199]!.id).toBe('m249');
  });

  it('clear() removes everything', async () => {
    const cache = new CaseCache(new MemoryCacheStore());
    await cache.putHeader('c1', hdr);
    await cache.putKnownTasks(['t1']);
    await cache.clear();
    expect(await cache.getHeader('c1')).toBeNull();
    expect(await cache.getKnownTasks()).toBeNull();
    expect(await cache.syncedAt()).toEqual({});
  });
});

describe('trimMessages', () => {
  it('sorts and limits', () => {
    expect(trimMessages([msg(3), msg(1), msg(2)], 2).map((m) => m.id)).toEqual(['m2', 'm3']);
  });
});

describe('newTasksForHeld', () => {
  const open = [
    { task_id: 't1', case_id: 'c1', created_at: '2026-01-01' },
    { task_id: 't2', case_id: 'c1', created_at: '2026-02-01' },
    { task_id: 't3', case_id: 'c2', created_at: '2026-02-01' },
  ];
  it('returns the newest new task for cases with held files only', () => {
    expect(newTasksForHeld(open, new Set(), new Set(['c1']))).toEqual([{ caseId: 'c1', taskId: 't2' }]);
  });
  it('is once per task: known tasks are skipped', () => {
    expect(newTasksForHeld(open, new Set(['t1', 't2']), new Set(['c1']))).toEqual([]);
    expect(newTasksForHeld(open, new Set(['t1']), new Set(['c1']))).toEqual([{ caseId: 'c1', taskId: 't2' }]);
  });
  it('treats everything as new when nothing was stored', () => {
    expect(newTasksForHeld(open, null, new Set(['c1', 'c2'])).map((r) => r.taskId).sort()).toEqual(['t2', 't3']);
  });
  it('does nothing without held files', () => {
    expect(newTasksForHeld(open, null, new Set())).toEqual([]);
  });
});

describe('thread menu and progress text', () => {
  const row = (status: string, n = 0) => ({ checklist_item_id: 'x', description: 'd', category_code: null, status, evidence_count: n });
  it('menu label counts ticked items', () => {
    expect(checklistMenuLabel(null)).toBe('Checklist');
    expect(checklistMenuLabel([])).toBe('Checklist');
    expect(checklistMenuLabel([row('pending'), row('pending', 2), row('done')])).toBe('Checklist (2/3)');
  });
  it('progress text', () => {
    expect(sendingNotificationText(null)).toBeNull();
    expect(sendingNotificationText({ k: 3, n: 12 })).toBe('Sending 3 of 12 files');
    expect(sendingNotificationText({ k: 1, n: 1 })).toBe('Sending 1 of 1 file');
  });
});
