/**
 * GET /files/reports/{report_id}/{pdf|docx}: a generated report file. Staff only; the row is read with the user's own
 * session, so RLS (private.can_manage_case, D44) decides, and an invisible file is a plain 404. Redirects to a 60-second
 * signed URL of bucket `reports` that downloads as `<case_ref>_v<n>.<ext>`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, STAFF_ROLES } from "@/lib/auth";
import { isReportFormat, reportDownloadName } from "@/lib/report-generate-core";
import { createClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(status: number, message: string) {
  return new NextResponse(message, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ reportId: string; format: string }> }) {
  const { reportId, format } = await params;
  if (!UUID.test(reportId) || !isReportFormat(format)) return text(404, "This file is not available.");

  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.redirect(new URL("/login", request.url), { headers: NO_STORE });
  if (!STAFF_ROLES.includes(profile.role)) return text(403, "You cannot open reports here.");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("report_files")
    .select("storage_path, reports!inner(version, cases!inner(case_ref))")
    .eq("report_id", reportId)
    .eq("format", format)
    .maybeSingle();
  if (error) return text(502, "The file could not be looked up. Try again.");
  const rep = Array.isArray(data?.reports) ? data?.reports[0] : data?.reports;
  const cs = Array.isArray(rep?.cases) ? rep?.cases[0] : rep?.cases;
  if (!data?.storage_path || !rep || !cs) return text(404, "This file is not available.");

  const signed = await supabase.storage
    .from("reports")
    .createSignedUrl(data.storage_path, 60, { download: reportDownloadName(cs.case_ref, rep.version, format) });
  if (signed.error || !signed.data) return text(502, "The download link could not be created. Try again.");
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: NO_STORE });
}
