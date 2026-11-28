import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime } from "@/lib/format";
import type { SearchParams } from "@/lib/list-params";
import { approvalModel, canManageCase, dueLabel, editLock, REPORT_STAGES, reportStage, workspaceTotals } from "@/lib/reports";
import { Badge, buttonClass, ErrorState, InlineAlert, PageHeader, StatusBadge } from "@/components/ui";
import { ApprovalCard } from "@/components/reports/approval-card";
import { EvidencePanel } from "@/components/reports/evidence-panel";
import { GenerateReport } from "@/components/reports/generate-report";
import { PlannedNote } from "@/components/reports/planned";
import { SectionEditor, SourceBadge, ValueText } from "@/components/reports/section-editor";
import { SendCard } from "@/components/reports/send-card";
import { readReportEmail, REPORT_FORMATS, reportSenderMode, sendDefaults, sendModel } from "@/lib/report-send";
import { approveOwnReport, correctLabels, decideApproval, evidenceLink, requestApproval, saveSection, setRelevance } from "./actions";
import { loadWorkspace } from "./load";
import { requestSend, retrySend, sendNow, settleSend } from "./send-actions";

export const metadata = { title: "Report" };

const CASE_REF = /^[A-Za-z0-9_\-/]{3,40}$/;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function ReportWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseRef: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const me = await requireRole(STAFF_ROLES);
  const [{ caseRef: raw }, sp] = await Promise.all([params, searchParams]);
  let caseRef = raw;
  try {
    caseRef = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (!CASE_REF.test(caseRef)) notFound();

  const supabase = await createClient();
  const ws = await loadWorkspace(supabase, caseRef, one(sp.section) || null);
  if (ws === "error") return <ErrorState what="This report" />;
  if (!ws) notFound();

  const c = ws.case;
  const href = `/reports/${encodeURIComponent(c.case_ref)}`;
  const ownsCase = c.office_owner_id === me.id;
  const lock = editLock(me.role, c.status, ownsCase);
  // Relevance and labels stay open after approval (they do not change the values); ownership as D44.
  const filesEditable = canManageCase(me.role, c.office_owner_id, me.id);
  const totals = workspaceTotals(ws.sections);
  const stage = reportStage(
    c.status,
    ws.versions.flatMap((v) => (v.approval ? [v.approval] : [])),
  );
  const approval = approvalModel({
    role: me.role,
    ownsCase,
    requiresApproval: ws.template?.requires_approval ?? true,
    status: c.status,
    versions: ws.versions,
    requiredMissing: totals.requiredTotal - totals.requiredFilled,
  });
  const due = dueLabel(c.due_at);
  const sent = c.status === "submitted" || c.status === "closed";

  // 8.2 Send to insurer: the latest version, in the formats the template allows and that were generated.
  const latestVersion = ws.versions.find((v) => v.id === approval.latest?.id) ?? null;
  const generated = latestVersion?.files.map((f) => f.format) ?? [];
  const allowed = ws.template?.output_formats ?? [];
  const usableFormats = REPORT_FORMATS.filter((f) => allowed.includes(f) && generated.includes(f));
  const send = sendModel({
    canManage: filesEditable,
    caseStatus: c.status,
    approvalState: approval.state,
    latestReportId: latestVersion?.id ?? null,
    sends: ws.sends,
    hasTarget: !!ws.sendTarget,
    usableFormats,
  });
  const defaults = send.canSend
    ? sendDefaults({
        target: ws.sendTarget,
        reportEmail: readReportEmail(ws.template?.report_email),
        values: ws.valuesByKey,
        caseRef: c.case_ref,
        allowedFormats: allowed,
        generatedFormats: generated,
        defaultFormat: ws.template?.default_output_format ?? null,
      })
    : null;
  // Test / live notice: asked only when this user could send or settle something here.
  const senderMode = filesEditable && (send.canSend || send.open) ? await reportSenderMode() : null;

  return (
    <>
      <PageHeader
        title={c.case_ref}
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: c.case_ref }]}
        badges={
          <>
            {stage && <Badge tone={REPORT_STAGES[stage].tone}>{REPORT_STAGES[stage].label}</Badge>}
            <StatusBadge kind="case_status" value={c.status} />
          </>
        }
        actions={
          ws.template && lock.editable ? (
            <GenerateReport caseId={c.id} caseRef={c.case_ref} previewHref={`${href}/preview`} />
          ) : ws.template ? (
            // Read-only viewers may still open the preview; generating stays with editors.
            <Link href={`${href}/preview`} className={buttonClass("secondary")}>
              Preview
            </Link>
          ) : undefined
        }
      />
      <p className="-mt-4 mb-4 flex flex-wrap gap-x-2 text-sm text-text-muted">
        <span>{c.insurer?.name ?? "Unknown insurer"}</span>
        <span aria-hidden="true">·</span>
        <span>Claim {c.insurer_claim_no}</span>
        {ws.template && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {ws.template.name} v{ws.template.version}
              {!ws.template.is_active && " (an older version: this case keeps the template it started with)"}
            </span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span>Owner {c.owner ?? "unassigned"}</span>
        <span aria-hidden="true">·</span>
        <span className={due?.overdue && !sent ? "font-medium text-danger" : undefined}>
          Due {formatDate(c.due_at)}
          {due && !sent && ` (${due.text})`}
        </span>
        {ws.lastSubmission && (
          <>
            <span aria-hidden="true">·</span>
            <span>Sent {formatDateTime(ws.lastSubmission.submitted_at)}</span>
          </>
        )}
      </p>

      {!lock.editable && (
        <div className="mb-4">
          <InlineAlert title="Read only">{lock.reason}</InlineAlert>
        </div>
      )}
      {lock.editable && me.role !== "office" && !ownsCase && (
        <div className="mb-4">
          <InlineAlert tone="info">
            This case belongs to {c.owner ?? "nobody yet"}. You can edit the report; your changes are recorded under your name.
          </InlineAlert>
        </div>
      )}

      {!ws.template ? (
        <InlineAlert tone="warning" title="No template">
          This case has no template, so it has no report sections. Cases get their template at intake; ask an admin to check the
          insurer&apos;s templates.
        </InlineAlert>
      ) : (
        <>
          <ApprovalCard
            caseId={c.id}
            caseRef={c.case_ref}
            model={approval}
            versions={ws.versions}
            outputFormats={ws.template.output_formats}
            actions={{ requestApproval, approveOwnReport, decideApproval }}
          />

          <SendCard
            caseId={c.id}
            caseRef={c.case_ref}
            role={me.role}
            canManage={filesEditable}
            model={send}
            defaults={defaults}
            usableFormats={usableFormats}
            sends={ws.sends}
            latestReportId={latestVersion?.id ?? null}
            mode={senderMode}
            actions={{ requestSend, retrySend, sendNow, settleSend }}
          />

          {ws.sections.length === 0 ? (
            <InlineAlert tone="warning" title="Nothing to fill">
              This template version has no report sections.
            </InlineAlert>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_25rem]">
              <section aria-labelledby="sections-h" className="rounded border border-border bg-surface">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
                  <h2 id="sections-h" className="text-base font-semibold">
                    Sections
                  </h2>
                  <p className="text-sm text-text-muted tabular-nums">
                    {totals.requiredFilled} / {totals.requiredTotal} required · {totals.filled} / {totals.total} filled
                  </p>
                </div>
                <ol>
                  {ws.sections.map((s) => {
                    const open = s.id === ws.focused?.id;
                    const missing = s.requiredTotal - s.requiredFilled;
                    const complete = missing === 0;
                    return (
                      <li key={s.id} className="border-b border-border last:border-b-0">
                        <Link
                          href={`${href}?section=${encodeURIComponent(s.key)}`}
                          scroll={false}
                          aria-current={open ? "true" : undefined}
                          aria-expanded={open}
                          className={`flex min-h-10 items-center gap-3 px-4 py-2 text-sm hover:bg-primary-soft ${open ? "bg-slate-50 font-semibold" : ""}`}
                        >
                          <span aria-hidden="true" className={`w-4 text-center ${complete ? "text-success" : "text-text-muted"}`}>
                            {open ? "▾" : complete ? "✓" : "▸"}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <span className="tabular-nums text-text-muted">
                            {s.filled}/{s.total}
                          </span>
                          {missing > 0 ? <Badge tone="warning">{missing} required</Badge> : <span className="sr-only">All required fields filled</span>}
                        </Link>
                        {open && (
                          <div className="space-y-4 border-t border-border px-4 py-4">
                            {s.guidance && <p className="text-sm text-text-muted">{s.guidance}</p>}
                            {s.lastUpdatedAt && <p className="text-xs text-text-muted">Last change {formatDateTime(s.lastUpdatedAt)}</p>}
                            {lock.editable ? (
                              <SectionEditor key={s.id} caseId={c.id} sectionId={s.id} version={s.version} fields={s.fields} action={saveSection} />
                            ) : (
                              <dl className="grid gap-x-4 gap-y-3 md:grid-cols-2">
                                {s.fields.map((f) => (
                                  <div key={f.key} className={f.type === "long_text" ? "md:col-span-2" : undefined}>
                                    <dt className="text-sm font-medium">
                                      {f.label}
                                      {f.required && <span aria-hidden="true" className="text-danger"> *</span>}
                                    </dt>
                                    <dd className="mt-1 text-sm">
                                      <ValueText f={f} /> <SourceBadge f={f} />
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                            <PlannedNote piece="7.4" title="Suggested values">
                              {ws.pendingSuggestions > 0
                                ? `${ws.pendingSuggestions} ${ws.pendingSuggestions === 1 ? "suggestion is" : "suggestions are"} waiting for this section's fields. Accepting or rejecting them here comes next.`
                                : "Values read from the files will be offered here to accept or reject, with the file they came from."}
                            </PlannedNote>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>

              <aside aria-labelledby="files-h" className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
                <EvidencePanel
                  sectionTitle={ws.focused?.title ?? null}
                  categories={ws.focusedCategories}
                  panel={ws.panel}
                  caseRef={c.case_ref}
                  editable={filesEditable}
                  labelOptions={ws.labelOptions}
                  actions={{ setRelevance, correctLabels, evidenceLink }}
                />
              </aside>
            </div>
          )}
        </>
      )}
    </>
  );
}
