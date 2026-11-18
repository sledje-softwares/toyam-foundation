import { formatDateTime } from "@/lib/format";
import {
  isSendStatus,
  rowActions,
  SEND_STATUSES,
  type SendDefaults,
  type SenderMode,
  type SendModel,
  type SendRow,
} from "@/lib/report-send-core";
import type { Enums } from "@/lib/database.types";
import { Badge, InlineAlert } from "@/components/ui";
import { RetrySendButton, SendAutoRefresh, SendForm, SendNowButton, SettleSendDialog } from "./send-actions";

type VoidAction = (fd: FormData) => Promise<void>;

function StatusOf({ s }: { s: SendRow }) {
  if (!isSendStatus(s.status)) return <Badge>{s.status}</Badge>;
  return <Badge tone={SEND_STATUSES[s.status].tone}>{SEND_STATUSES[s.status].label}</Badge>;
}

/** 8.2 Send to insurer (D50): the form when the latest version may be sent, and every send of the case with its outcome. */
export function SendCard({
  caseId,
  caseRef,
  role,
  canManage,
  model,
  defaults,
  usableFormats,
  sends,
  latestReportId,
  mode,
  actions,
}: {
  caseId: string;
  caseRef: string;
  role: Enums<"user_role">;
  canManage: boolean;
  model: SendModel;
  defaults: SendDefaults | null;
  usableFormats: string[];
  sends: SendRow[];
  latestReportId: string | null;
  mode: SenderMode | null;
  actions: { requestSend: VoidAction; retrySend: VoidAction; sendNow: VoidAction; settleSend: VoidAction };
}) {
  if (!model.canSend && !model.blocked && sends.length === 0) return null;
  const testTo = mode?.mode === "test" ? mode.testTo : null;
  const busy = sends.some((s) => s.status === "queued" || s.status === "sending");
  return (
    <section aria-labelledby="send-h" className="mb-6 rounded border border-border bg-surface p-4">
      <h2 id="send-h" className="text-base font-semibold">
        Send to insurer
      </h2>
      <SendAutoRefresh active={busy} />

      {canManage && mode?.mode === "test" && (
        <div className="mt-3">
          <InlineAlert tone="warning" title="Test mode">
            Report emails go to {mode.testTo ?? "the test address"} only, never to the insurer, with [TEST] in the subject and the real
            recipients listed at the top. A test run is not recorded as sent; the case stays where it is.
          </InlineAlert>
        </div>
      )}
      {canManage && mode && !mode.configured && (model.canSend || model.open) && (
        <div className="mt-3">
          <InlineAlert tone="info" title="Sending is not set up yet">
            You can queue the email; it goes out once the admin has configured the sender.
          </InlineAlert>
        </div>
      )}
      {model.open && isSendStatus(model.open.status) && (
        <div className="mt-3">
          <InlineAlert tone={model.open.status === "unknown" ? "warning" : "info"} title={SEND_STATUSES[model.open.status].label}>
            {SEND_STATUSES[model.open.status].hint}
          </InlineAlert>
        </div>
      )}
      {model.blocked && <p className="mt-2 text-sm text-text-muted">{model.blocked}</p>}

      {model.canSend && defaults && (
        <details className="mt-3" open={sends.length === 0}>
          <summary className="min-h-8 cursor-pointer text-sm font-medium">{testTo ? "Send a test email" : "Write the email"}</summary>
          <SendForm caseId={caseId} caseRef={caseRef} defaults={defaults} usableFormats={usableFormats} testTo={testTo} action={actions.requestSend} />
        </details>
      )}

      {sends.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Report emails of this case</caption>
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Requested</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">To / Cc</th>
                <th scope="col" className="px-3 py-2 font-medium">Formats</th>
                <th scope="col" className="px-3 py-2 font-medium">Details</th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sends.map((s) => {
                const a = rowActions({ role, canManage, status: s.status, isLatest: s.report_id === latestReportId });
                return (
                  <tr key={s.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      {formatDateTime(s.requested_at)}
                      {s.requester && <div className="text-xs text-text-muted">by {s.requester}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <StatusOf s={s} />
                      {s.attempts > 1 && <div className="text-xs text-text-muted">{s.attempts} attempts</div>}
                    </td>
                    <td className="max-w-72 px-3 py-2 break-words">
                      {s.to_addresses.join(", ")}
                      {s.cc_addresses.length > 0 && <div className="text-xs text-text-muted">Cc {s.cc_addresses.join(", ")}</div>}
                    </td>
                    <td className="px-3 py-2">{s.formats.map((f) => f.toUpperCase()).join(", ")}</td>
                    <td className="max-w-72 px-3 py-2 break-words text-text-muted">
                      {s.status === "test_sent" && <>Went to {s.test_recipient} only. </>}
                      {s.sent_at && <>Sent {formatDateTime(s.sent_at)}. </>}
                      {s.error && <span className={s.status === "failed" || s.status === "unknown" ? "text-danger" : undefined}>{s.error}</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-2">
                        {a.sendNow && <SendNowButton sendId={s.id} caseRef={caseRef} action={actions.sendNow} />}
                        {a.retry && <RetrySendButton sendId={s.id} caseRef={caseRef} error={s.error} action={actions.retrySend} />}
                        {a.settle && <SettleSendDialog sendId={s.id} caseRef={caseRef} subject={s.subject} action={actions.settleSend} />}
                        {s.status === "unknown" && canManage && !a.settle && (
                          <span className="text-xs text-text-muted">An orchestrator settles this after checking the Sent folder.</span>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
