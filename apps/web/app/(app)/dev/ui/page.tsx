import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { applyListParams, parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import {
  Badge, Button, ButtonLink, Checkbox, ConfirmDialog, DataTable, EmptyState, ErrorState, FilterBar, FormField,
  InlineAlert, PageHeader, Pagination, Select, StatusBadge, SubmitButton, TableSkeleton, Textarea, TextInput,
  STATUS_MAPS, type StatusKind,
} from "@/components/ui";
import { ToastDemo } from "./toast-demo";

// Development gallery of the shared UI components. Not available in production builds (404).
type Row = { id: number; name: string; role: string; status: string; created_at: string };
const ALL_ROWS: Row[] = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1,
  name: `Sample person ${String(i + 1).padStart(3, "0")}`,
  role: ["admin", "orchestrator", "office"][i % 3],
  status: ["active", "inactive"][i % 5 === 0 ? 1 : 0],
  created_at: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
}));
const CFG: ListConfig = {
  pageSize: 10,
  sortable: ["name", "role", "created_at"],
  defaultSort: { key: "name", dir: "asc" },
  filters: ["role", "status"],
  searchColumns: ["name"],
};

/** Mimics the PostgREST builder on the in-memory rows, so the same applyListParams is exercised. */
function fakeQuery(rows: Row[]) {
  let data = rows;
  let count = rows.length;
  const qb = {
    eq: (c: string, v: string) => ((data = data.filter((r) => String((r as Record<string, unknown>)[c]) === v)), (count = data.length), qb),
    or: (f: string) => {
      const term = /\*(.*?)\*/.exec(f)?.[1].toLowerCase() ?? "";
      data = data.filter((r) => r.name.toLowerCase().includes(term));
      count = data.length;
      return qb;
    },
    order: (c: string, o?: { ascending?: boolean }) => {
      const k = c as keyof Row;
      const dir = o?.ascending === false ? -1 : 1;
      // Stable: the later order("id") call is a tiebreaker, so sort by id only when it is the only key.
      if (c === "id") return qb;
      data = [...data].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
      return qb;
    },
    range: (from: number, to: number) => ((data = data.slice(from, to + 1)), qb),
    result: () => ({ data, count }),
  };
  return qb;
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (process.env.NODE_ENV === "production") notFound();
  await requireRole(["admin"]);
  const sp = await searchParams;
  const list = parseListParams(sp, CFG);
  const q = fakeQuery(ALL_ROWS);
  applyListParams(q, list, CFG);
  const { data, count } = q.result();

  return (
    <div className="space-y-10">
      <PageHeader
        title="UI gallery"
        breadcrumbs={[{ label: "Dev" }, { label: "UI" }]}
        badges={<Badge tone="warning">Development only</Badge>}
        actions={<ButtonLink href="/dashboard" variant="secondary">Back</ButtonLink>}
      />

      <section aria-labelledby="g-buttons" className="space-y-3">
        <h2 id="g-buttons" className="text-xl font-semibold">Buttons</h2>
        <div className="flex flex-wrap gap-2">
          <Button>Save user</Button>
          <Button variant="secondary">Cancel</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="ghost">Learn more</Button>
          <Button disabled>Disabled</Button>
          <form action={async () => { "use server"; await new Promise((r) => setTimeout(r, 1000)); }}>
            <SubmitButton>Save (1 s)</SubmitButton>
          </form>
        </div>
      </section>

      <section aria-labelledby="g-form" className="max-w-3xl space-y-4">
        <h2 id="g-form" className="text-xl font-semibold">Form fields</h2>
        <FormField label="Full name" required hint="As on the ID document.">{(p) => <TextInput {...p} defaultValue="" />}</FormField>
        <FormField label="Email" error="Enter a valid email address.">{(p) => <TextInput {...p} type="email" defaultValue="not-an-email" />}</FormField>
        <FormField label="Role" required>
          {(p) => <Select {...p} placeholder="Choose a role" options={[{ value: "admin", label: "Admin" }, { value: "office", label: "Office staff" }]} />}
        </FormField>
        <FormField label="Notes">{(p) => <Textarea {...p} />}</FormField>
        <Checkbox label="Active" defaultChecked />
      </section>

      <section aria-labelledby="g-badges" className="space-y-3">
        <h2 id="g-badges" className="text-xl font-semibold">Status badges</h2>
        {(Object.keys(STATUS_MAPS) as StatusKind[]).map((kind) => (
          <div key={kind} className="flex flex-wrap items-center gap-2">
            <span className="w-40 text-sm text-text-muted">{kind}</span>
            {Object.keys(STATUS_MAPS[kind]).map((v) => <StatusBadge key={v} kind={kind} value={v} />)}
          </div>
        ))}
      </section>

      <section aria-labelledby="g-feedback" className="max-w-3xl space-y-3">
        <h2 id="g-feedback" className="text-xl font-semibold">Alerts, dialogs, toasts</h2>
        <InlineAlert title="Heads up">Existing tasks keep their current checklist.</InlineAlert>
        <InlineAlert tone="warning" title="Missing items">2 required items are not captured.</InlineAlert>
        <InlineAlert tone="danger" title="Not saved">Try again.</InlineAlert>
        <div className="flex flex-wrap gap-2">
          <ConfirmDialog trigger="Deactivate user" title="Deactivate Sample person?" confirmLabel="Deactivate user" tone="danger">
            They will no longer be able to sign in.
          </ConfirmDialog>
          <ToastDemo />
        </div>
      </section>

      <section aria-labelledby="g-states" className="max-w-3xl space-y-3">
        <h2 id="g-states" className="text-xl font-semibold">Empty, error, loading</h2>
        <EmptyState title="No insurers yet" description="Add the first insurer to start." action={{ label: "Add insurer", href: "#" }} />
        <EmptyState title="" filtered />
        <ErrorState what="Users" />
        <TableSkeleton rows={3} />
      </section>

      <section aria-labelledby="g-table" className="space-y-3">
        <h2 id="g-table" className="text-xl font-semibold">Data table, filters, pagination (URL-driven)</h2>
        <Suspense>
          <FilterBar
            total={count}
            searchLabel="Search name"
            filters={[
              { name: "role", label: "Role", options: [{ value: "admin", label: "Admin" }, { value: "orchestrator", label: "Orchestrator" }, { value: "office", label: "Office staff" }] },
              { name: "status", label: "Status", options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] },
            ]}
          />
        </Suspense>
        <DataTable<Row>
          caption="Sample people"
          basePath="/dev/ui"
          searchParams={sp}
          list={list}
          rows={data}
          rowKey={(r) => String(r.id)}
          rowHref={(r) => `/dev/ui?q=${encodeURIComponent(r.name)}`}
          empty={<EmptyState title="No people" filtered />}
          columns={[
            { key: "name", header: "Name", sortable: true },
            { key: "role", header: "Role", sortable: true },
            { key: "status", header: "Status", cell: (r) => <StatusBadge kind="active" value={r.status} /> },
            { key: "created_at", header: "Created", sortable: true, align: "right" },
          ]}
        />
        <Pagination page={list.page} pageSize={list.pageSize} total={count} basePath="/dev/ui" searchParams={sp} />
      </section>
    </div>
  );
}
