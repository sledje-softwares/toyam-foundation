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
  rowActions,
  SUBMISSION_STATES,
  submissionState,
} from "@/lib/submissions";
import { canManageCase } from "@/lib/reports";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, type Column } from "@/components/ui";
import { AckDialog, ManualSubmissionDialog, ReopenDialog } from "@/components/submissions/submission-actions";
import { recordAcknowledgement, recordManualSubmission, reopenCase } from "./actions";

export const metadata = { title: "Submissions" };

const BASE = "/submissions";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST: ListConfig = {
  sortable: ["submitted_at"],
  defaultSort: { key: "submitted_at", dir: "desc" },
  filters: ["channel", "insurer", "ack"],
};

const SELECT =
  "id, case_id, submitted_at, channel, formats, to_addresses, cc_addresses, acknowledged_at, insurer_reference, ack_note, reopened_at, reopen_reason, cases!inner(case_ref, insurer_claim_no, status, insurer_id, office_owner_id, insurers(code, name)), reports(version), sender:profiles!submissions_submitted_by_fkey(full_name)";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v ? [v] : []) qs.append(k, x);
  const back = qs.toString() ? `${BASE}?${qs.toString()}` : BASE;
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
  const stateOf = (r: Row) => submissionState(r, one(r.cases)?.status ?? "submitted", latest.get(r.case_id));

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
          <span title={[r.insurer_reference ? `Insurer reference: ${r.insurer_reference}` : "", r.ack_note ?? ""].filter(Boolean).join("\n") || undefined}>
            {formatDate(r.acknowledged_at)}
          </span>
        ) : (
          <Badge tone="warning">Awaiting</Badge>
        ),
    },
    {
      key: "state",
      header: "State",
      cell: (r) => {
        const s = SUBMISSION_STATES[stateOf(r)];
        return (
          <span title={r.reopen_reason ? `${s.hint} Reason: ${r.reopen_reason}` : s.hint}>
            <Badge tone={s.tone}>{s.label}</Badge>
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      cell: (r) => {
        const c = one(r.cases);
        if (!c) return null;
        const can = rowActions({
          canManage: canManageCase(me.role, c.office_owner_id, me.id),
          acknowledged: !!r.acknowledged_at,
          state: stateOf(r),
          caseStatus: c.status,
        });
        if (!can.ack && !can.reopen) return <span className="text-text-muted">—</span>;
        return (
          <span className="flex flex-wrap gap-2">
            {can.ack && <AckDialog submissionId={r.id} caseRef={c.case_ref} back={back} action={recordAcknowledgement} />}
            {can.reopen && <ReopenDialog caseId={r.case_id} caseRef={c.case_ref} back={back} action={reopenCase} />}
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
          <span className="flex flex-wrap items-center gap-3">
            <Link href="/reports" className="text-sm text-primary underline hover:no-underline">
              Reports
            </Link>
            <ManualSubmissionDialog back={back} action={recordManualSubmission} />
          </span>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-text-muted">
        Every report sent to an insurer: when, how and to whom, and whether the insurer has acknowledged it. Record the
        insurer&apos;s acknowledgement, a report uploaded to a portal or delivered another way, or reopen a sent case on an
        insurer&apos;s query. Office staff act on the cases they own; orchestrators and admins on all.
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
