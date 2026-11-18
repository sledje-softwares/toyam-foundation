// "Mark task done" in the thread menu (pure text and decisions). The call itself is
// complete_field_task(p_task_id) and needs a connection: it is never queued in the outbox, so the
// operator always knows whether the office has it.
import type { ChecklistRow } from './offline';

export interface OpenTaskRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
}

export interface TaskDoneMenuItem {
  taskId: string;
  label: string;
}

const isOpen = (t: OpenTaskRow) => t.status === 'pending' || t.status === 'in_progress';

/**
 * One entry per open task of this operator on the case (oldest first); none when nothing is open. While the tasks
 * are not loaded yet (null) and the phone is offline, one entry with an empty task id is shown so that tapping it
 * explains that a connection is needed.
 */
export function taskDoneMenuItems(tasks: readonly OpenTaskRow[] | null | undefined, online = true): TaskDoneMenuItem[] {
  if (tasks == null && !online) return [{ taskId: '', label: 'Mark task done' }];
  const open = (tasks ?? []).filter(isOpen).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const only = open.length === 1 ? open[0] : undefined;
  if (only) return [{ taskId: only.id, label: 'Mark task done' }];
  return open.map((t) => ({ taskId: t.id, label: `Mark done: ${t.title}` }));
}

export const OFFLINE_TITLE = 'Needs a connection';
export const OFFLINE_TEXT =
  'Marking the task done needs an internet connection, so the office knows at once. Your photos stay saved on this phone. Try again when you are online.';

export interface TaskDoneConfirm {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}

/**
 * Confirmation before the call. Files still on the phone are not lost: files captured before the task is marked done
 * are accepted for the late-upload window (D43), so the text says so instead of blocking.
 */
export function taskDoneConfirm(
  task: { title: string },
  ctx: { waitingFiles: number; checklist?: readonly ChecklistRow[] | null; graceHours?: number },
): TaskDoneConfirm {
  const lines = [`The office will see that "${task.title}" is finished. You cannot add photos to it afterwards.`];
  const rows = ctx.checklist ?? [];
  if (rows.length > 0) {
    const done = rows.filter((r) => r.status !== 'pending' || r.evidence_count > 0).length;
    if (done < rows.length) lines.push(`Checklist: ${done} of ${rows.length} items ticked.`);
  }
  if (ctx.waitingFiles > 0) {
    const n = ctx.waitingFiles;
    lines.push(
      `${n} ${n === 1 ? 'file is' : 'files are'} still saved on this phone. ${n === 1 ? 'It' : 'They'} will still be sent (within ${ctx.graceHours ?? 72} h); keep the app signed in.`,
    );
  }
  return { title: 'Mark task done?', body: lines.join('\n\n'), confirm: 'Mark done', cancel: 'Not yet' };
}

export interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
}

export type TaskDoneOutcome =
  | { kind: 'done'; title: string; text: string }
  | { kind: 'error'; title: string; text: string };

/**
 * What to tell the operator after the call. A lost answer followed by a retry comes back as "already completed":
 * that is shown as done. Network failures say that nothing changed.
 */
export function taskDoneOutcome(error: RpcErrorLike | null, remainingOpen: number): TaskDoneOutcome {
  const msg = error?.message ?? '';
  if (!error || /is completed and can no longer be changed/i.test(msg)) {
    return {
      kind: 'done',
      title: 'Task marked done',
      text: remainingOpen > 0
        ? `${remainingOpen} more ${remainingOpen === 1 ? 'task is' : 'tasks are'} open on this case.`
        : 'This case is now under Completed.',
    };
  }
  if (!error.code || /network|fetch|timed? ?out|abort/i.test(msg)) {
    return { kind: 'error', title: 'Not sent', text: 'Could not reach the office. Nothing was changed. Try again when you have a good connection.' };
  }
  if (error.code === '42501' || error.code === '22023' || error.code === 'P0002') {
    // messages written by complete_field_task for people (e.g. "This case is no longer open for field work. Ask the office.")
    return { kind: 'error', title: 'Not marked done', text: /cancelled/i.test(msg) ? 'This task was cancelled by the office.' : msg || 'Ask the office.' };
  }
  return { kind: 'error', title: 'Not marked done', text: 'Something went wrong. Try again in a moment.' };
}
