import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { callReportGenerate } from "@/lib/report-generate";
import { createClient } from "@/lib/supabase/server";
import { InlineAlert, PageHeader } from "@/components/ui";

export const metadata = { title: "Report preview" };

const CASE_REF = /^[A-Za-z0-9_\-/]{3,40}$/;

/**
 * HTML preview of the report as it would be generated now (nothing is stored). The HTML comes from the
 * `report-generate` function with the user's own session and is shown in a sandboxed iframe: no `allow-scripts`, no
 * `allow-same-origin`, so it cannot run code or reach this app's cookies. It carries its own CSP (data: images only).
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
  const r = await callReportGenerate({ caseId: c.id, mode: "preview" });

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
      {!r.ok ? (
        <InlineAlert tone="warning" title="No preview">
          {r.message}
        </InlineAlert>
      ) : (
        <>
          <p className="mb-3 text-sm text-text-muted">This is a draft view of the current values. Nothing has been saved; use Generate report to make a version.</p>
          {r.warnings.length > 0 && (
            <div className="mb-3">
              <InlineAlert tone="warning" title="Check before generating">
                <ul className="list-disc pl-5">
                  {r.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </InlineAlert>
            </div>
          )}
          <iframe title={`Preview of the report for ${c.case_ref}`} sandbox="" srcDoc={r.html ?? ""} className="h-[80vh] w-full rounded border border-border bg-white" />
        </>
      )}
    </>
  );
}
