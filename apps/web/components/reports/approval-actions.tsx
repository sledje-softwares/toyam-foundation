"use client";

import { useTransition } from "react";
import type { LinkResult } from "@/lib/reports";
import { ConfirmDialog, FormField, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toaster";

type VoidAction = (fd: FormData) => Promise<void>;

/** Request approval of the latest version (report_approvals insert). */
export function RequestApprovalButton({
  caseId,
  reportId,
  caseRef,
  version,
  action,
}: {
  caseId: string;
  reportId: string;
  caseRef: string;
  version: number;
  action: VoidAction;
}) {
  return (
    <ConfirmDialog trigger="Request approval" triggerVariant="primary" title={`Request approval of version ${version}?`} confirmLabel="Request approval" action={action}>
      <p>The orchestrators are notified. The report&apos;s values are locked until they approve it or request changes.</p>
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="report_id" value={reportId} />
      <input type="hidden" name="case_ref" value={caseRef} />
    </ConfirmDialog>
  );
}

/** Approve, or request changes with a comment (decided once; orchestrator / admin). */
export function DecideApproval({ approvalId, caseRef, version, action }: { approvalId: string; caseRef: string; version: number; action: VoidAction }) {
  const hidden = (decision: string) => (
    <>
      <input type="hidden" name="approval_id" value={approvalId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );
  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmDialog trigger="Request changes…" title={`Request changes to version ${version}?`} confirmLabel="Request changes" tone="danger" action={action}>
        <p>The case goes back to office review and the requester is notified with your comment.</p>
        {hidden("changes_requested")}
        <div className="mt-4 text-text">
          <FormField label="What needs to change" required hint="Shown to the office employee who requested approval.">
            {(p) => <Textarea {...p} name="comments" required minLength={3} maxLength={2000} rows={4} />}
          </FormField>
        </div>
      </ConfirmDialog>
      <ConfirmDialog trigger="Approve…" triggerVariant="primary" title={`Approve version ${version}?`} confirmLabel="Approve" action={action}>
        <p>An approval is final for this version. The report can then be sent to the insurer.</p>
        {hidden("approved")}
        <div className="mt-4 text-text">
          <FormField label="Comment (optional)">{(p) => <Textarea {...p} name="comments" maxLength={2000} rows={3} />}</FormField>
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** Downloads a generated version file through a 60-second signed link. */
export function ReportFileButton({ reportId, format, link }: { reportId: string; format: string; link: (id: string, format: string) => Promise<LinkResult> }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="min-h-8 text-sm text-primary underline hover:no-underline disabled:opacity-60"
      onClick={() =>
        start(async () => {
          const r = await link(reportId, format);
          if (r.url) window.location.assign(r.url);
          else toast(r.error ?? "The file could not be downloaded.", "error");
        })
      }
    >
      {pending ? "Preparing…" : format.toUpperCase()}
    </button>
  );
}
