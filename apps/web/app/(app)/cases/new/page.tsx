import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isGuid } from "@/lib/cases";
import type { SearchParams } from "@/lib/list-params";
import { canChooseOwner, templateLabel } from "@/lib/new-case";
import { Button, EmptyState, ErrorState, PageHeader, Select } from "@/components/ui";
import { loadInsurerTemplates, loadOwnerOptions, loadTemplate } from "./load";
import { NewCaseForm } from "./new-case-form";

export const metadata = { title: "New case" };

const BASE = "/cases/new";

function one(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

/**
 * Create a case without an email (D49). Step 1: insurer, then one of its templates in use (`?insurer=`).
 * Step 2 (`?template=`): the template's intake fields, owner and note.
 */
export default async function NewCasePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const supabase = await createClient();
  const crumbs = [{ label: "Cases", href: "/cases" }, { label: "New case" }];
  const templateId = one(sp.template);

  if (templateId) {
    if (!isGuid(templateId)) notFound();
    const tpl = await loadTemplate(supabase, templateId);
    if (tpl === "error") return <ErrorState what="This template" />;
    if (!tpl) notFound();
    const owners = canChooseOwner(me.role) ? await loadOwnerOptions(supabase, new Date()) : null;
    if (canChooseOwner(me.role) && !owners) return <ErrorState what="The staff list" />;
    return (
      <>
        <PageHeader title="New case" breadcrumbs={crumbs} />
        <div className="mb-5 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border bg-surface px-4 py-3 text-sm">
          <span className="font-medium">{tpl.insurer_name}</span>
          <span>{templateLabel(tpl)}</span>
          <span className="text-text-muted">{tpl.name}</span>
          <Link href={`${BASE}?insurer=${tpl.insurer_id}`} className="ml-auto text-primary underline hover:no-underline">
            Change template
          </Link>
        </div>
        <p className="mb-5 max-w-3xl text-sm text-text-muted">
          Fill the fields the insurer gave you. The rest of the report is filled later in the report workspace.
        </p>
        <NewCaseForm templateId={tpl.id} fields={tpl.fields} owners={owners} cancelHref="/cases" />
      </>
    );
  }

  const insurers = await loadInsurerTemplates(supabase);
  if (!insurers) return <ErrorState what="The templates" />;
  if (!insurers.length) {
    return (
      <>
        <PageHeader title="New case" breadcrumbs={crumbs} />
        <EmptyState title="No templates in use" description="An admin loads and puts in use a template for each insurer and claim type." />
      </>
    );
  }

  const insurerId = one(sp.insurer);
  const chosen = insurers.find((i) => i.id === insurerId) ?? null;

  return (
    <>
      <PageHeader title="New case" breadcrumbs={crumbs} />
      <p className="mb-5 max-w-3xl text-sm text-text-muted">
        For a case that did not arrive by email. Cases from insurer emails are created automatically or in Intake review.
      </p>
      <form action={BASE} method="get" className="mb-6 flex max-w-xl flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <label htmlFor="insurer" className="mb-1 block text-sm font-medium">
            Insurer
          </label>
          <Select
            id="insurer"
            name="insurer"
            required
            defaultValue={chosen?.id ?? ""}
            placeholder="Choose the insurer"
            options={insurers.map((i) => ({ value: i.id, label: `${i.name} (${i.code})` }))}
          />
        </div>
        <Button type="submit" variant={chosen ? "secondary" : "primary"}>
          {chosen ? "Change" : "Continue"}
        </Button>
      </form>

      {chosen && (
        <section className="max-w-xl">
          <h2 className="mb-2 text-base font-semibold">Template</h2>
          <ul className="divide-y divide-border rounded border border-border bg-surface">
            {chosen.templates.map((t) => (
              <li key={t.id}>
                <Link href={`${BASE}?template=${t.id}`} className="block px-4 py-3 hover:bg-slate-50">
                  <span className="block font-medium text-primary">{templateLabel(t)}</span>
                  <span className="block text-sm text-text-muted">{t.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
