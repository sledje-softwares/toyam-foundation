"use client";

import { useState } from "react";
import { Button, ConfirmDialog, FormField, InlineAlert, Select, SubmitButton, Textarea, TextInput } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { ACTION_IDLE, ACTION_REASON_MAX, COMPLETE_NOTE_MAX, type EditTaskValues, type TaskActionResult } from "@/lib/tasks-actions";
import { INSTRUCTIONS_MAX, LOCATION_MAX, TITLE_MAX } from "@/lib/tasks-form";

type Action = (fd: FormData) => Promise<TaskActionResult>;

/**
 * Task detail actions (mark complete, cancel, reassign operator, edit). Success redirects back to the task with a flash; a failure
 * is shown inline. Inputs are controlled so a failed attempt keeps what was typed.
 */

export function CompleteTaskButton({ taskId, title, action }: { taskId: string; title: string; action: Action }) {
  const [note, setNote] = useState("");
  const [state, setState] = useState<TaskActionResult>(ACTION_IDLE);
  return (
    <div className="space-y-2">
      <ConfirmDialog
        trigger="Mark complete"
        title="Mark this field task complete?"
        confirmLabel="Mark complete"
        action={async (fd) => setState(await action(fd))}
      >
        <p className="mb-3">
          Use this when the operator has finished “{title}” but could not mark it done in the app. The thread shows that the
          office completed it and the operator is notified. Files captured before now can still arrive for the late-upload
          period. When no field work is left, the case moves to office review.
        </p>
        <input type="hidden" name="task_id" value={taskId} />
        <FormField label="Note" hint="Optional. Staff-only note in the thread and the audit log.">
          {(p) => <Textarea {...p} name="note" rows={3} maxLength={COMPLETE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
        </FormField>
      </ConfirmDialog>
      {state.error && (
        <InlineAlert tone="danger" title="The task was not marked complete">
          {state.fieldErrors.note ?? state.error}
        </InlineAlert>
      )}
    </div>
  );
}

export function CancelTaskButton({ taskId, title, action }: { taskId: string; title: string; action: Action }) {
  const [reason, setReason] = useState("");
  const [state, setState] = useState<TaskActionResult>(ACTION_IDLE);
  return (
    <div className="space-y-2">
      <ConfirmDialog
        trigger="Cancel task"
        title="Cancel this field task?"
        confirmLabel="Cancel task"
        tone="danger"
        action={async (fd) => setState(await action(fd))}
      >
        <p className="mb-3">
          “{title}” stops for the operator. Files captured before now can still arrive for the late-upload period. The
          thread shows the cancellation; the reason stays with staff.
        </p>
        <input type="hidden" name="task_id" value={taskId} />
        <FormField label="Reason" required hint="Staff-only note in the thread and the audit log.">
          {(p) => <Textarea {...p} name="reason" rows={3} maxLength={ACTION_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
      </ConfirmDialog>
      {state.error && (
        <InlineAlert tone="danger" title="The task was not cancelled">
          {state.fieldErrors.reason ?? state.error}
        </InlineAlert>
      )}
    </div>
  );
}

export function ReassignTaskForm({ taskId, options, action }: { taskId: string; options: SelectOption[]; action: Action }) {
  const [open, setOpen] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<TaskActionResult>(ACTION_IDLE);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reassign operator…
      </Button>
    );
  }
  return (
    <form noValidate className="space-y-3 rounded border border-border bg-bg p-4" action={async (fd) => setState(await action(fd))}>
      <input type="hidden" name="task_id" value={taskId} />
      <h3 className="text-sm font-semibold">Reassign to another operator</h3>
      <p className="text-xs text-text-muted">
        The new operator starts the task afresh and is notified. The current operator can still send files captured while
        holding the task, for the late-upload period.
      </p>
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      {options.length === 0 ? (
        <InlineAlert tone="warning">There is no other active field operator.</InlineAlert>
      ) : (
        <>
          <FormField label="New operator" required error={state.fieldErrors.assignee_id}>
            {(p) => (
              <Select {...p} name="assignee_id" value={assignee} onChange={(e) => setAssignee(e.target.value)} options={options} placeholder="Choose…" />
            )}
          </FormField>
          <FormField label="Reason" required error={state.fieldErrors.reason} hint="Staff-only note in the thread and the audit log.">
            {(p) => <Textarea {...p} name="reason" rows={3} maxLength={ACTION_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
        {options.length > 0 && <SubmitButton pendingLabel="Reassigning…">Reassign</SubmitButton>}
      </div>
    </form>
  );
}

export function EditTaskForm({
  taskId,
  defaults,
  isRequest,
  action,
}: {
  taskId: string;
  defaults: EditTaskValues;
  isRequest: boolean;
  action: Action;
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<EditTaskValues>(defaults);
  const [state, setState] = useState<TaskActionResult>(ACTION_IDLE);
  const set = (k: keyof EditTaskValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const e = state.fieldErrors;

  if (!open) {
    return (
      <Button
        variant="secondary"
        onClick={() => {
          setV(defaults);
          setState(ACTION_IDLE);
          setOpen(true);
        }}
      >
        Edit…
      </Button>
    );
  }
  return (
    <form noValidate className="space-y-3 rounded border border-border bg-bg p-4" action={async (fd) => setState(await action(fd))}>
      <input type="hidden" name="task_id" value={taskId} />
      <h3 className="text-sm font-semibold">Edit task</h3>
      <p className="text-xs text-text-muted">The operator is notified and the thread notes what changed.</p>
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      <FormField label="Title" required error={e.title}>
        {(p) => <TextInput {...p} name="title" value={v.title} onChange={set("title")} maxLength={TITLE_MAX} autoComplete="off" />}
      </FormField>
      <FormField label={isRequest ? "Request" : "Instructions"} required={isRequest} error={e.instructions}>
        {(p) => <Textarea {...p} name="instructions" rows={4} value={v.instructions} onChange={set("instructions")} maxLength={INSTRUCTIONS_MAX} />}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Due (India time)" hint="Leave empty for no due time." error={e.due_at}>
          {(p) => <TextInput {...p} name="due_at" type="datetime-local" value={v.due_at} onChange={set("due_at")} />}
        </FormField>
        <FormField label="Location" error={e.location}>
          {(p) => <TextInput {...p} name="location" value={v.location} onChange={set("location")} maxLength={LOCATION_MAX} autoComplete="off" />}
        </FormField>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
        <SubmitButton>Save changes</SubmitButton>
      </div>
    </form>
  );
}
