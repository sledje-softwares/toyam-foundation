import { Suspense } from "react";
import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { applyListParams, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  APPROVAL_DECISIONS,
  dueLabel,
  isReportStage,
  latestApproval,
  LISTED_STATUSES,
  REPORT_STAGE_KEYS,
  REPORT_STAGES,
  reportStage,
  STAGE_STATUSES,
  sumProgress,
} from "@/lib/reports";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, type Column } from "@/components/ui";

export const metadata = { title: "Reports" };

const BASE = "/reports";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches no case: keeps "Awaiting approval" empty when nothing is pending. */
const NO_ID = "00000000-0000-0000-0000-000000000000";

const LIST: ListConfig = {
  sortable: ["case_ref", "due_at", "updated_at"],
  // Nearest turnaround first.
  defaultSort: { key: "due_at", dir: "asc" },
  filters: ["stage", "insurer", "owner"],
  searchColumns: ["case_ref", "insurer_claim_no"],
};

const SELECT =
  "id, case_ref, insurer_claim_no, status, due_at, updated_at, office_owner_id, insurers(code, name), owner:profiles!cases_office_owner_id_fkey(full_name), report_approvals(decision, requested_at), reports(version)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const stage = isReportStage(list.filters.stage) ? list.filters.stage : null;
  const insurer = list.filters.insurer && GUID.test(list.filters.insurer) ? list.filters.insurer : null;
  const ownerParam = list.filters.owner ?? "";
  const owner = ownerParam === "me" ? me.id : ownerParam === "none" || GUID.test(ownerParam) ? ownerParam : null;

  const supabase = await createClient();

  // Awaiting vs approved share the status orchestrator_review; they differ by a pending approval (few rows).
  let pendingIds: string[] = [];
  if (stage === "awaiting_approval" || stage === "approved") {
    const { data } = await supabase.from("report_approvals").select("case_id").eq("decision", "pending").limit(1000);
    pendingIds = [...new Set((data ?? []).map((r) => r.case_id))];
  }

  let query = supabase.from("cases").select(SELECT, { count: "exact" }).not("template_id", "is", null);
  if (!stage) query = query.in("status", LISTED_STATUSES);
  else if (stage === "awaiting_approval") query = query.eq("status", "orchestrator_review").in("id", pendingIds.length ? pendingIds : [NO_ID]);
  else if (stage === "approved") {
    query = query.eq("status", "orchestrator_review");
    if (pendingIds.length) query = query.not("id", "in", `(${pendingIds.join(",")})`);
  } else query = query.in("status", STAGE_STATUSES[stage]);
  if (insurer) query = query.eq("insurer_id", insurer);
  if (owner === "none") query = query.is("office_owner_id", null);
  else if (owner) query = query.eq("office_owner_id", owner);
  query = applyListParams(query, { ...list, filters: {} }, LIST);

  const [{ data, count, error }, insurers, staff] = await Promise.all([
    query,
    supabase.from("insurers").select("id, name").eq("is_active", true).order("name"),
    supabase.from("profiles").select("id, full_name").in("role", ["office", "admin"]).eq("is_active", true).order("full_name"),
  ]);

  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const [progressRes, insuredRes] = ids.length
    ? await Promise.all([
        supabase.from("v_report_progress").select("case_id, required_total, required_filled, fields_total, fields_filled").in("case_id", ids).limit(5000),
        supabase.from("case_field_values").select("case_id, value, case_template_fields!inner(key)").in("case_id", ids).eq("case_template_fields.key", "insured_name"),
      ])
    : [null, null];
  const progress = sumProgress(progressRes?.data ?? []);
  const insured = new Map((insuredRes?.data ?? []).map((r) => [r.case_id, r.value]));

  type Row = (typeof rows)[number];
  const filtered = Boolean(list.q || stage || insurer || owner);

  const columns: Column<Row>[] = [
    { key: "case_ref", header: "Case", sortable: true, width: "w-40", cell: (r) => r.case_ref },
    { key: "insurer", header: "Insurer", cell: (r) => <span title={one(r.insurers)?.name}>{one(r.insurers)?.code ?? "—"}</span> },
    { key: "claim", header: "Claim no.", cell: (r) => r.insurer_claim_no },
    {
      key: "insured",
      header: "Insured",
      cell: (r) => <span className="block max-w-48 truncate">{insured.get(r.id) || <span className="text-text-muted">—</span>}</span>,
    },
    { key: "owner", header: "Owner", cell: (r) => one(r.owner)?.full_name ?? <span className="text-text-muted">Unassigned</span> },
    {
      key: "due_at",
      header: "Due",
      sortable: true,
      cell: (r) => {
        const due = dueLabel(r.due_at);
        const sent = (STAGE_STATUSES.sent as string[]).includes(r.status);
        return (
          <span className="flex flex-wrap items-center gap-1">
            {formatDate(r.due_at)}
            {due?.overdue && !sent && <Badge tone="danger">Overdue</Badge>}
          </span>
        );
      },
    },
    {
      key: "required",
      header: "Required filled",
      align: "right",
      cell: (r) => {
        const p = progress.get(r.id);
        if (!p) return "—";
        return (
          <span className={`tabular-nums ${p.requiredFilled < p.requiredTotal ? "" : "text-success"}`}>
            {p.requiredFilled} / {p.requiredTotal}
          </span>
        );
      },
    },
    {
      key: "version",
      header: "Version",
      align: "right",
      cell: (r) => {
        const v = Math.max(0, ...(r.reports ?? []).map((x) => x.version));
        return v ? `v${v}` : <span className="text-text-muted">—</span>;
      },
    },
    {
      key: "stage",
      header: "Stage",
      cell: (r) => {
        const s = reportStage(r.status, r.report_approvals);
        const last = latestApproval(r.report_approvals);
        return (
          <span className="flex flex-wrap gap-1">
            {s ? <Badge tone={REPORT_STAGES[s].tone}>{REPORT_STAGES[s].label}</Badge> : "—"}
            {s === "in_progress" && last?.decision === "changes_requested" && (
              <Badge tone={APPROVAL_DECISIONS.changes_requested.tone}>{APPROVAL_DECISIONS.changes_requested.label}</Badge>
            )}
          </span>
        );
      },
    },
    { key: "updated_at", header: "Updated", sortable: true, cell: (r) => formatDate(r.updated_at) },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        actions={
          <Link href="/submissions" className="text-sm text-primary underline hover:no-underline">
            Submissions
          </Link>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-text-muted">
        One report per case, filled from the case&apos;s template. Open a case to fill its sections with the relevant files beside
        them, then request approval and send.
      </p>
      <Suspense>
        <FilterBar
          searchLabel="Search case ref or claim no."
          total={count ?? 0}
          filters={[
            { name: "stage", label: "Stage", options: REPORT_STAGE_KEYS.map((k) => ({ value: k, label: REPORT_STAGES[k].label })) },
            { name: "insurer", label: "Insurer", options: (insurers.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
            {
              name: "owner",
              label: "Owner",
              options: [
                { value: "me", label: "Mine" },
                { value: "none", label: "Unassigned" },
                ...(staff.data ?? []).filter((p) => p.id !== me.id).map((p) => ({ value: p.id, label: p.full_name })),
              ],
            },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="Reports" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => `${BASE}/${encodeURIComponent(r.case_ref)}`}
            basePath={BASE}
            searchParams={sp}
            list={list}
            caption="Reports by case"
            empty={
              <EmptyState
                filtered={filtered}
                title="No reports yet"
                description="Cases appear here as soon as intake creates them; their report starts pre-filled from the insurer's email."
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={BASE} searchParams={sp} />
        </>
      )}
    </>
  );
}
