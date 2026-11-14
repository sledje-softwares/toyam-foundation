import { Suspense } from "react";
import Link from "next/link";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { applyListParams, escapeSearchTerm, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import { isReviewReason, REVIEW_REASON_KEYS, REVIEW_REASONS, reviewReason, templateLabel } from "@/lib/intake-review";
import { Badge, DataTable, EmptyState, ErrorState, FilterBar, Pagination, PageHeader, StatusBadge, type Column } from "@/components/ui";

export const metadata = { title: "Intake review" };

const BASE = "/intake";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST: ListConfig = {
  sortable: ["created_at"],
  // Oldest first: the queue is worked in arrival order.
  defaultSort: { key: "created_at", dir: "asc" },
  filters: ["insurer", "reason"],
  filterColumns: { insurer: "emails.insurer_id" },
};

const SELECT =
  "id, created_at, status, template_id, missing_required, parser_action, claim_no:extracted->>insurer_claim_no, emails!inner(id, subject, from_address, from_name, received_at, insurer_id, insurers(code, name)), case_templates(name, variant, version)";

export default async function IntakeQueuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const insurer = list.filters.insurer && GUID.test(list.filters.insurer) ? list.filters.insurer : null;
  const reason = isReviewReason(list.filters.reason) ? list.filters.reason : null;
  const term = escapeSearchTerm(list.q);

  const supabase = await createClient();

  // Search covers the email subject and the parsed claim number. They live in two tables, so matching
  // subjects are looked up first (bounded) and OR-ed with the claim number.
  let subjectIds: string[] = [];
  if (term) {
    const { data } = await supabase.from("emails").select("id").ilike("subject", `%${term}%`).limit(200);
    subjectIds = (data ?? []).map((r) => r.id);
  }

  let query = supabase.from("intake_extractions").select(SELECT, { count: "exact" }).eq("status", "pending_review");
  // Reason filter, in the precedence of reviewReason(). intake_ingest always sets parser_action
  // (coalesce(action, 'review')), so `neq` dropping NULLs loses nothing.
  if (reason === "reply_no_case") query = query.eq("parser_action", "attach_to_case");
  else if (reason) {
    query = query.neq("parser_action", "attach_to_case");
    if (reason === "no_template") query = query.is("template_id", null);
    else query = query.not("template_id", "is", null).filter("missing_required", reason === "missing_fields" ? "neq" : "eq", "{}");
  }
  if (term) {
    const claim = `extracted->>insurer_claim_no.ilike.*${term}*`;
    query = query.or(subjectIds.length ? `email_id.in.(${subjectIds.join(",")}),${claim}` : claim);
  }
  query = applyListParams(query, { ...list, filters: insurer ? { insurer } : {} }, LIST);

  const [{ data, count, error }, insurers] = await Promise.all([
    query,
    supabase.from("insurers").select("id, name").eq("is_active", true).order("name"),
  ]);

  const filtered = Boolean(term || insurer || reason);
  const rows = data ?? [];
  type Row = (typeof rows)[number];

  const columns: Column<Row>[] = [
    { key: "created_at", header: "Received", sortable: true, width: "w-40", cell: (r) => formatDateTime(r.emails.received_at) },
    { key: "insurer", header: "Insurer", cell: (r) => r.emails.insurers?.code ?? <span className="text-text-muted">Unknown</span> },
    {
      key: "sender",
      header: "Sender",
      cell: (r) => (
        <span className="block max-w-48 truncate" title={r.emails.from_address}>
          {r.emails.from_name || r.emails.from_address}
        </span>
      ),
    },
    {
      key: "subject",
      header: "Subject",
      cell: (r) => <span className="block max-w-80 truncate">{r.emails.subject || "(no subject)"}</span>,
    },
    {
      key: "template",
      header: "Template",
      cell: (r) => (r.case_templates ? templateLabel(r.case_templates) : <span className="text-text-muted">None detected</span>),
    },
    { key: "claim_no", header: "Claim no.", cell: (r) => (r.claim_no as string | null) || "—" },
    {
      key: "missing",
      header: "Missing",
      align: "right",
      cell: (r) => (r.missing_required.length ? <Badge tone="warning">{r.missing_required.length}</Badge> : "0"),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const why = REVIEW_REASONS[reviewReason(r)];
        return (
          <span className="flex flex-wrap gap-1">
            <StatusBadge kind="extraction_status" value={r.status} />
            <Badge tone={why.tone}>{why.label}</Badge>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Intake review"
        actions={
          <Link href="/intake/failed" className="text-sm text-primary underline hover:no-underline">
            Failed mail
          </Link>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-text-muted">
        Emails the parser could not turn into a case on its own: no matching template, missing required fields, or an
        uncertain match. Open one to check the values and create the case, or dismiss it.
      </p>
      <Suspense>
        <FilterBar
          searchLabel="Search subject or claim no."
          total={count ?? 0}
          filters={[
            { name: "insurer", label: "Insurer", options: (insurers.data ?? []).map((i) => ({ value: i.id, label: i.name })) },
            { name: "reason", label: "Reason", options: REVIEW_REASON_KEYS.map((k) => ({ value: k, label: REVIEW_REASONS[k].label })) },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="The intake queue" />
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
            caption="Emails awaiting intake review"
            empty={
              <EmptyState
                filtered={filtered}
                title="Nothing to review"
                description="New intimations that the parser can read completely become cases on their own."
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath={BASE} searchParams={sp} />
        </>
      )}
    </>
  );
}
