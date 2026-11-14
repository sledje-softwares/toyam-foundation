import { Fragment, Suspense } from "react";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatRelativeDay } from "@/lib/format";
import {
  ALL_INSURERS,
  CLAIM_TYPE_LABELS,
  CLAIM_TYPES,
  filterTemplates,
  groupTemplates,
  isClaimType,
  itemsLabel,
  overridesAllInsurers,
  parseStatusFilter,
  type TemplateRow,
} from "@/lib/checklists";
import type { SearchParams } from "@/lib/list-params";
import { ButtonLink, ErrorState, FilterBar, PageHeader, StatusBadge } from "@/components/ui";

export const metadata = { title: "Checklists" };

const BASE = "/admin/checklists";
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ChecklistsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(["admin"]);
  const sp = await searchParams;
  const supabase = await createClient();
  const [tpl, ins] = await Promise.all([
    supabase
      .from("checklist_templates")
      .select("id, name, claim_type, insurer_id, is_active, version, updated_at, insurers(name), checklist_template_items(is_mandatory)")
      .limit(2000),
    supabase.from("insurers").select("id, name").order("name"),
  ]);
  const header = <PageHeader title="Checklists" breadcrumbs={[{ label: "Admin" }, { label: "Checklists" }]} actions={<ButtonLink href={`${BASE}/new`}>New checklist</ButtonLink>} />;
  if (tpl.error) {
    return (
      <>
        {header}
        <ErrorState what="Checklists" />
      </>
    );
  }

  const all: TemplateRow[] = (tpl.data ?? []).map((r) => {
    const insurer = Array.isArray(r.insurers) ? r.insurers[0] : r.insurers;
    const items = r.checklist_template_items ?? [];
    return {
      id: r.id,
      name: r.name,
      claim_type: r.claim_type,
      insurer_id: r.insurer_id,
      insurer_name: insurer?.name ?? null,
      is_active: r.is_active,
      version: r.version,
      updated_at: r.updated_at,
      items: items.length,
      required: items.filter((i) => i.is_mandatory).length,
    };
  });
  const insurers = ins.data ?? [];
  const claimParam = first(sp.claim_type);
  const insurerParam = first(sp.insurer);
  const filters = {
    claim_type: isClaimType(claimParam) ? claimParam : null,
    insurer: insurerParam === "none" || insurers.some((i) => i.id === insurerParam) ? insurerParam : null,
    status: parseStatusFilter(first(sp.status)),
  };
  const rows = filterTemplates(all, filters);
  const groups = groupTemplates(rows, filters.claim_type);
  const emptyText = filters.status === "in_use" ? "(no checklist in use)" : "(no checklist)";

  return (
    <>
      {header}
      <Suspense>
        <FilterBar
          noSearch
          total={rows.length}
          filters={[
            { name: "claim_type", label: "Claim type", options: CLAIM_TYPES.map((c) => ({ value: c, label: CLAIM_TYPE_LABELS[c] })) },
            { name: "insurer", label: "Insurer", options: [{ value: "none", label: "All insurers only" }, ...insurers.map((i) => ({ value: i.id, label: i.name }))] },
            {
              name: "status",
              label: "Status",
              allLabel: "In use",
              options: [
                { value: "not_in_use", label: "Not in use" },
                { value: "all", label: "All" },
              ],
            },
          ]}
        />
      </Suspense>
      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Checklists by claim type</caption>
          <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Name</th>
              <th scope="col" className="px-3 py-2 font-medium">Applies to</th>
              <th scope="col" className="px-3 py-2 font-medium">Items</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Ver</th>
              <th scope="col" className="px-3 py-2 font-medium">Saved</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.claim_type}>
                <tr className="border-t border-border bg-slate-50">
                  <th scope="colgroup" colSpan={6} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">
                    {CLAIM_TYPE_LABELS[g.claim_type]}
                  </th>
                </tr>
                {g.rows.length === 0 ? (
                  <tr className="border-t border-border">
                    <td colSpan={6} className="px-3 py-2 text-text-muted">
                      {emptyText}{" "}
                      <Link href={`${BASE}/new?claim_type=${g.claim_type}`} className="ml-2 font-medium text-primary underline hover:no-underline">
                        Create one
                      </Link>
                    </td>
                  </tr>
                ) : (
                  g.rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr className="border-t border-border hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <Link href={`${BASE}/${r.id}`} className="font-medium text-primary underline hover:no-underline">
                            {r.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{r.insurer_name ?? (r.insurer_id ? "Unknown insurer" : ALL_INSURERS)}</td>
                        <td className="px-3 py-2 tabular-nums">{itemsLabel(r.items, r.required)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.version}</td>
                        <td className="px-3 py-2">{formatRelativeDay(r.updated_at)}</td>
                        <td className="px-3 py-2">
                          <StatusBadge kind="in_use" value={r.is_active ? "in_use" : "not_in_use"} />
                        </td>
                      </tr>
                      {overridesAllInsurers(r, all) && (
                        <tr>
                          <td />
                          <td colSpan={5} className="px-3 pb-2 text-xs text-text-muted">
                            ↳ overrides &quot;{ALL_INSURERS}&quot; for this insurer
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
