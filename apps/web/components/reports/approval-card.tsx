import { formatDateTime } from "@/lib/format";
import { APPROVAL_DECISIONS, type ApprovalModel, type VersionRow } from "@/lib/reports";
import { FORMAT_LABEL, isReportFormat, reportFileHref } from "@/lib/report-generate-core";
import { Badge, InlineAlert } from "@/components/ui";
import { ApproveReportButton, DecideApproval, RequestApprovalButton } from "./approval-actions";
import { PlannedButton } from "./planned";

type VoidAction = (fd: FormData) => Promise<void>;

const STATE_TEXT: Record<ApprovalModel["state"], string> = {
  not_required: "This template does not require approval; the report can be sent once it is generated.",
  no_version: "No version generated yet. Approval is required by this template.",
  not_requested: "The latest version has not been approved yet.",
  pending: "The latest version is waiting for an orchestrator.",
  approved: "The latest version is approved and can be sent.",
  changes_requested: "Changes were requested on the latest version.",
};

/** Versions (7.7 output) and approval (8.1) of the case's report. */
export function ApprovalCard({
  caseId,
  caseRef,
  model,
  versions,
  outputFormats,
  actions,
}: {
  caseId: string;
  caseRef: string;
  model: ApprovalModel;
  versions: VersionRow[];
  outputFormats: string[];
  actions: {
    requestApproval: VoidAction;
    approveOwnReport: VoidAction;
    decideApproval: VoidAction;
  };
}) {
  const latest = versions.find((v) => v.id === model.latest?.id) ?? null;
  const detail = latest?.approvalDetail ?? null;
  return (
    <section aria-labelledby="approval-h" className="mb-6 rounded border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="approval-h" className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Report versions and approval
            {latest && <Badge>v{latest.version}</Badge>}
            {latest?.approval && <Badge tone={APPROVAL_DECISIONS[latest.approval.decision].tone}>{APPROVAL_DECISIONS[latest.approval.decision].label}</Badge>}
          </h2>
          <p className="text-sm text-text-muted">
            {STATE_TEXT[model.state]} Formats allowed: {outputFormats.map((f) => f.toUpperCase()).join(", ")}.
          </p>
          {detail && (
            <p className="text-sm text-text-muted">
              Requested {formatDateTime(detail.requested_at)}
              {detail.requester && <> by {detail.requester}</>}
              {detail.decided_at && (
                <>
                  {" "}· decided {formatDateTime(detail.decided_at)}
                  {detail.decider && <> by {detail.decider}</>}
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {model.canDecide && latest?.approval && (
            <DecideApproval approvalId={latest.approval.id} caseRef={caseRef} version={latest.version} action={actions.decideApproval} />
          )}
          {model.canRequest && latest && model.oneStep && (
            <ApproveReportButton caseId={caseId} reportId={latest.id} caseRef={caseRef} version={latest.version} action={actions.approveOwnReport} />
          )}
          {model.canRequest && latest && !model.oneStep && (
            <RequestApprovalButton caseId={caseId} reportId={latest.id} caseRef={caseRef} version={latest.version} action={actions.requestApproval} />
          )}
          {!model.canRequest && model.requestBlocked && (
            <span className="flex flex-wrap items-center gap-2">
              <button type="button" disabled className="inline-flex h-9 items-center rounded border border-border-input px-4 text-sm font-medium opacity-60" aria-describedby="request-why">
                {model.oneStep ? "Approve report" : "Request approval"}
              </button>
              <span id="request-why" className="max-w-64 text-xs text-text-muted">
                {model.requestBlocked}
              </span>
            </span>
          )}
          {(model.state === "approved" || model.state === "not_required") && <PlannedButton piece="8.2">Send to insurer</PlannedButton>}
        </div>
      </div>

      {detail?.comments && (
        <div className="mt-3">
          <InlineAlert tone={latest?.approval?.decision === "changes_requested" ? "warning" : "info"} title="Orchestrator's comment">
            <span className="whitespace-pre-wrap">{detail.comments}</span>
          </InlineAlert>
        </div>
      )}

      <details className="mt-3">
        <summary className="min-h-8 cursor-pointer text-sm font-medium">Versions ({versions.length})</summary>
        {versions.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No version yet. Use Generate report above to make the first one.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Report versions</caption>
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Version</th>
                  <th scope="col" className="px-3 py-2 font-medium">Created</th>
                  <th scope="col" className="px-3 py-2 font-medium">Origin</th>
                  <th scope="col" className="px-3 py-2 font-medium">By</th>
                  <th scope="col" className="px-3 py-2 font-medium">Notes</th>
                  <th scope="col" className="px-3 py-2 font-medium">Files</th>
                  <th scope="col" className="px-3 py-2 font-medium">Approval</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">v{v.version}</td>
                    <td className="px-3 py-2">{formatDateTime(v.created_at)}</td>
                    <td className="px-3 py-2">{v.origin === "generated" ? "Generated" : "Uploaded"}</td>
                    <td className="px-3 py-2">{v.creator ?? "—"}</td>
                    <td className="max-w-64 px-3 py-2 whitespace-pre-wrap break-words">{v.notes ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className="flex gap-3">
                        {v.files.length
                          ? v.files.filter((f) => isReportFormat(f.format)).map((f) => (
                              <a key={f.format} href={reportFileHref(v.id, f.format)} className="min-h-8 text-sm text-primary underline hover:no-underline">
                                {isReportFormat(f.format) ? FORMAT_LABEL[f.format] : f.format}
                              </a>
                            ))
                          : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {v.approval ? <Badge tone={APPROVAL_DECISIONS[v.approval.decision].tone}>{APPROVAL_DECISIONS[v.approval.decision].label}</Badge> : <span className="text-text-muted">Not requested</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </section>
  );
}
