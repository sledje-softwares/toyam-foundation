import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { failureReason, REASON_LABELS, truncateError } from "@/lib/failed-mail";
import { applyListParams, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  InlineAlert,
  PageHeader,
  Pagination,
  StatusBadge,
  type Column,
} from "@/components/ui";

export const metadata = { title: "Failed mail" };

const CONFIG: ListConfig = {
  sortable: ["received_at", "from_address", "subject"],
  defaultSort: { key: "received_at", dir: "desc" },
  filters: ["reason"],
  searchColumns: ["from_address", "subject", "error"],
};

type Row = {
  id: string;
  received_at: string;
  from_address: string;
  from_name: string | null;
  subject: string | null;
  error: string | null;
  status: string;
  raw_storage_path: string | null;
};

const columns: Column<Row>[] = [
  { key: "received_at", header: "Received", sortable: true, cell: (r) => formatDateTime(r.received_at) },
  {
    key: "from_address",
    header: "Sender",
    sortable: true,
    cell: (r) => (r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address),
  },
  { key: "subject", header: "Subject", sortable: true, cell: (r) => r.subject || "—" },
  { key: "reason", header: "Failure", cell: (r) => REASON_LABELS[failureReason(r.error)] },
  { key: "attempts", header: "Attempts", cell: () => "—" },
  {
    key: "error",
    header: "Last error",
    cell: (r) => (
      <details>
        <summary className="cursor-pointer">{truncateError(r.error)}</summary>
        <pre className="mt-2 max-w-xl whitespace-pre-wrap break-words text-xs">{r.error ?? "—"}</pre>
        <p className="mt-1 text-xs text-text-muted">
          {r.raw_storage_path ? "Original message saved — can be retried." : "Original message not saved — cannot be retried."}
        </p>
      </details>
    ),
  },
  { key: "status", header: "Status", cell: (r) => <StatusBadge kind="email_status" value={r.status} /> },
  {
    key: "retry",
    header: "",
    cell: () => (
      <Button variant="secondary" disabled title="Retry needs the intake secret; not available from the browser">
        Retry
      </Button>
    ),
  },
];

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(["orchestrator", "office", "admin"]);
  const sp = await searchParams;
  const list = parseListParams(sp, CONFIG);

  const supabase = await createClient();
  const { reason, ...rest } = list.filters;
  let query = supabase
    .from("emails")
    .select("id, received_at, from_address, from_name, subject, error, status, raw_storage_path", { count: "exact" })
    .eq("status", "failed");
  query = applyListParams(query, { ...list, filters: rest }, CONFIG);
  if (reason === "parser") query = query.like("error", "parser:%");
  if (reason === "decode") query = query.not("error", "like", "parser:%");
  const { data, count, error } = await query;

  return (
    <div className="space-y-4">
      <PageHeader title="Failed mail" breadcrumbs={[{ label: "Intake", href: "/intake" }, { label: "Failed mail" }]} />
      <InlineAlert tone="info" title="Retry is not available from the browser yet">
        Retrying needs <code>intake_retry()</code> and then a re-post of the stored message to the intake function with the
        intake secret, which the web app must not hold. Until a safe route exists, ask the developer to retry. The stored
        message path is shown in each row&apos;s details.
      </InlineAlert>
      <Suspense>
        <FilterBar
          total={count ?? undefined}
          searchLabel="Search sender, subject or error"
          filters={[
            {
              name: "reason",
              label: "Reason",
              allLabel: "All reasons",
              options: [
                { value: "parser", label: REASON_LABELS.parser },
                { value: "decode", label: REASON_LABELS.decode },
              ],
            },
          ]}
        />
      </Suspense>
      {error ? (
        <ErrorState what="failed mail" />
      ) : (
        <>
          <DataTable<Row>
            caption="Failed incoming emails"
            columns={columns}
            rows={(data ?? []) as Row[]}
            rowKey={(r) => r.id}
            basePath="/intake/failed"
            searchParams={sp}
            list={list}
            empty={
              <EmptyState
                title="No failed mail"
                description="Every incoming email was read successfully."
                filtered={Object.keys(list.filters).length > 0 || !!list.q}
              />
            }
          />
          <Pagination page={list.page} pageSize={list.pageSize} total={count ?? 0} basePath="/intake/failed" searchParams={sp} />
        </>
      )}
    </div>
  );
}
