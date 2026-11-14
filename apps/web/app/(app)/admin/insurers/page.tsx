import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import { filterInsurers, INSURER_SORT_KEYS, parseInsurerStatus, sortInsurers, type InsurerRow } from "@/lib/insurers-list";
import { Badge, ButtonLink, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, type Column } from "@/components/ui";

export const metadata = { title: "Insurers" };

const BASE = "/admin/insurers";
const LIST: ListConfig = {
  sortable: [...INSURER_SORT_KEYS],
  defaultSort: { key: "name", dir: "asc" },
  filters: ["submission"],
  pageSize: 1000, // about 10 insurers: no pagination
};
const CHANNELS: Record<string, string> = { email: "Email", portal: "Portal", other: "Other" };

export default async function InsurersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(["admin"]);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const status = parseInsurerStatus(sp.status);
  const channel = list.filters.submission && list.filters.submission in CHANNELS ? list.filters.submission : null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("insurers")
    .select("id, name, code, sender_domains, tat_days, submission_channel, report_template_path, is_active")
    .limit(500);
  if (error) {
    return (
      <>
        <PageHeader title="Insurers" breadcrumbs={[{ label: "Admin" }, { label: "Insurers" }]} />
        <ErrorState what="Insurers" />
      </>
    );
  }
  const all: InsurerRow[] = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    sender_domains: r.sender_domains,
    tat_days: r.tat_days,
    submission_channel: r.submission_channel,
    has_template: Boolean(r.report_template_path),
    is_active: r.is_active,
  }));
  const rows = sortInsurers(filterInsurers(all, { q: list.q, status, channel }), list.sort, list.dir);
  const filtered = Boolean(list.q || channel || status !== "active");

  const columns: Column<InsurerRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.name}
          {!r.is_active && <Badge tone="neutral">Inactive</Badge>}
        </span>
      ),
    },
    { key: "code", header: "Code", sortable: true, cell: (r) => r.code },
    {
      key: "domains",
      header: "Sender domains",
      cell: (r) =>
        r.sender_domains.length ? (
          <span>
            {r.sender_domains[0]}
            {r.sender_domains.length > 1 && ` +${r.sender_domains.length - 1}`}
          </span>
        ) : (
          <Badge tone="warning">No sender domain</Badge>
        ),
    },
    { key: "tat", header: "TAT", sortable: true, align: "right", cell: (r) => `${r.tat_days} d` },
    { key: "submission", header: "Submission", sortable: true, cell: (r) => CHANNELS[r.submission_channel] ?? r.submission_channel },
    { key: "template", header: "Report template", cell: (r) => (r.has_template ? <Badge tone="success">Uploaded</Badge> : <Badge tone="warning">Missing</Badge>) },
  ];

  return (
    <>
      <PageHeader title="Insurers" breadcrumbs={[{ label: "Admin" }, { label: "Insurers" }]} actions={<ButtonLink href="/admin/insurers/new">Add insurer</ButtonLink>} />
      <Suspense>
        <FilterBar
          searchLabel="Search name, code or domain"
          total={rows.length}
          filters={[
            {
              name: "status",
              label: "Status",
              allLabel: "Active",
              options: [
                { value: "inactive", label: "Inactive" },
                { value: "all", label: "All" },
              ],
            },
            { name: "submission", label: "Submission", options: Object.entries(CHANNELS).map(([value, label]) => ({ value, label })) },
          ]}
        />
      </Suspense>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `${BASE}/${r.id}`}
        basePath={BASE}
        searchParams={sp}
        list={list}
        caption="Insurers"
        empty={
          <EmptyState
            filtered={filtered}
            title={filtered ? "No insurers match these filters." : "No insurers yet. Add the first insurer to start receiving cases."}
            action={{ label: "Add insurer", href: "/admin/insurers/new" }}
          />
        }
      />
    </>
  );
}
