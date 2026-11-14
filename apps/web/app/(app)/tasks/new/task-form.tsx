"use client";

import { useActionState, useState } from "react";
import { formatDate } from "@/lib/format";
import { INSTRUCTIONS_MAX, LOCATION_MAX, REASON_MAX, TITLE_MAX, type TaskFormValues, type TaskMode } from "@/lib/tasks-form";
import { plural, TASK_KIND_LABELS, type ChecklistOption } from "@/lib/tasks";
import { Badge, ButtonLink, FormField, InlineAlert, Select, STATUS_MAPS, SubmitButton, Textarea, TextInput } from "@/components/ui";
import { createFieldTaskAction, type TaskFormState } from "./actions";
import type { CaseTask, Operator } from "./load";

const INITIAL: TaskFormState = { error: null, fieldErrors: {}, values: null };

function ErrorText({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {error}
    </p>
  );
}

function Legend({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <legend className="text-sm font-medium">
      {children}
      {required && (
        <>
          <span aria-hidden="true" className="text-danger"> *</span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </legend>
  );
}

function parentLabel(t: CaseTask): string {
  const status = STATUS_MAPS.task_status[t.status].label;
  const when = t.completed_at ? `${status.toLowerCase()} ${formatDate(t.completed_at)}` : status.toLowerCase();
  return [t.title, `${TASK_KIND_LABELS[t.kind].label}, ${when}`, t.assignee_name].filter(Boolean).join(" — ");
}

/** Assign field task (4.3) or, in re-investigation mode, send a request that creates a linked task (4.4). */
export function TaskForm({
  mode,
  caseId,
  caseRef,
  operators,
  checklists,
  previous,
  defaults,
  caseDueAt,
}: {
  mode: TaskMode;
  caseId: string;
  caseRef: string;
  operators: Operator[];
  checklists: ChecklistOption[];
  previous: CaseTask[];
  defaults: TaskFormValues;
  caseDueAt: string | null;
}) {
  const [state, action] = useActionState(createFieldTaskAction, INITIAL);
  const v = state.values ?? defaults;
  const e = state.fieldErrors;
  const reinv = mode === "reinvestigation";
  const [assignee, setAssignee] = useState(defaults.assignee_id);
  const operatorIds = new Set(operators.map((o) => o.id));

  const onParentChange = (id: string) => {
    // Re-investigations usually go back to the operator who did the earlier visit.
    const t = previous.find((p) => p.id === id);
    if (t?.assignee_id && operatorIds.has(t.assignee_id)) setAssignee(t.assignee_id);
  };

  return (
    <form action={action} className="max-w-3xl space-y-5" noValidate>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="case_id" value={caseId} />
      {reinv && <input type="hidden" name="kind" value="re_investigation" />}
      {state.error && (
        <InlineAlert tone="danger" title={reinv ? "The request was not sent" : "The task was not assigned"}>
          {state.error}
        </InlineAlert>
      )}

      {reinv && previous.length > 0 && (
        <FormField label="Earlier task" hint="The task this re-investigation follows up. Its operator is chosen below." error={e.parent_task_id}>
          {(p) => (
            <Select
              {...p}
              name="parent_task_id"
              defaultValue={v.parent_task_id}
              onChange={(ev) => onParentChange(ev.target.value)}
              placeholder="Not linked to an earlier task"
              options={previous.map((t) => ({ value: t.id, label: parentLabel(t) }))}
            />
          )}
        </FormField>
      )}

      <fieldset aria-describedby={e.assignee_id ? "assignee-err" : undefined}>
        <Legend required>Field operator</Legend>
        <div className="mt-2 overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Active field operators</caption>
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Operator</th>
                <th scope="col" className="px-3 py-2 font-medium">Region</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Open tasks</th>
                <th scope="col" className="px-3 py-2 font-medium">Availability</th>
              </tr>
            </thead>
            <tbody>
              {operators.map((o) => (
                <tr key={o.id} className={`border-t border-border ${assignee === o.id ? "bg-primary-soft" : ""}`}>
                  <td className="px-3 py-2">
                    <label className="flex min-h-8 items-center gap-2">
                      <input
                        type="radio"
                        name="assignee_id"
                        value={o.id}
                        checked={assignee === o.id}
                        onChange={() => setAssignee(o.id)}
                      />
                      <span className="font-medium">{o.full_name}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2">{o.region || "—"}</td>
                  <td className="px-3 py-2 text-right">{o.open_tasks}</td>
                  <td className="px-3 py-2">{o.availability ? <Badge tone="warning">{o.availability}</Badge> : "Available"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorText id="assignee-err" error={e.assignee_id} />
      </fieldset>

      {!reinv && (
        <fieldset aria-describedby={e.kind ? "kind-err" : undefined}>
          <Legend required>Kind</Legend>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
            {(["initial", "other"] as const).map((k) => (
              <label key={k} className="flex min-h-8 items-center gap-2 text-sm">
                <input type="radio" name="kind" value={k} defaultChecked={v.kind === k} />
                {TASK_KIND_LABELS[k].label}
              </label>
            ))}
          </div>
          <ErrorText id="kind-err" error={e.kind} />
        </fieldset>
      )}

      <FormField label="Title" required hint="Shown to the operator in the field app." error={e.title}>
        {(p) => <TextInput {...p} name="title" defaultValue={v.title} maxLength={TITLE_MAX} autoComplete="off" />}
      </FormField>

      <FormField
        label={reinv ? "Request" : "Instructions"}
        required={reinv}
        hint={
          reinv
            ? "Posted in the case thread as a request; the operator is notified. Say exactly what is still needed."
            : "Optional. What to collect, whom to meet, anything to watch for."
        }
        error={e.instructions}
      >
        {(p) => <Textarea {...p} name="instructions" defaultValue={v.instructions} rows={reinv ? 5 : 4} maxLength={INSTRUCTIONS_MAX} />}
      </FormField>

      <fieldset aria-describedby={e.checklist_id ? "checklist-err" : "checklist-hint"}>
        <Legend>Checklist</Legend>
        <p id="checklist-hint" className="text-xs text-text-muted">
          {checklists.length
            ? "The items are copied onto this task. They tick themselves as matching files are labelled."
            : "No checklist in use for this case type. An admin sets them up in Checklists."}
        </p>
        <div className="mt-1 flex flex-col gap-1">
          {checklists.map((c) => (
            <label key={c.id} className="flex min-h-8 items-center gap-2 text-sm">
              <input type="radio" name="checklist_id" value={c.id} defaultChecked={v.checklist_id === c.id} />
              {c.name} <span className="text-text-muted">({plural(c.items, "item")}{c.is_default ? ", default" : ""})</span>
            </label>
          ))}
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="radio" name="checklist_id" value="" defaultChecked={!v.checklist_id} />
            No checklist
          </label>
        </div>
        <ErrorText id="checklist-err" error={e.checklist_id} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Due (India time)"
          hint={caseDueAt ? `Optional. The case is due ${formatDate(caseDueAt)}.` : "Optional."}
          error={e.due_at}
        >
          {(p) => <TextInput {...p} name="due_at" type="datetime-local" defaultValue={v.due_at} />}
        </FormField>
        <FormField label="Location" hint="Optional. Address or area of the visit." error={e.location}>
          {(p) => <TextInput {...p} name="location" defaultValue={v.location} maxLength={LOCATION_MAX} autoComplete="off" />}
        </FormField>
      </div>

      <FormField
        label="Reason"
        hint="Optional. Why this field work is needed (e.g. what the insurer asked for). Stored on the task; the operator can read it."
        error={e.reason}
      >
        {(p) => <Textarea {...p} name="reason" defaultValue={v.reason} rows={2} maxLength={REASON_MAX} />}
      </FormField>

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <ButtonLink href={`/cases/${encodeURIComponent(caseRef)}`} variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingLabel={reinv ? "Sending…" : "Assigning…"}>{reinv ? "Send request" : "Assign field task"}</SubmitButton>
      </div>
    </form>
  );
}
