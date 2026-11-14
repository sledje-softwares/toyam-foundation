"use client";

import { useState } from "react";
import { Button, FormField, InlineAlert, Select, SubmitButton, Textarea, toast } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import type { CaseActionResult } from "@/lib/cases";

type Action = (fd: FormData) => Promise<CaseActionResult>;

const IDLE: CaseActionResult = { error: null, fieldErrors: {} };

/**
 * 4.2: orchestrator / admin picks the new owner and gives a reason. Inputs are controlled so a failed attempt
 * keeps what was typed (React resets uncontrolled fields after a form action).
 */
export function ReassignForm({
  caseId,
  caseRef,
  options,
  action,
  reasonMax,
}: {
  caseId: string;
  caseRef: string;
  options: SelectOption[];
  action: Action;
  reasonMax: number;
}) {
  const [open, setOpen] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<CaseActionResult>(IDLE);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Reassign…
      </Button>
    );
  }

  return (
    <form
      noValidate
      className="space-y-3 rounded border border-border bg-bg p-4"
      action={async (fd) => {
        const res = await action(fd);
        setState(res);
        if (!res.error) {
          toast(res.message ?? "Case reassigned.");
          setAssignee("");
          setReason("");
          setOpen(false);
        }
      }}
    >
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      <h3 className="text-sm font-semibold">Reassign this case</h3>
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      {options.length === 0 ? (
        <InlineAlert tone="warning">There is no other active office, orchestrator or admin user.</InlineAlert>
      ) : (
        <>
          <FormField label="New owner" required error={state.fieldErrors.assignee_id} hint="Available staff first, least loaded first.">
            {(p) => (
              <Select {...p} name="assignee_id" value={assignee} onChange={(e) => setAssignee(e.target.value)} options={options} placeholder="Choose…" />
            )}
          </FormField>
          <FormField label="Reason" required error={state.fieldErrors.reason} hint="Shown to staff in the thread and the history.">
            {(p) => (
              <Textarea {...p} name="reason" rows={3} maxLength={reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
          </FormField>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {options.length > 0 && <SubmitButton pendingLabel="Reassigning…">Reassign</SubmitButton>}
      </div>
    </form>
  );
}

/** Unassigned case: run the assignment rules again. */
export function RetryAssignButton({ caseId, caseRef, action }: { caseId: string; caseRef: string; action: Action }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      action={async (fd) => {
        const res = await action(fd);
        setError(res.error);
        if (!res.error) toast(res.message ?? "Case assigned.");
      }}
    >
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      {error && <InlineAlert tone="warning">{error}</InlineAlert>}
      <SubmitButton variant="secondary" pendingLabel="Assigning…">
        Run automatic assignment
      </SubmitButton>
    </form>
  );
}
