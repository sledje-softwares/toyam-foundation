/**
 * GET /files/{evidence|attachment}/{id}[?download=1]: asks evidence-view for a fresh 5-minute link with the user's own
 * session and redirects to it. Used for "Open" / "Download" links and as the thumbnail fallback, so a link on a page
 * never goes stale. RLS decides access; an invisible file is a plain 404.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile, STAFF_ROLES } from "@/lib/auth";
import { getFileLinks, isUuid, linkErrorMessage, linkKey, type FileKind } from "@/lib/evidence-view";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

function text(status: number, message: string) {
  return new NextResponse(message, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
}

const STATUS: Record<string, number> = { not_found: 404, no_file: 404, archived: 410, unauthorized: 401, rate_limited: 429, storage_not_configured: 503 };

export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if ((kind !== "evidence" && kind !== "attachment") || !isUuid(id)) return text(404, linkErrorMessage("not_found"));

  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.redirect(new URL("/login", request.url), { headers: NO_STORE });
  if (!STAFF_ROLES.includes(profile.role)) return text(403, "You cannot open files here.");

  const k = kind as FileKind;
  const download = request.nextUrl.searchParams.get("download") === "1";
  const r = await getFileLinks({
    evidenceIds: k === "evidence" ? [id] : [],
    attachmentIds: k === "attachment" ? [id] : [],
    disposition: download ? "attachment" : "inline",
  });
  if (!r.ok) return text(STATUS[r.code] ?? 502, r.message);
  const link = r.links.get(linkKey(k, id));
  if (!link) {
    const code = r.errors.get(linkKey(k, id)) ?? "unavailable";
    return text(STATUS[code] ?? 502, linkErrorMessage(code));
  }
  return NextResponse.redirect(link.url, { status: 302, headers: NO_STORE });
}
