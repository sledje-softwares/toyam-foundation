import { Suspense } from "react";
import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatRelativeDay } from "@/lib/format";
import { applyListParams, buildHref, escapeSearchTerm, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  caseHref,
  DUE_FILTERS,
  dueBounds,
  isCaseRef,
  isDueFilter,
  isGuid,
  isTaskKind,
  OPEN_STATUSES,
  hasScopeChoice,
  parseScope,
  parseStatusFilter,
  progressLabel,
  TASK_KIND_LABELS,
  TASK_KINDS,
  type ChecklistRow,
} from "@/lib/tasks";
import { DueText, TaskKindBadge } from "@/components/tasks/task-badges";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, StatusBadge, type Column } from "@/components/ui";

export const metadata = { title: "Tasks" };

const BASE = "/tasks";

const LIST: ListConfig = {
  sortable: ["due_at", "created_at"],
  // Soonest due first; tasks without a due date come last.
  defaultSort: { key: "due_at", dir: "asc" },
  filters: ["operator", "kind"],
  filterColumns: { operator: "assignee_id" },
};

const SELECT =
  "id, title, kind, status, due_at, created_at, assignee_id, cases!inner(case_ref, insurer_claim_no, office_owner_id, insurers(code)), assignee:profiles!tasks_assignee_id_fkey(full_name, is_active)";

