import { Suspense } from "react";
import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime } from "@/lib/format";
import { applyListParams, escapeSearchTerm, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  ACK_FILTERS,
  CHANNEL_KEYS,
  CHANNELS,
  formatsLabel,
  isAckFilter,
  isChannel,
  latestPerCase,
  recipientsSummary,
  SUBMISSION_STATES,
  submissionState,
} from "@/lib/submissions";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, type Column } from "@/components/ui";

export const metadata = { title: "Submissions" };

const BASE = "/submissions";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST: ListConfig = {
  sortable: ["submitted_at"],
  defaultSort: { key: "submitted_at", dir: "desc" },
  filters: ["channel", "insurer", "ack"],
};

const SELECT =
  "id, case_id, submitted_at, channel, formats, to_addresses, cc_addresses, acknowledged_at, insurer_reference, cases!inner(case_ref, insurer_claim_no, status, insurer_id, insurers(code, name)), reports(version), sender:profiles!submissions_submitted_by_fkey(full_name)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const channel = isChannel(list.filters.channel) ? list.filters.channel : null;
  const insurer = list.filters.insurer && GUID.test(list.filters.insurer) ? list.filters.insurer : null;
  const ack = isAckFilter(list.filters.ack) ? list.filters.ack : null;
  const term = escapeSearchTerm(list.q);

  const supabase = await createClient();
  let query = supabase.from("submissions").select(SELECT, { count: "exact" });
  if (channel) query = query.eq("channel", channel);
  if (insurer) query = query.eq("cases.insurer_id", insurer);
  if (ack === "acknowledged") query = query.not("acknowledged_at", "is", null);
  else if (ack === "awaiting") query = query.is("acknowledged_at", null);
  if (term) query = query.or(`case_ref.ilike.*${term}*,insurer_claim_no.ilike.*${term}*`, { referencedTable: "cases" });
  query = applyListParams(query, { ...list, filters: {} }, LIST);

  const [{ data, count, error }, insurers] = await Promise.all([
    query,
    supabase.from("insurers").select("id, name").eq("is_active", true).order("name"),
  ]);
  const rows = data ?? [];

  // "Superseded" needs every submission of the page's cases, not only the ones on this page.
  const caseIds = [...new Set(rows.map((r) => r.case_id))];
  const siblings = caseIds.length
    ? await supabase.from("submissions").select("id, case_id, submitted_at").in("case_id", caseIds).limit(2000)
    : null;
  const latest = latestPerCase(siblings?.data ?? rows);

  type Row = (typeof rows)[number];
  const filtered = Boolean(term || channel || insurer || ack);

  const columns: Column<Row>[] = [
    { key: "submitted_at", header: "Sent", sortable: true, width: "w-44", cell: (r) => formatDateTime(r.submitted_at) },
    {
      key: "case",
      header: "Case",
      cell: (r) => {
        const c = one(r.cases);
        return c ? (
          <Link href={`/reports/${encodeURIComponent(c.case_ref)}`} className="font-medium text-primary underline hover:no-underline">
            {c.case_ref}
          </Link>
        ) : (
          "—"
        );
      },
    },
    { key: "claim", header: "Claim no.", cell: (r) => one(r.cases)?.insurer_claim_no ?? "—" },
    {
      key: "insurer",
      header: "Insurer",
      cell: (r) => {
        const i = one(one(r.cases)?.insurers);
        return <span title={i?.name}>{i?.code ?? "—"}</span>;
      },
    },
    { key: "channel", header: "Channel", cell: (r) => CHANNELS[r.channel] },
    { key: "formats", header: "Formats", cell: (r) => formatsLabel(r.formats) },
    {
      key: "to",
      header: "Recipients",
      cell: (r) => {
        const s = recipientsSummary(r.to_addresses, r.cc_addresses);
        return (
          <span className="block max-w-48 truncate" title={s.full || undefined}>
            {s.short}
          </span>
        );
      },
    },
    { key: "version", header: "Version", align: "right", cell: (r) => (one(r.reports)?.version ? `v${one(r.reports)?.version}` : "—") },
    { key: "by", header: "Sent by", cell: (r) => one(r.sender)?.full_name ?? "—" },
    {
      key: "ack",
      header: "Acknowledged",
      cell: (r) =>
        r.acknowledged_at ? (
          <span title={r.insurer_reference ? `Insurer reference: ${r.insurer_reference}` : undefined}>{formatDate(r.acknowledged_at)}</span>
        ) : (
          <Badge tone="warning">Awaiting</Badge>
        ),
    },
    {
      key: "state",
      header: "State",
      cell: (r) => {
        const s = SUBMISSION_STATES[submissionState(r, one(r.cases)?.status ?? "submitted", latest.get(r.case_id))];
        return (
          <span title={s.hint}>
            <Badge tone={s.tone}>{s.label}</Badge>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Submissions"
        actions={
          <Link href="/reports" className="text-sm text-primary underline hover:no-underline">
            Reports
          </Link>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-text-muted">
        Every report sent to an insurer: when, how and to whom, and whether the insurer has acknowledged it. Reports are sent
        from the case&apos;s report page once approved; recording acknowledgements and reopening a case on an insurer&apos;s query
        are not built yet.
      </p>
      <Suspense>
        <FilterBar
          searchLabel="Search case ref or claim no."
          total={count ?? 0}
          filters={[
            { name: "channel", label: "Channel", options: CHANNEL_KEYS.map((k) => ({ value: k, label: CHANNELS[k] })) },
            { name: "insurer", label: "Insurer", options: (insurers.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
            { name: "ack", label: "Acknowledgement", options: (Object.keys(ACK_FILTERS) as (keyof typeof ACK_FILTERS)[]).map((k) => ({ value: k, label: ACK_FILTERS[k] })) },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="Submissions" />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            basePath={BASE}
            searchParams={sp}
            list={list}
            caption="Reports sent to insurers"
            empty={<EmptyState filtered={filtered} title="Nothing sent yet" description="Reports appear here once they are sent to the insurer." />}
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={BASE} searchParams={sp} />
        </>
      )}
    </>
  );
}
