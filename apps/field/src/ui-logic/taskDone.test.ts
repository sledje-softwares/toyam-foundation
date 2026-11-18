import { describe, expect, it } from 'vitest';
import type { ChecklistRow } from './offline';
import { OFFLINE_TEXT, taskDoneConfirm, taskDoneMenuItems, taskDoneOutcome, type OpenTaskRow } from './taskDone';

const task = (id: string, over: Partial<OpenTaskRow> = {}): OpenTaskRow => ({
  id, title: `Task ${id}`, status: 'pending', created_at: `2026-11-1${id}T10:00:00Z`, ...over,
});
const row = (status: string, evidence_count = 0): ChecklistRow => ({
  checklist_item_id: Math.random().toString(36), description: 'x', status, evidence_count, category_code: null,
});

describe('menu items', () => {
  it('none when nothing is open', () => {
    expect(taskDoneMenuItems(null)).toEqual([]);
    expect(taskDoneMenuItems([task('1', { status: 'completed' }), task('2', { status: 'cancelled' })])).toEqual([]);
  });
  it('not loaded yet: offline shows one entry (explains the connection), online shows none', () => {
    expect(taskDoneMenuItems(null, false)).toEqual([{ taskId: '', label: 'Mark task done' }]);
    expect(taskDoneMenuItems(null, true)).toEqual([]);
    expect(taskDoneMenuItems([], false)).toEqual([]);
  });
  it('one open task: plain label', () => {
    expect(taskDoneMenuItems([task('1', { status: 'in_progress' }), task('2', { status: 'completed' })]))
      .toEqual([{ taskId: '1', label: 'Mark task done' }]);
  });
  it('several open tasks: one entry each, oldest first, named', () => {
    expect(taskDoneMenuItems([task('3'), task('1', { status: 'in_progress' })])).toEqual([
      { taskId: '1', label: 'Mark done: Task 1' },
      { taskId: '3', label: 'Mark done: Task 3' },
    ]);
  });
});

describe('confirmation', () => {
  it('plain when nothing is waiting and the checklist is complete', () => {
    const c = taskDoneConfirm({ title: 'Garage visit' }, { waitingFiles: 0, checklist: [row('captured'), row('pending', 2)] });
    expect(c).toMatchObject({ title: 'Mark task done?', confirm: 'Mark done', cancel: 'Not yet' });
    expect(c.body).toContain('"Garage visit"');
    expect(c.body).not.toContain('Checklist');
    expect(c.body).not.toContain('saved on this phone');
  });
  it('mentions unticked checklist items without blocking', () => {
    expect(taskDoneConfirm({ title: 'T' }, { waitingFiles: 0, checklist: [row('captured'), row('pending'), row('pending')] }).body)
      .toContain('Checklist: 1 of 3 items ticked.');
  });
  it('files still on the phone will still be sent (late-upload window)', () => {
    expect(taskDoneConfirm({ title: 'T' }, { waitingFiles: 1 }).body).toContain('1 file is still saved on this phone. It will still be sent (within 72 h)');
    expect(taskDoneConfirm({ title: 'T' }, { waitingFiles: 4, graceHours: 48 }).body).toContain('4 files are still saved on this phone. They will still be sent (within 48 h)');
  });
});

describe('outcome', () => {
  it('done, with what is left on the case', () => {
    expect(taskDoneOutcome(null, 0)).toEqual({ kind: 'done', title: 'Task marked done', text: 'This case is now under Completed.' });
    expect(taskDoneOutcome(null, 1).text).toBe('1 more task is open on this case.');
    expect(taskDoneOutcome(null, 2).text).toBe('2 more tasks are open on this case.');
  });
  it('a retry after a lost answer counts as done', () => {
    expect(taskDoneOutcome({ code: '22023', message: 'This task is completed and can no longer be changed' }, 0).kind).toBe('done');
  });
  it('network failure: nothing changed', () => {
    const o = taskDoneOutcome({ code: '', message: 'TypeError: Network request failed' }, 0);
    expect(o.kind).toBe('error');
    expect(o.text).toContain('Nothing was changed');
  });
  it('database refusals show their message; cancelled tasks are named', () => {
    expect(taskDoneOutcome({ code: '22023', message: 'This case is no longer open for field work. Ask the office.' }, 0).text)
      .toBe('This case is no longer open for field work. Ask the office.');
    expect(taskDoneOutcome({ code: '22023', message: 'This task is cancelled and can no longer be changed' }, 0).text)
      .toBe('This task was cancelled by the office.');
    expect(taskDoneOutcome({ code: '42501', message: 'You can mark only your own field work complete' }, 0).text)
      .toBe('You can mark only your own field work complete');
  });
  it('anything else is generic', () => {
    expect(taskDoneOutcome({ code: '500', message: 'internal' }, 0).text).toBe('Something went wrong. Try again in a moment.');
  });
  it('offline text never promises a queue', () => {
    expect(OFFLINE_TEXT).toContain('needs an internet connection');
  });
});