function first(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const status = parseStatusFilter(sp.status);
  const scope = parseScope(sp.scope, me.role);
  const due = isDueFilter(first(sp.due)) ? (first(sp.due) as keyof typeof DUE_FILTERS) : null;
  const caseRef = isCaseRef(first(sp.case)) ? first(sp.case) : null;
  const operator = isGuid(list.filters.operator) ? list.filters.operator : null;
  const kind = isTaskKind(list.filters.kind) ? list.filters.kind : null;
  const term = escapeSearchTerm(list.q);
  const now = new Date();

  const supabase = await createClient();

  // Search covers the task title and the case reference / claim number (another table): matching cases are looked up first (bounded).
  let caseIds: string[] = [];
  if (term) {
    const { data } = await supabase
      .from("cases")
      .select("id")
      .or(`case_ref.ilike.*${term}*,insurer_claim_no.ilike.*${term}*`)
      .limit(200);
    caseIds = (data ?? []).map((r) => r.id);
  }

  let query = supabase.from("tasks").select(SELECT, { count: "exact" });
  if (status.statuses) query = query.in("status", status.statuses);
  if (scope === "mine") query = query.eq("cases.office_owner_id", me.id);
  if (caseRef) query = query.eq("cases.case_ref", caseRef);
  if (due) {
    const b = dueBounds(due, now);
    if (b.openOnly) query = query.in("status", [...OPEN_STATUSES]);
    if (b.isNull) query = query.is("due_at", null);
    if (b.gte) query = query.gte("due_at", b.gte);
    if (b.lt) query = query.lt("due_at", b.lt);
  }
  if (term) {
    const title = `title.ilike.*${term}*`;
    query = query.or(caseIds.length ? `case_id.in.(${caseIds.join(",")}),${title}` : title);
  }
  query = applyListParams(query, { ...list, filters: { ...(operator && { operator }), ...(kind && { kind }) } }, LIST);

  const [{ data, count, error }, operators] = await Promise.all([
    query,
    supabase.from("profiles").select("id, full_name, is_active").eq("role", "field").order("full_name").limit(500),
  ]);

  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const checklist = new Map<string, ChecklistRow[]>();
  if (ids.length) {
    const { data: items } = await supabase.from("v_case_checklist").select("task_id, status, is_mandatory, evidence_count").in("task_id", ids);
    for (const i of items ?? []) {
      const l = checklist.get(i.task_id) ?? [];
      l.push(i);
      checklist.set(i.task_id, l);
    }
  }

  type Row = (typeof rows)[number];
  const filtered = Boolean(term || operator || kind || due || caseRef || status.value || (hasScopeChoice(me.role) && first(sp.scope)));

  const columns: Column<Row>[] = [
    { key: "title", header: "Task", cell: (r) => <span className="block max-w-72 truncate">{r.title}</span> },
    {
      key: "case",
      header: "Case",
      cell: (r) => (
        <span className="block">
          <Link href={caseHref(r.cases.case_ref)} className="text-primary underline hover:no-underline">
            {r.cases.case_ref}
          </Link>
          <span className="block text-xs text-text-muted">
            {[r.cases.insurers?.code, r.cases.insurer_claim_no].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (r) => <TaskKindBadge kind={r.kind} />,
    },
    {
      key: "operator",
      header: "Operator",
      cell: (r) =>
        r.assignee ? (
          <span className="flex flex-wrap items-center gap-1">
            {r.assignee.full_name}
            {!r.assignee.is_active && <Badge>Inactive</Badge>}
          </span>
        ) : (
          <span className="text-text-muted">Unassigned</span>
        ),
    },
    { key: "status", header: "Status", cell: (r) => <StatusBadge kind="task_status" value={r.status} /> },
    {
      key: "due_at",
      header: "Due",
      sortable: true,
      width: "w-44",
      cell: (r) => <DueText task={r} now={now} />,
    },
    { key: "checklist", header: "Checklist", align: "right", cell: (r) => progressLabel(checklist.get(r.id)) ?? "—" },
    { key: "created_at", header: "Assigned", sortable: true, cell: (r) => formatRelativeDay(r.created_at, now) },
  ];

  // Office staff see only their own cases' tasks (D44, RLS), so they get no scope filter.
  const scopeFilter = hasScopeChoice(me.role)
    ? [{ name: "scope", label: "Cases", allLabel: "All cases", options: [{ value: "mine", label: "My cases" }] }]
    : [];

  return (
    <>
      <PageHeader title="Tasks" />
      <p className="mb-4 max-w-3xl text-sm text-text-muted">
        Field work on cases. Assign new field work or a re-investigation from the case.
      </p>
      <Suspense>
        <FilterBar
          searchLabel="Search task, case ref or claim no."
          total={count ?? 0}
          filters={[
            {
              name: "status",
              label: "Status",
              allLabel: "Open",
              options: [
                { value: "pending", label: "Pending" },
                { value: "in_progress", label: "In progress" },
                { value: "completed", label: "Completed" },
                { value: "cancelled", label: "Cancelled" },
                { value: "all", label: "All" },
              ],
            },
            {
              name: "operator",
              label: "Operator",
              options: (operators.data ?? []).map((o) => ({ value: o.id, label: o.is_active ? o.full_name : `${o.full_name} (inactive)` })),
            },
            { name: "due", label: "Due", options: Object.entries(DUE_FILTERS).map(([value, label]) => ({ value, label })) },
            { name: "kind", label: "Kind", options: TASK_KINDS.map((k) => ({ value: k, label: TASK_KIND_LABELS[k].label })) },
            ...scopeFilter,
          ]}
        />
      </Suspense>
      {caseRef && (
        <p className="mb-3 text-sm">
          Showing tasks of case <span className="font-medium">{caseRef}</span> ·{" "}
          <Link href={buildHref(BASE, sp, { case: null })} className="text-primary underline hover:no-underline">
            Show all cases
          </Link>
        </p>
      )}
      {error ? (
        <ErrorState what="Tasks" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => `${BASE}/${r.id}`}
            basePath={BASE}
            searchParams={sp}
            list={list}
            caption="Field tasks"
            empty={
              <EmptyState
                filtered={filtered}
                title="No open field tasks"
                description="Field work is assigned from a case. New tasks appear here."
                action={{ label: "Go to cases", href: "/cases" }}
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={BASE} searchParams={sp} />
        </>
      )}
    </>
  );
}
