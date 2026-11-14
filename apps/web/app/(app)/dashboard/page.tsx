import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatRelativeDay } from "@/lib/format";
import {
  BUCKET_TO_CASES_DUE,
  operatorTasksLink,
  ageingByInsurer,
  BUCKETS,
  casesLink,
  CLOSED_STATUS_LIST,
  ESCALATION_KINDS,
  formatDuration,
  OWNER_NONE,
  overdueTotal,
  ROW_CAP,
  stageTurnaround,
  totalBuckets,
  workload,
} from "@/lib/dashboard";
import { Badge, PageHeader, STATUS_MAPS } from "@/components/ui";
import { Empty, Section, SectionError, StatTile, WorkloadList } from "@/components/dashboard/blocks";

export const metadata = { title: "Dashboard" };
// Numbers must be current; the page reads per request under the user's session.
export const dynamic = "force-dynamic";

const HISTORY_DAYS = 90;

export default async function DashboardPage() {
  await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const now = new Date();
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  const head = { count: "exact", head: true } as const;

  const [
    openCases,
    intake,
    failedMail,
    approvals,
    openTasks,
    office,
    field,
    insurers,
    history,
    escalations,
  ] = await Promise.all([
    supabase.from("cases").select("id, insurer_id, due_at, office_owner_id").not("status", "in", CLOSED_STATUS_LIST).limit(ROW_CAP),
    supabase.from("intake_extractions").select("id", head).eq("status", "pending_review"),
    supabase.from("emails").select("id", head).in("status", ["failed", "retry_requested"]),
    supabase.from("report_approvals").select("id", head).eq("decision", "pending"),
    supabase.from("tasks").select("assignee_id").in("status", ["pending", "in_progress"]).limit(ROW_CAP),
    supabase.from("profiles").select("id, full_name").eq("role", "office").eq("is_active", true).order("full_name"),
    supabase.from("profiles").select("id, full_name").eq("role", "field").eq("is_active", true).order("full_name"),
    supabase.from("insurers").select("id, name"),
    supabase
      .from("case_status_history")
      .select("case_id, to_status, changed_at")
      .gte("changed_at", since)
      .order("changed_at", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("notifications")
      .select("id, kind, title, created_at, read_at, cases(case_ref)")
      .in("kind", [...ESCALATION_KINDS])
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const cases = openCases.data ?? [];
  const ageing = openCases.error ? [] : ageingByInsurer(cases, insurers.data ?? [], now);
  const totals = totalBuckets(ageing);
  const overdue = openCases.error ? null : overdueTotal(totals);
  const officeRows = workload(cases.map((c) => c.office_owner_id), office.data ?? [], "Unassigned");
  const fieldRows = workload((openTasks.data ?? []).map((t) => t.assignee_id), field.data ?? []);
  const stages = stageTurnaround(history.data ?? []);
  const partial =
    cases.length >= ROW_CAP || (openTasks.data?.length ?? 0) >= ROW_CAP || (history.data?.length ?? 0) >= ROW_CAP;

  return (
    <>
      <PageHeader title="Dashboard" />
      {partial && (
        <p role="status" className="mb-4 rounded border border-amber-300 bg-warning-soft px-3 py-2 text-sm text-warning">
          Some figures are partial: a read reached {ROW_CAP.toLocaleString("en-IN")} rows.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Open cases" count={openCases.error ? null : cases.length} href={casesLink()} />
        <StatTile
          label="Awaiting intake review"
          count={intake.error ? null : (intake.count ?? 0)}
          href="/intake"
          tone="warning"
        />
        <StatTile
          label="Failed mail"
          count={failedMail.error ? null : (failedMail.count ?? 0)}
          href="/intake/failed"
          tone="danger"
        />
        <StatTile
          label="Overdue vs TAT"
          count={overdue}
          href={casesLink({ due: "overdue" })}
          tone="danger"
          hint="Past the due date"
        />
        <StatTile
          label="Reports awaiting approval"
          count={approvals.error ? null : (approvals.count ?? 0)}
          href="/reports?approval=pending"
          tone="warning"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section title="Workload: office staff" note="Open cases">
          {office.error || openCases.error ? (
            <SectionError what="Workload" />
          ) : officeRows.length === 0 ? (
            <Empty>No office staff yet.</Empty>
          ) : (
            <WorkloadList
              rows={officeRows}
              unit="Open cases"
              hrefFor={(id) => casesLink({ owner: id ?? OWNER_NONE })}
            />
          )}
        </Section>
        <Section title="Workload: field operators" note="Open tasks (pending or in progress)">
          {field.error || openTasks.error ? (
            <SectionError what="Workload" />
          ) : fieldRows.length === 0 ? (
            <Empty>No field operators yet.</Empty>
          ) : (
            <WorkloadList
              rows={fieldRows}
              unit="Open tasks"
              hrefFor={operatorTasksLink}
            />
          )}
        </Section>
      </div>

      <Section title="Ageing vs TAT" note="Open cases by insurer, due date compared with today (IST)" className="mt-4">
        {openCases.error ? (
          <SectionError what="Ageing" />
        ) : ageing.length === 0 ? (
          <Empty>No open cases.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Insurer
                  </th>
                  {BUCKETS.map((b) => (
                    <th key={b.key} scope="col" className="px-2 py-1 text-right font-medium">
                      {b.label}
                    </th>
                  ))}
                  <th scope="col" className="py-1 pl-2 text-right font-medium">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {ageing.map((r) => (
                  <tr key={r.insurerId} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2">{r.name}</td>
                    {BUCKETS.map((b) => (
                      <td key={b.key} className="px-2 py-1.5 text-right">
                        {r.counts[b.key] > 0 ? (
                          <Link
                            href={casesLink({ due: BUCKET_TO_CASES_DUE[b.key], insurer: r.insurerId })}
                            className={`underline hover:no-underline ${
                              b.key === "3plus" ? "font-medium text-danger" : b.key === "1-2" ? "text-warning" : "text-primary"
                            }`}
                          >
                            {r.counts[b.key]}
                          </Link>
                        ) : (
                          <span className="text-text-muted">0</span>
                        )}
                      </td>
                    ))}
                    <td className="py-1.5 pl-2 text-right font-medium">{r.total}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-300 font-medium">
                  <td className="py-1.5 pr-2">All insurers</td>
                  {BUCKETS.map((b) => (
                    <td key={b.key} className="px-2 py-1.5 text-right">
                      {totals[b.key]}
                    </td>
                  ))}
                  <td className="py-1.5 pl-2 text-right">{cases.length}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Recent escalations" note="Alerts sent to you">
          {escalations.error ? (
            <SectionError what="Escalations" />
          ) : (escalations.data ?? []).length === 0 ? (
            <Empty>No escalations.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {(escalations.data ?? []).map((n) => {
                const ref = n.cases?.case_ref;
                const href = ref ? `/cases/${encodeURIComponent(ref)}` : n.kind === "intake_retry_stuck" ? "/intake/failed" : casesLink();
                return (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <Link href={href} className="text-primary underline hover:no-underline">
                      {n.title}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-text-muted">
                      {!n.read_at && <Badge tone="warning">New</Badge>}
                      {formatRelativeDay(n.created_at, now)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Turnaround per stage" note={`Time spent in a status, last ${HISTORY_DAYS} days`}>
          {history.error ? (
            <SectionError what="Turnaround" />
          ) : stages.length === 0 ? (
            <Empty>No completed stages yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Stage
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    Stays
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">
                    Median
                  </th>
                  <th scope="col" className="py-1 pl-2 text-right font-medium">
                    Mean
                  </th>
                </tr>
              </thead>
              <tbody>
                {stages.map((s) => (
                  <tr key={s.stage} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2">
                      {(STATUS_MAPS.case_status as Record<string, { label: string }>)[s.stage]?.label ?? s.stage}
                    </td>
                    <td className="px-2 py-1.5 text-right">{s.cases}</td>
                    <td className="px-2 py-1.5 text-right">{formatDuration(s.medianMs)}</td>
                    <td className="py-1.5 pl-2 text-right">{formatDuration(s.meanMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title="Model cost vs monthly budget" note="After 6.10" className="mt-4">
        <Empty>Token and cost recording is not built yet. This tile will show this month&apos;s spend against the budget, with an alert at 80 %.</Empty>
      </Section>
    </>
  );
}
