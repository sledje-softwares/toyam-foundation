"use client";

import { CHANNELS, FORMATS, MANUAL_CHANNELS } from "@/lib/submissions";
import { Checkbox, ConfirmDialog, FormField, Select, Textarea, TextInput } from "@/components/ui";

type VoidAction = (fd: FormData) => Promise<void>;

/** Record the insurer's acknowledgement (record_submission_ack; once). */
export function AckDialog({ submissionId, caseRef, back, action }: { submissionId: string; caseRef: string; back: string; action: VoidAction }) {
  return (
    <ConfirmDialog trigger="Record ack…" title={`Record the acknowledgement for ${caseRef}?`} confirmLabel="Record acknowledgement" action={action}>
      <p>Recorded once. Use the time the insurer acknowledged the report (mail, portal status or call).</p>
      <input type="hidden" name="submission_id" value={submissionId} />
      <input type="hidden" name="back" value={back} />
      <div className="mt-4 space-y-3 text-text">
        <FormField label="Acknowledged at" hint="India time. Leave empty for now.">
          {(p) => <TextInput {...p} name="ack_at" type="datetime-local" />}
        </FormField>
        <FormField label="Insurer reference" hint="Optional, if the insurer gave one.">
          {(p) => <TextInput {...p} name="insurer_reference" maxLength={200} autoComplete="off" />}
        </FormField>
        <FormField label="Note">{(p) => <Textarea {...p} name="note" maxLength={1000} rows={2} />}</FormField>
      </div>
    </ConfirmDialog>
  );
}

/** Reopen a submitted case when the insurer asks (reopen_case; D46: the only way to new field work on it). */
export function ReopenDialog({ caseId, caseRef, back, action }: { caseId: string; caseRef: string; back: string; action: VoidAction }) {
  return (
    <ConfirmDialog trigger="Reopen…" title={`Reopen ${caseRef}?`} confirmLabel="Reopen case" tone="danger" action={action}>
      <p>
        Reopen a sent case only when the insurer asks. It goes back to office review: field work can be assigned again,
        and the report can be edited and needs a new version and approval before it is sent. The owner is notified and the
        insurer&apos;s request is kept in the case history.
      </p>
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="back" value={back} />
      <div className="mt-4 text-text">
        <FormField label="Insurer's request (what they asked for)" required hint="E.g. a second garage visit or the RC copy. 3 to 500 characters.">
          {(p) => <Textarea {...p} name="reason" required minLength={3} maxLength={500} rows={3} />}
        </FormField>
      </div>
    </ConfirmDialog>
  );
}

/** Record a report delivered on the insurer's portal or another way (record_manual_submission; latest version). */
export function ManualSubmissionDialog({ back, action }: { back: string; action: VoidAction }) {
  return (
    <ConfirmDialog trigger="Record portal / other submission…" title="Record a submission" confirmLabel="Record submission" action={action}>
      <p>
        For reports uploaded to an insurer&apos;s portal or delivered another way. The latest report version of the case is
        recorded; it must be approved where the template requires it. Emails are recorded by the sender.
      </p>
      <input type="hidden" name="back" value={back} />
      <div className="mt-4 space-y-3 text-text">
        <FormField label="Case reference" required>
          {(p) => <TextInput {...p} name="case_ref" required placeholder="INV-2026-000123" autoComplete="off" />}
        </FormField>
        <FormField label="Channel" required>
          {(p) => <Select {...p} name="channel" required defaultValue="portal" options={MANUAL_CHANNELS.map((c) => ({ value: c, label: CHANNELS[c] }))} />}
        </FormField>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">
            Formats delivered<span aria-hidden="true" className="text-danger"> *</span>
          </legend>
          <div className="flex gap-4">
            {FORMATS.map((f) => (
              <Checkbox key={f} name="formats" value={f} label={f.toUpperCase()} defaultChecked={f === "pdf"} />
            ))}
          </div>
        </fieldset>
        <FormField label="Sent at" hint="India time. Leave empty for now.">
          {(p) => <TextInput {...p} name="submitted_at" type="datetime-local" />}
        </FormField>
        <FormField label="Portal reference" hint="Required for portal uploads.">
          {(p) => <TextInput {...p} name="insurer_reference" maxLength={200} autoComplete="off" />}
        </FormField>
        <FormField label="Note" hint="Required for other channels: say how it was delivered.">
          {(p) => <Textarea {...p} name="note" maxLength={1000} rows={2} />}
        </FormField>
      </div>
    </ConfirmDialog>
  );
}
