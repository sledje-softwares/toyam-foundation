/**
 * Task detail actions (docs/12-office-pages/tasks.md): mark complete, cancel, reassign operator, edit.
 * Pure: who may act, and the form -> RPC argument mapping for
 *   public.complete_field_task(p_task_id, p_note)
 *   public.cancel_field_task(p_task_id, p_reason)
 *   public.reassign_field_task(p_task_id, p_assignee_id, p_reason)
 *   public.update_field_task(p_task_id, p_title, p_instructions, p_due_at, p_location_text)
 * The database re-checks everything (D44 ownership, open task, active field operator, lengths).
 */
import type { Enums } from "@/lib/database.types";
import { isGuid, isOpen } from "./tasks";
import { INSTRUCTIONS_MAX, LOCATION_MAX, parseIstDateTime, REQUEST_MIN, TITLE_MAX, TITLE_MIN, toIstInput } from "./tasks-form";

type UserRole = Enums<"user_role">;

export const ACTION_REASON_MIN = 3;
export const ACTION_REASON_MAX = 500;
const MAX_DUE_DAYS = 366;

export type TaskActionResult = { error: string | null; fieldErrors: Record<string, string>; message?: string };
export const ACTION_IDLE: TaskActionResult = { error: null, fieldErrors: {} };

/** D44: orchestrator / admin act on every case, office staff on the cases they own; only open tasks change. */
export function canManageTask(p: { role: UserRole; userId: string; caseOwnerId: string | null; taskStatus: string }): boolean {
  if (!isOpen(p.taskStatus)) return false;
  if (p.role === "admin" || p.role === "orchestrator") return true;
  return p.role === "office" && p.caseOwnerId !== null && p.caseOwnerId === p.userId;
}

/**
 * Case statuses on which an open task may be edited or move to another operator (the database refuses submitted,
 * closed and cancelled cases, D46). Cancelling stays possible.
 */
export function canReassignOnCase(caseStatus: string): boolean {
  return caseStatus !== "submitted" && caseStatus !== "closed" && caseStatus !== "cancelled";
}

/**
 * Case statuses on which an open task may be marked complete. The database refuses submitted, closed and cancelled
 * cases (left-over work on a submitted case is cancelled, D46).
 */
export function canCompleteOnCase(caseStatus: string): boolean {
  return canReassignOnCase(caseStatus);
}

export const COMPLETE_NOTE_MAX = 1000;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

type Parsed<T> = { errors: Record<string, string>; input: T | null };

function reasonError(reason: string): string | null {
  if (reason.length < ACTION_REASON_MIN || reason.length > ACTION_REASON_MAX)
    return `Give a reason of ${ACTION_REASON_MIN} to ${ACTION_REASON_MAX} characters.`;
  return null;
}

export type CancelInput = { p_task_id: string; p_reason: string };

export function parseCancelForm(fd: FormData): Parsed<CancelInput> {
  const task = str(fd, "task_id");
  const reason = str(fd, "reason");
  const errors: Record<string, string> = {};
  if (!isGuid(task)) errors.task_id = "Reload the page and try again.";
  const r = reasonError(reason);
  if (r) errors.reason = r;
  return Object.keys(errors).length ? { errors, input: null } : { errors, input: { p_task_id: task, p_reason: reason } };
}

export type CompleteInput = { p_task_id: string; p_note?: string };

/** The note is optional; blank is left out. Staff notes are staff-only in the thread (D32). */
export function parseCompleteForm(fd: FormData): Parsed<CompleteInput> {
  const task = str(fd, "task_id");
  const note = str(fd, "note");
  const errors: Record<string, string> = {};
  if (!isGuid(task)) errors.task_id = "Reload the page and try again.";
  if (note.length > COMPLETE_NOTE_MAX) errors.note = `Keep the note under ${COMPLETE_NOTE_MAX} characters.`;
  return Object.keys(errors).length
    ? { errors, input: null }
    : { errors, input: { p_task_id: task, ...(note && { p_note: note }) } };
}

