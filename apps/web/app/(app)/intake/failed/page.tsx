import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import {
  failureReason,
  isStuck,
  REASON_LABELS,
  retryQueuedLabel,
  STATUS_FILTER_OPTIONS,
  statusesForFilter,
  truncateError,
} from "@/lib/failed-mail";
import { requestRetry } from "./actions";
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
  filters: ["reason", "status"],
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
  retry_attempts: number;
  retry_requested_at: string | null;
  retry_alerted_at: string | null;
};

const NOW = () => new Date();

const columns: Column<Row>[] = [
  { key: "received_at", header: "Received", sortable: true, cell: (r) => formatDateTime(r.received_at) },
  {
    key: "from_address",
    header: "Sender",
    sortable: true,
    cell: (r) => (r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address),
  },
  { key: "subject", mobile: "wide", header: "Subject", sortable: true, cell: (r) => r.subject || "—" },
  { key: "reason", header: "Failure", cell: (r) => REASON_LABELS[failureReason(r.error)] },
  { key: "attempts", header: "Attempts", cell: (r) => r.retry_attempts },
  {
    key: "error",
    mobile: "wide",
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
  {
    key: "status",
    mobile: "badge",
    header: "Status",
    cell: (r) => (
      <div className="space-y-1">
        <StatusBadge kind="email_status" value={r.status} />
        {r.status === "retry_requested" && <p className="text-xs text-text-muted">{retryQueuedLabel(r.retry_requested_at, NOW())}</p>}
      </div>
    ),
  },
  {
    key: "retry",
    mobile: "wide",
    header: "",
    cell: (r) => {
      const queued = r.status === "retry_requested";
      const noRaw = !r.raw_storage_path;
      return (
        <form action={requestRetry}>
          <input type="hidden" name="email_id" value={r.id} />
          <Button
            type="submit"
            variant="secondary"
            disabled={queued || noRaw}
            title={noRaw ? "The original message was not saved" : queued ? "Already queued" : undefined}
          >
            Retry
          </Button>
        </form>
      );
    },
  },
];

/** Stuck is judged on all failed/queued mail, not only the filtered page. */
async function hasStuck(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  const { data } = await supabase
    .from("emails")
    .select("status, retry_requested_at, retry_alerted_at")
    .in("status", ["failed", "retry_requested"])
    .or("retry_requested_at.not.is.null,retry_alerted_at.not.is.null");
  const now = new Date();
  return (data ?? []).some((r) => isStuck(r, now));
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(["orchestrator", "office", "admin"]);
  const sp = await searchParams;
  const list = parseListParams(sp, CONFIG);

  const supabase = await createClient();
  const { reason, status, ...rest } = list.filters;
  let query = supabase
    .from("emails")
    .select("id, received_at, from_address, from_name, subject, error, status, raw_storage_path, retry_attempts, retry_requested_at, retry_alerted_at", { count: "exact" })
    .in("status", statusesForFilter(status));
  query = applyListParams(query, { ...list, filters: rest }, CONFIG);
  if (reason === "parser") query = query.like("error", "parser:%");
  if (reason === "decode") query = query.not("error", "like", "parser:%");
  const { data, count, error } = await query;

  const stuck = !error && (await hasStuck(supabase));

  return (
    <div className="space-y-4">
      <PageHeader title="Failed mail" breadcrumbs={[{ label: "Intake", href: "/intake" }, { label: "Failed mail" }]} />
      {stuck && (
        <InlineAlert tone="danger" title="Retry stuck">
          A retry has not gone through after 1 hour. The intake worker may be down; tell the developer.
        </InlineAlert>
      )}
      <Suspense>
        <FilterBar
          total={count ?? undefined}
          searchLabel="Search sender, subject or error"
          filters={[
            { name: "status", label: "Status", allLabel: "All", options: STATUS_FILTER_OPTIONS },
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
