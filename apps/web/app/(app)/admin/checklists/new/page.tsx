import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { copyState, isClaimType, type EditorState } from "@/lib/checklists";
import type { SearchParams } from "@/lib/list-params";
import { ErrorState, PageHeader } from "@/components/ui";
import { ChecklistEditor } from "../editor";
import { loadLookups, loadTemplate } from "../load";

export const metadata = { title: "New checklist" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const CRUMBS = [{ label: "Admin" }, { label: "Checklists", href: "/admin/checklists" }, { label: "New checklist" }];

function Failed({ what }: { what: string }) {
  return (
    <>
      <PageHeader title="New checklist" breadcrumbs={CRUMBS} />
      <ErrorState what={what} />
    </>
  );
}

export default async function NewChecklistPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(["admin"]);
  const sp = await searchParams;
  const copyId = first(sp.copy);
  const claim = first(sp.claim_type);
  const supabase = await createClient();

  let initial: EditorState = { id: null, version: null, name: "", claim_type: isClaimType(claim) ? claim : "", insurer_id: "", items: [] };
  if (copyId) {
    if (!z.guid().safeParse(copyId).success) notFound();
    const src = await loadTemplate(supabase, copyId);
    if (src === "error") return <Failed what="The checklist to copy" />;
    if (!src) notFound();
    let n = 0;
    initial = copyState(src.state, () => `copy-${++n}`);
  }
  const lookups = await loadLookups(supabase);
  if (!lookups) return <Failed what="This form" />;

  return (
    <>
      <PageHeader title={copyId ? "Duplicate checklist" : "New checklist"} breadcrumbs={CRUMBS} />
      <ChecklistEditor initial={initial} isActive={false} openTasks={{}} {...lookups} />
    </>
  );
}