export type ReassignTaskInput = { p_task_id: string; p_assignee_id: string; p_reason: string };

export function parseReassignForm(
  fd: FormData,
  ctx: { operatorIds: ReadonlySet<string>; currentAssigneeId: string | null },
): Parsed<ReassignTaskInput> {
  const task = str(fd, "task_id");
  const assignee = str(fd, "assignee_id");
  const reason = str(fd, "reason");
  const errors: Record<string, string> = {};
  if (!isGuid(task)) errors.task_id = "Reload the page and try again.";
  if (!assignee) errors.assignee_id = "Choose the new operator.";
  else if (assignee === ctx.currentAssigneeId) errors.assignee_id = "The task is already with this operator.";
  else if (!isGuid(assignee) || !ctx.operatorIds.has(assignee)) errors.assignee_id = "Choose one of the listed operators.";
  const r = reasonError(reason);
  if (r) errors.reason = r;
  return Object.keys(errors).length
    ? { errors, input: null }
    : { errors, input: { p_task_id: task, p_assignee_id: assignee, p_reason: reason } };
}

export type EditTaskValues = { title: string; instructions: string; due_at: string; location: string };

export type UpdateTaskInput = {
  p_task_id: string;
  p_title: string;
  p_instructions?: string;
  p_due_at?: string;
  p_location_text?: string;
};

/** Current values of the task as the edit form shows them (due as an IST `datetime-local`). */
export function editDefaults(t: { title: string; instructions: string | null; due_at: string | null; location_text: string | null }): EditTaskValues {
  return {
    title: t.title,
    instructions: t.instructions ?? "",
    due_at: t.due_at ? toIstInput(new Date(t.due_at)) : "",
    location: t.location_text ?? "",
  };
}

export function readEditForm(fd: FormData): EditTaskValues {
  return { title: str(fd, "title"), instructions: str(fd, "instructions"), due_at: str(fd, "due_at"), location: str(fd, "location") };
}

/**
 * update_field_task replaces all four values (an omitted optional clears it). An unchanged due time is sent back as
 * stored, so an overdue task can still be edited; a changed one must be in the future and within a year.
 */
export function validateEditForm(
  taskId: string,
  v: EditTaskValues,
  ctx: { now: Date; isRequest: boolean; currentDueAt: string | null },
): Parsed<UpdateTaskInput> {
  const errors: Record<string, string> = {};
  if (!isGuid(taskId)) errors.task_id = "Reload the page and try again.";
  if (v.title.length < TITLE_MIN || v.title.length > TITLE_MAX) errors.title = `Enter a title of ${TITLE_MIN} to ${TITLE_MAX} characters.`;
  if (ctx.isRequest && v.instructions.length < REQUEST_MIN) errors.instructions = `Describe what is needed (at least ${REQUEST_MIN} characters).`;
  else if (v.instructions.length > INSTRUCTIONS_MAX) errors.instructions = `Use at most ${INSTRUCTIONS_MAX} characters.`;
  if (v.location.length > LOCATION_MAX) errors.location = `Use at most ${LOCATION_MAX} characters.`;

  let due: string | undefined;
  if (v.due_at) {
    const unchanged = ctx.currentDueAt !== null && toIstInput(new Date(ctx.currentDueAt)) === v.due_at;
    if (unchanged) due = ctx.currentDueAt ?? undefined;
    else {
      const d = parseIstDateTime(v.due_at);
      if (!d) errors.due_at = "Enter a valid date and time.";
      else if (d.getTime() <= ctx.now.getTime()) errors.due_at = "The due time must be in the future.";
      else if (d.getTime() > ctx.now.getTime() + MAX_DUE_DAYS * 86_400_000) errors.due_at = "The due date must be within a year.";
      else due = d.toISOString();
    }
  }

  if (Object.keys(errors).length) return { errors, input: null };
  return {
    errors,
    input: {
      p_task_id: taskId,
      p_title: v.title,
      ...(v.instructions && { p_instructions: v.instructions }),
      ...(due && { p_due_at: due }),
      ...(v.location && { p_location_text: v.location }),
    },
  };
}
