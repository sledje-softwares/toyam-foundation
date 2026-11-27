import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime, formatINR, formatRelativeDay } from "@/lib/format";
import {
  assigneeOptions,
  caseHref,
  checklistProgress,
  FIELD_SOURCE_LABELS,
  intakeFieldRows,
  isTerminal,
  newTaskHref,
  OPEN_STATUSES,
  REASON_MAX,
  TASK_KIND_LABELS,
} from "@/lib/cases";
import { Badge, ErrorState, StatusBadge } from "@/components/ui";
import { ReassignForm, RetryAssignButton } from "@/components/cases/reassign-form";
import { reassignCaseAction, retryAutoAssignAction } from "./actions";
import { loadCase, refParam } from "./load";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function Card({ title, id, actions, children }: { title: string; id: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded border border-border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const STAFF = ["admin", "orchestrator", "office"] as const;

export default async function CaseOverviewPage({ params }: { params: Promise<{ ref: string }> }) {
  const me = await requireRole(STAFF_ROLES);
  const ref = refParam((await params).ref);
  const c = ref ? await loadCase(ref) : null;
  if (!c || c === "error") notFound();
  const canReassign = me.role === "orchestrator" || me.role === "admin";
  const now = new Date();

  const supabase = await createClient();
  const [fieldDefs, values, tasks, checklist, outbox, assignments, staff, openCases] = await Promise.all([
    c.template_id
      ? supabase
          .from("case_template_fields")
          .select("id, key, label, position, case_template_sections(position, title)")
          .eq("template_id", c.template_id)
          .eq("source", "intake")
      : Promise.resolve({ data: [], error: null }),
    supabase.from("case_field_values").select("field_id, value, source").eq("case_id", c.id),
    supabase
      .from("tasks")
      .select("id, title, kind, status, due_at, created_at, completed_at, assignee:profiles!tasks_assignee_id_fkey(full_name)")
      .eq("case_id", c.id)
      .order("created_at", { ascending: false }),
    supabase.from("v_case_checklist").select("task_id, status, is_mandatory, evidence_count").eq("case_id", c.id),
    supabase.rpc("case_outbox_status", { p_case_id: c.id }),
    supabase
      .from("case_assignments")
      .select("id, assigned_at, method, reason, assignee:profiles!case_assignments_assignee_id_fkey(full_name), by:profiles!case_assignments_assigned_by_fkey(full_name)")
      .eq("case_id", c.id)
      .order("assigned_at", { ascending: false })
      .limit(5),
    canReassign
      ? supabase
          .from("profiles")
          .select("id, full_name, role, availability, availability_until, max_open_cases")
          .eq("is_active", true)
          .in("role", [...STAFF])
          .order("full_name")
      : Promise.resolve({ data: [], error: null }),
    canReassign
      ? supabase.from("cases").select("office_owner_id").in("status", OPEN_STATUSES).not("office_owner_id", "is", null).limit(10000)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const intake = intakeFieldRows(
    (fieldDefs.data ?? []).map((f) => {
      const s = one(f.case_template_sections);
      return { id: f.id, key: f.key, label: f.label, position: f.position, section_position: s?.position ?? 0, section_title: s?.title ?? null };
    }),
    values.data ?? [],
  );
  const progress = checklistProgress(checklist.data ?? []);
  const waiting = (outbox.data ?? []).filter((o) => o.pending_count > 0);

  const counts = new Map<string, number>();
  for (const r of openCases.data ?? []) if (r.office_owner_id) counts.set(r.office_owner_id, (counts.get(r.office_owner_id) ?? 0) + 1);
  const options = assigneeOptions(staff.data ?? [], counts, c.office_owner_id, now);

  const details: { label: string; value: React.ReactNode }[] = [
    { label: "Claim no.", value: c.insurer_claim_no },
    { label: "Policy no.", value: c.policy_no || "—" },
    { label: "Claim amount", value: formatINR(c.claim_amount) },
    { label: "Incident date", value: formatDate(c.incident_date) },
    { label: "Received", value: formatDateTime(c.received_at) },
    { label: "Due", value: formatDateTime(c.due_at) },
  ];
  if (c.closed_at) details.push({ label: "Closed", value: formatDateTime(c.closed_at) });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <Card title="Intake fields" id="intake-h">
          <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-text-muted">{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
          {c.suspicion_summary && (
            <p className="mb-4 whitespace-pre-wrap rounded bg-bg p-3 text-sm">
              <span className="font-medium">Why it was referred: </span>
              {c.suspicion_summary}
            </p>
          )}
          {fieldDefs.error || values.error ? (
            <ErrorState what="The intake fields" />
          ) : !c.template_id ? (
            <p className="text-sm text-text-muted">This case has no template, so it has no intake fields.</p>
          ) : intake.length === 0 ? (
            <p className="text-sm text-text-muted">The template has no intake fields.</p>
          ) : (
            <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-2 border-t border-border pt-4 text-sm">
              {intake.map((f, i) => {
                const heading = f.section && f.section !== intake[i - 1]?.section ? f.section : null;
                return (
                  <div key={f.key} className="contents">
                    {heading && <p className="col-span-2 mt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{heading}</p>}
                    <dt className="text-text-muted">{f.label}</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {f.value ?? <span className="text-text-muted">—</span>}
                      {f.source && f.source !== "email_parser" && (
                        <span className="ml-2 text-xs text-text-muted">({FIELD_SOURCE_LABELS[f.source as keyof typeof FIELD_SOURCE_LABELS] ?? f.source})</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </Card>

        <Card
          title="Field tasks"
          id="tasks-h"
          actions={
            <Link href={newTaskHref(c.case_ref)} className="text-sm text-primary underline hover:no-underline">
              Assign field task
            </Link>
          }
        >
          {tasks.error ? (
            <ErrorState what="The field tasks" />
          ) : (tasks.data ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">No field work yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(tasks.data ?? []).map((t) => {
                const p = progress.get(t.id);
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="font-medium">{t.title}</span>
                    <span className="text-text-muted">{TASK_KIND_LABELS[t.kind]}</span>
                    <span>{one(t.assignee)?.full_name ?? "Unassigned"}</span>
                    <StatusBadge kind="task_status" value={t.status} />
                    {p && (
                      <span className={p.mandatoryMissing ? "text-warning" : "text-text-muted"}>
                        Checklist {p.done}/{p.total}
                        {p.mandatoryMissing > 0 && ` · ${p.mandatoryMissing} required missing`}
                      </span>
                    )}
                    <span className="ml-auto text-text-muted">
                      {t.completed_at ? `Done ${formatRelativeDay(t.completed_at, now)}` : t.due_at ? `Due ${formatDate(t.due_at)}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {waiting.length > 0 && (
            <div className="mt-3 rounded bg-warning-soft p-3 text-sm text-warning">
              <p className="font-medium">Files still on phones</p>
              <ul className="mt-1 space-y-0.5">
                {waiting.map((o) => (
                  <li key={o.device_id}>
                    {o.full_name}
                    {!o.is_active && " (signed out)"}: {o.pending_count} {o.pending_count === 1 ? "file" : "files"} waiting · reported{" "}
                    {formatRelativeDay(o.reported_at, now)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Assignment" id="assign-h">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-muted">Owner</dt>
            <dd>{c.owner ? c.owner.full_name : <Badge tone="warning">Unassigned</Badge>}</dd>
            {c.office_assigned_at && (
              <>
                <dt className="text-text-muted">Since</dt>
                <dd>
                  {formatDateTime(c.office_assigned_at)}
                  {c.assignment_method && <span className="text-text-muted"> ({c.assignment_method === "auto" ? "automatic" : "by hand"})</span>}
                </dd>
              </>
            )}
            {c.orchestrator && (
              <>
                <dt className="text-text-muted">Orchestrator</dt>
                <dd>{c.orchestrator.full_name}</dd>
              </>
            )}
          </dl>

          {canReassign && !isTerminal(c.status) && (
            <div className="mt-4 space-y-3">
              {!c.office_owner_id && <RetryAssignButton caseId={c.id} caseRef={c.case_ref} action={retryAutoAssignAction} />}
              <ReassignForm caseId={c.id} caseRef={c.case_ref} options={options} action={reassignCaseAction} reasonMax={REASON_MAX} />
            </div>
          )}
          {!canReassign && <p className="mt-3 text-xs text-text-muted">Only an orchestrator or admin can reassign a case.</p>}

          <h3 className="mt-5 text-sm font-semibold">Recent assignments</h3>
          {assignments.error ? (
            <p className="mt-1 text-sm text-danger">Could not load the assignment history.</p>
          ) : (assignments.data ?? []).length === 0 ? (
            <p className="mt-1 text-sm text-text-muted">None yet.</p>
          ) : (
            <ol className="mt-2 space-y-2 text-sm">
              {(assignments.data ?? []).map((a) => (
                <li key={a.id}>
                  <span className="text-text-muted">{formatDateTime(a.assigned_at)} · </span>
                  {a.method === "auto" ? "Automatic" : (one(a.by)?.full_name ?? "Manual")} → {one(a.assignee)?.full_name ?? "staff"}
                  {a.reason && a.reason !== "Automatic assignment" && <span className="block text-text-muted">{a.reason}</span>}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-sm">
            <Link href={caseHref(c.case_ref, "history")} className="text-primary underline hover:no-underline">
              Full history
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
