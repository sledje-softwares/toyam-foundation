"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { SendDefaults } from "@/lib/report-send-core";
import { Checkbox, ConfirmDialog, FormField, SubmitButton, Textarea, TextInput } from "@/components/ui";

type VoidAction = (fd: FormData) => Promise<void>;

/** The "Send to insurer" form (request_report_send). Prefilled from the reply target and the template's patterns. */
export function SendForm({
  caseId,
  caseRef,
  defaults,
  usableFormats,
  testTo,
  action,
}: {
  caseId: string;
  caseRef: string;
  defaults: SendDefaults;
  usableFormats: string[];
  /** Test mode: the only address the mail goes to (shown on the button's hint). */
  testTo: string | null;
  action: VoidAction;
}) {
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      <FormField label="To" required hint="The insurer's sender by default. Separate addresses with commas.">
        {(p) => <TextInput {...p} name="to" required defaultValue={defaults.to} autoComplete="off" />}
      </FormField>
      <FormField label="Cc" hint="The original recipients by default. At most 30 recipients in all.">
        {(p) => <TextInput {...p} name="cc" defaultValue={defaults.cc} autoComplete="off" />}
      </FormField>
      <FormField label="Subject" required hint="Keep the insurer's subject so the reply stays on their thread.">
        {(p) => <TextInput {...p} name="subject" required maxLength={300} defaultValue={defaults.subject} />}
      </FormField>
      <FormField label="Message" required>
        {(p) => <Textarea {...p} name="body" required maxLength={5000} rows={6} defaultValue={defaults.body} />}
      </FormField>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="File name" required hint="Without the extension; .pdf / .docx is added.">
          {(p) => <TextInput {...p} name="attachment_name" required maxLength={100} defaultValue={defaults.attachmentName} autoComplete="off" />}
        </FormField>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">
            Formats<span aria-hidden="true" className="text-danger"> *</span>
          </legend>
          <div className="flex gap-4 pt-1">
            {usableFormats.map((f) => (
              <Checkbox key={f} name="formats" value={f} label={f.toUpperCase()} defaultChecked={defaults.formats.includes(f as "pdf" | "docx")} />
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Queueing…">{testTo ? "Send test email" : "Send to insurer"}</SubmitButton>
        <span className="text-xs text-text-muted">
          {testTo
            ? `Test mode: the email goes to ${testTo} only.`
            : "Sent from the shared Gmail as a reply on the insurer's thread. It is never sent twice by itself."}
        </span>
      </div>
    </form>
  );
}

function Hidden({ sendId, caseRef }: { sendId: string; caseRef: string }) {
  return (
    <>
      <input type="hidden" name="send_id" value={sendId} />
      <input type="hidden" name="case_ref" value={caseRef} />
    </>
  );
}

export function RetrySendButton({ sendId, caseRef, error, action }: { sendId: string; caseRef: string; error: string | null; action: VoidAction }) {
  return (
    <ConfirmDialog trigger="Retry…" title="Send this email again?" confirmLabel="Retry" action={action}>
      <p>Nothing was sent last time{error ? `: ${error}` : "."} The same recipients, files and message are used.</p>
      <Hidden sendId={sendId} caseRef={caseRef} />
    </ConfirmDialog>
  );
}

export function SendNowButton({ sendId, caseRef, action }: { sendId: string; caseRef: string; action: VoidAction }) {
  return (
    <form action={action}>
      <Hidden sendId={sendId} caseRef={caseRef} />
      <SubmitButton variant="secondary" pendingLabel="Starting…">
        Send now
      </SubmitButton>
    </form>
  );
}

/** Settle an unknown outcome (resolve_report_send) after looking in the shared Gmail's Sent folder. */
export function SettleSendDialog({ sendId, caseRef, subject, action }: { sendId: string; caseRef: string; subject: string; action: VoidAction }) {
  return (
    <ConfirmDialog trigger="Settle…" title="Is the email in the Sent folder?" confirmLabel="Record" tone="danger" action={action}>
      <p>
        The connection was lost after the email was handed to Gmail, so it may or may not have gone out. Open the shared
        Gmail&apos;s Sent folder and look for &quot;{subject}&quot; before you answer. If it is there, the submission is recorded;
        if not, the send can be retried.
      </p>
      <Hidden sendId={sendId} caseRef={caseRef} />
      <fieldset className="mt-4 space-y-2 text-text">
        <legend className="text-sm font-medium">What did you find?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="was_sent" value="yes" required /> It is in the Sent folder (record as sent)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="was_sent" value="no" required /> It is not there (record as not sent)
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}

/** Refreshes the page every few seconds while a send is queued or sending (stops after ~3 minutes). */
export function SendAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > 36) clearInterval(t);
      else router.refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
