import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { readHints } from "@/lib/insurer-form";
import { templateDisplayName } from "@/lib/template-file";
import { Badge, ErrorState, PageHeader } from "@/components/ui";
import { InsurerForm } from "../insurer-form";
import { ActiveSection, TemplateSection } from "./insurer-side-sections";

export const metadata = { title: "Insurer" };

export default async function InsurerPage({ params }: { params: Promise<{ insurerId: string }> }) {
  await requireRole(["admin"]);
  const { insurerId } = await params;
  if (!z.guid().safeParse(insurerId).success) notFound();

  const supabase = await createClient();
  const [ins, open] = await Promise.all([
    supabase.from("insurers").select("*").eq("id", insurerId).maybeSingle(),
    supabase.from("cases").select("id", { count: "exact", head: true }).eq("insurer_id", insurerId).not("status", "in", "(submitted,closed,cancelled)"),
  ]);
  if (ins.error) {
    return (
      <>
        <PageHeader title="Insurer" breadcrumbs={[{ label: "Admin" }, { label: "Insurers", href: "/admin/insurers" }]} />
        <ErrorState what="This insurer" />
      </>
    );
  }
  const i = ins.data;
  if (!i) notFound();

  // The path carries the upload time as yyyyMMdd-HHmmss; show it as a date.
  const stamp = /\/(\d{4})(\d{2})(\d{2})-\d{6}-/.exec(i.report_template_path ?? "");
  const uploadedAt = stamp ? formatDate(`${stamp[1]}-${stamp[2]}-${stamp[3]}`) : null;
  const hints = readHints(i.extraction_hints);

  return (
    <>
      <PageHeader
        title={i.name}
        breadcrumbs={[{ label: "Admin" }, { label: "Insurers", href: "/admin/insurers" }, { label: i.name }]}
        badges={<Badge tone={i.is_active ? "success" : "neutral"}>{i.is_active ? "Active" : "Inactive"}</Badge>}
        actions={<p className="text-xs text-text-muted">Open cases: {open.count ?? 0}</p>}
      />
      <div className="space-y-4">
        <InsurerForm
          insurerId={i.id}
          initial={{
            name: i.name,
            code: i.code,
            sender_domains: i.sender_domains,
            tat_days: String(i.tat_days),
            submission_channel: i.submission_channel,
            reply_to_email: i.reply_to_email ?? "",
            portal_url: i.portal_url ?? "",
            notes: hints.notes,
            aliases: hints.aliases,
          }}
        />
        <TemplateSection insurerId={i.id} fileName={templateDisplayName(i.report_template_path)} uploadedAt={uploadedAt} />
        <ActiveSection insurerId={i.id} name={i.name} isActive={i.is_active} openCases={open.count ?? 0} />
      </div>
    </>
  );
}
