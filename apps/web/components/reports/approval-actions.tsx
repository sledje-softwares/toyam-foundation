"use client";

import { ConfirmDialog, FormField, Textarea } from "@/components/ui";

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

/** D47: an orchestrator / admin approves the latest version in one step (approve_own_report). */
export function ApproveReportButton({
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
    <ConfirmDialog trigger="Approve report" triggerVariant="primary" title={`Approve version ${version}?`} confirmLabel="Approve report" action={action}>
      <p>
        You approve this version yourself; no one else needs to. The approval is final for this version, the values are locked
        and the report can be sent to the insurer.
      </p>
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="report_id" value={reportId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      <div className="mt-4 text-text">
        <FormField label="Comment (optional)">{(p) => <Textarea {...p} name="comments" maxLength={2000} rows={3} />}</FormField>
      </div>
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
