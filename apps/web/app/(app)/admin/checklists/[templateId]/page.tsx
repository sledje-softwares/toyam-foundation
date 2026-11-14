import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { findReplaced } from "@/lib/checklists";
import { ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { ChecklistEditor } from "../editor";
import { loadLookups, loadOpenTaskCounts, loadTemplate } from "../load";

export const metadata = { title: "Checklist" };

export default async function ChecklistPage({ params }: { params: Promise<{ templateId: string }> }) {
  await requireRole(["admin"]);
  const { templateId } = await params;
  if (!z.guid().safeParse(templateId).success) notFound();
  const supabase = await createClient();
  const [tpl, lookups] = await Promise.all([loadTemplate(supabase, templateId), loadLookups(supabase)]);
  const crumbs = [{ label: "Admin" }, { label: "Checklists", href: "/admin/checklists" }];
  if (tpl === "error" || !lookups) {
    return (
      <>
        <PageHeader title="Checklist" breadcrumbs={crumbs} />
        <ErrorState what="This checklist" />
      </>
    );
  }
  if (!tpl) notFound();

  const s = tpl.state;
  const replaced = findReplaced(s, lookups.others);
  const openTasks = await loadOpenTaskCounts(supabase, replaced ? [templateId, replaced.id] : [templateId]);
  const insurer = s.insurer_id ? (lookups.insurers.find((i) => i.id === s.insurer_id)?.name ?? "Unknown insurer") : null;
  const title = insurer ? `${s.name} (${insurer})` : s.name;

  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[...crumbs, { label: title }]}
        badges={
          <>
            <StatusBadge kind="in_use" value={tpl.is_active ? "in_use" : "not_in_use"} />
            <span className="text-sm text-text-muted">Version {s.version}</span>
          </>
        }
      />
      {/* Remount after each save or status change so the form starts from the saved rows (new item ids, new version). */}
      <ChecklistEditor key={`${s.id}-${s.version}-${tpl.is_active}`} initial={s} isActive={tpl.is_active} openTasks={openTasks} {...lookups} />
    </>
  );
}
