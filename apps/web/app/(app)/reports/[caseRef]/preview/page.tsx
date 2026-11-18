import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { InlineAlert, PageHeader } from "@/components/ui";
import { ReportPreview } from "@/components/reports/report-preview";

export const metadata = { title: "Report preview" };

const CASE_REF = /^[A-Za-z0-9_\-/]{3,40}$/;

/**
 * PDF preview of the report as it would be generated now (nothing is stored). The page only finds the case (RLS); the
 * PDF is built in the browser by ReportPreview from prepare_report_preview with the user's own session (the same
 * access rules as generating, in any case status), so read-only viewers of a locked case can still look at it.
 */
export default async function ReportPreviewPage({ params }: { params: Promise<{ caseRef: string }> }) {
  await requireRole(STAFF_ROLES);
  const { caseRef: raw } = await params;
  let caseRef = raw;
  try {
    caseRef = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (!CASE_REF.test(caseRef)) notFound();

  const supabase = await createClient();
  const { data: c, error } = await supabase.from("cases").select("id, case_ref").eq("case_ref", caseRef).maybeSingle();
  if (error) {
    return (
      <InlineAlert tone="danger" title="The preview could not be loaded">
        Try again in a moment.
      </InlineAlert>
    );
  }
  if (!c) notFound();

  const href = `/reports/${encodeURIComponent(c.case_ref)}`;
  return (
    <>
      <PageHeader
        title={`Preview · ${c.case_ref}`}
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: c.case_ref, href }, { label: "Preview" }]}
        actions={
          <Link href={href} className="text-sm text-primary underline hover:no-underline">
            Back to the report
          </Link>
        }
      />
      <ReportPreview caseId={c.id} caseRef={c.case_ref} />
    </>
  );
}
