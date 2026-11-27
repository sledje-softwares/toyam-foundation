import { Suspense } from "react";
import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { applyListParams, buildHref, escapeSearchTerm, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  CASE_STATUSES,
  caseHref,
  DUE_FILTERS,
  dueConditions,
  dueState,
  isGuid,
  OPEN_STATUSES,
  parseDueFilter,
  parseOwnerFilter,
  parseStatusFilter,
} from "@/lib/cases";
import { CLAIM_TYPE_LABELS, CLAIM_TYPES, isClaimType } from "@/lib/checklists";
import { STATUS_MAPS } from "@/components/ui/badge";
import { Badge, ButtonLink, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, StatusBadge, type Column } from "@/components/ui";

export const metadata = { title: "Cases" };

const BASE = "/cases";
const INSURED_KEY = "insured_name";

const LIST: ListConfig = {
  sortable: ["due_at", "received_at", "case_ref"],
  // Most urgent first; cases without a due date sort last.
  defaultSort: { key: "due_at", dir: "asc" },
  filters: ["insurer", "claim_type"],
  filterColumns: { insurer: "insurer_id" },
};

const SELECT =
  "id, case_ref, insurer_claim_no, claim_type, status, received_at, due_at, insurers(code, name), owner:profiles!cases_office_owner_id_fkey(full_name)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function CasesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const status = parseStatusFilter(sp.status);
  // D44: office staff see only the cases assigned to them (RLS), so the owner filter is for orchestrators and admins.
  const ownerChoice = me.role !== "office";
  const owner = ownerChoice ? parseOwnerFilter(sp.owner) : null;
  const due = parseDueFilter(sp.due);
  const insurer = isGuid(list.filters.insurer) ? list.filters.insurer : null;
  const claimType = isClaimType(list.filters.claim_type) ? list.filters.claim_type : null;
  const term = escapeSearchTerm(list.q);
  const now = new Date();

  const supabase = await createClient();

  // Search: case ref and claim number on cases; the insured name is a template field value, looked up first (bounded).
  let insuredIds: string[] = [];
  if (term) {
    const { data } = await supabase
      .from("case_field_values")
      .select("case_id, case_template_fields!inner(key)")
      .eq("case_template_fields.key", INSURED_KEY)
      .ilike("value", `%${term}%`)
      .limit(200);
    insuredIds = [...new Set((data ?? []).map((r) => r.case_id))];
  }

  let query = supabase.from("cases").select(SELECT, { count: "exact" });
  if (status.kind === "open") query = query.in("status", OPEN_STATUSES);
  else if (status.kind === "one") query = query.eq("status", status.status);
  if (owner?.kind === "me") query = query.eq("office_owner_id", me.id);
  else if (owner?.kind === "none") query = query.is("office_owner_id", null);
  else if (owner?.kind === "user") query = query.eq("office_owner_id", owner.id);
  if (due) {
    const d = dueConditions(due, now);
    if (d.openOnly) query = query.in("status", OPEN_STATUSES);
    for (const cond of d.conditions) {
      if (cond.op === "is_null") query = query.is("due_at", null);
      else if (cond.op === "lt") query = query.lt("due_at", cond.value);
      else if (cond.op === "lte") query = query.lte("due_at", cond.value);
      else if (cond.op === "gt") query = query.gt("due_at", cond.value);
      else query = query.gte("due_at", cond.value);
    }
  }
  if (term) {
    const own = `case_ref.ilike.*${term}*,insurer_claim_no.ilike.*${term}*`;
    query = query.or(insuredIds.length ? `${own},id.in.(${insuredIds.join(",")})` : own);
  }
  const filters: Record<string, string> = {};
  if (insurer) filters.insurer = insurer;
  if (claimType) filters.claim_type = claimType;
  query = applyListParams(query, { ...list, filters }, LIST);

  const [{ data, count, error }, insurers, staff] = await Promise.all([
    query,
    supabase.from("insurers").select("id, name").order("name"),
    ownerChoice
      ? supabase.from("profiles").select("id, full_name, is_active").in("role", ["admin", "orchestrator", "office"]).order("full_name")
      : Promise.resolve({ data: [] as { id: string; full_name: string; is_active: boolean }[] }),
  ]);

  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const insured = new Map<string, string>();
  if (ids.length) {
    const { data: names } = await supabase
      .from("case_field_values")
      .select("case_id, value, case_template_fields!inner(key)")
      .in("case_id", ids)
      .eq("case_template_fields.key", INSURED_KEY);
    for (const n of names ?? []) if (n.value) insured.set(n.case_id, n.value);
  }

  type Row = (typeof rows)[number];
  const allColumns: Column<Row>[] = [
    { key: "case_ref", header: "Case ref", sortable: true, cell: (r) => r.case_ref },
    { key: "insurer", header: "Insurer", cell: (r) => one(r.insurers)?.code ?? "—" },
    { key: "claim_no", header: "Claim no.", cell: (r) => <span className="block max-w-40 truncate">{r.insurer_claim_no}</span> },
    {
      key: "insured",
      header: "Insured",
      cell: (r) => <span className="block max-w-48 truncate">{insured.get(r.id) ?? <span className="text-text-muted">—</span>}</span>,
    },
    { key: "claim_type", header: "Type", cell: (r) => CLAIM_TYPE_LABELS[r.claim_type] },
    { key: "status", mobile: "badge", header: "Status", cell: (r) => <StatusBadge kind="case_status" value={r.status} /> },
    {
      key: "owner",
      header: "Owner",
      cell: (r) => one(r.owner)?.full_name ?? <Badge tone="warning">Unassigned</Badge>,
    },
    { key: "received_at", header: "Received", sortable: true, cell: (r) => formatDate(r.received_at) },
    {
      key: "due_at",
      header: "Due",
      sortable: true,
      cell: (r) => {
        const d = dueState(r.due_at, r.status, now);
        return (
          <span className="flex flex-wrap items-center gap-2">
            {formatDate(r.due_at)}
            {d.kind !== "done" && d.kind !== "none" && <Badge tone={d.tone}>{d.label}</Badge>}
          </span>
        );
      },
    },
  ];

  // Every case an office user sees is their own, so the owner column says nothing new.
  const columns = ownerChoice ? allColumns : allColumns.filter((c) => c.key !== "owner");

  const filtered = Boolean(term || insurer || claimType || owner || due || status.kind !== "open");
  const mine = owner?.kind === "me";

  return (
    <>
      <PageHeader
        title="Cases"
        actions={
          <>
            {ownerChoice && (
              <Link
                href={buildHref(BASE, sp, { owner: mine ? null : "me" })}
                aria-pressed={mine}
                className="text-sm text-primary underline hover:no-underline"
              >
                {mine ? "Show everyone's cases" : "Show my cases"}
              </Link>
            )}
            <ButtonLink href="/cases/new">New case</ButtonLink>
          </>
        }
      />
      {!ownerChoice && (
        <p className="mb-4 max-w-3xl text-sm text-text-muted">Cases assigned to you. An orchestrator assigns and reassigns cases.</p>
      )}
      <Suspense>
        <FilterBar
          searchLabel="Search ref, claim no. or insured"
          total={count ?? 0}
          filters={[
            {
              name: "status",
              label: "Status",
              allLabel: "Open",
              options: [
                ...CASE_STATUSES.filter((s) => s !== "intake_confirmed").map((s) => ({ value: s, label: STATUS_MAPS.case_status[s].label })),
                { value: "all", label: "All statuses" },
              ],
            },
            { name: "insurer", label: "Insurer", options: (insurers.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
            { name: "claim_type", label: "Claim type", options: CLAIM_TYPES.map((t) => ({ value: t, label: CLAIM_TYPE_LABELS[t] })) },
            ...(ownerChoice
              ? [
                  {
                    name: "owner",
                    label: "Owner",
                    options: [
                      { value: "me", label: "Me" },
                      { value: "none", label: "Unassigned" },
                      ...(staff.data ?? [])
                        .filter((p) => p.id !== me.id)
                        .map((p) => ({ value: p.id, label: p.is_active ? p.full_name : `${p.full_name} (inactive)` })),
                    ],
                  },
                ]
              : []),
            { name: "due", label: "Due", options: Object.entries(DUE_FILTERS).map(([value, label]) => ({ value, label })) },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="The case list" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => caseHref(r.case_ref)}
            basePath={BASE}
            searchParams={sp}
            list={list}
            caption="Cases"
            empty={
              <EmptyState
                filtered={filtered}
                title="No open cases"
                description="Cases are created from insurer emails, on their own or from the intake review."
                action={{ label: "Intake review", href: "/intake" }}
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={BASE} searchParams={sp} />
        </>
      )}
    </>
  );
}
