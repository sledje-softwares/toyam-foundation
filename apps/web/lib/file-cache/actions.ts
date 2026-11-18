"use server";

/**
 * Server actions behind the browser file cache. Both run with the signed-in user's own session (RLS); no service-role
 * key exists in this app. The edge function is called server-side (it has no CORS), the browser only receives the
 * short-lived link plus the hash / type the database records for the served bytes.
 */
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getFileLinks, isVariant, linkErrorMessage, linkKey } from "@/lib/evidence-view";
import { LINK_BATCH, type LinkInfo } from "./core";
import { parseIdList } from "./view-core";

/** Links for up to 50 evidence ids in one variant (`w384`, `w1600` or `original`). Keys are the lower-cased ids. */
export async function fileCacheLinks(ids: unknown, variant: unknown): Promise<Record<string, LinkInfo>> {
  await requireRole(STAFF_ROLES);
  const list = parseIdList(ids, LINK_BATCH);
  if (!list || !list.length || !isVariant(variant)) return {};
  const r = await getFileLinks({ evidenceIds: list, variant });
  const out: Record<string, LinkInfo> = {};
  for (const id of list) {
    if (!r.ok) {
      out[id] = { ok: false, error: r.message };
      continue;
    }
    const l = r.links.get(linkKey("evidence", id));
    out[id] = l
      ? { ok: true, url: l.url, sha256: l.sha256, mime: l.mime, variant: l.variant, size: l.size_bytes, width: l.width }
      : { ok: false, error: linkErrorMessage(r.errors.get(linkKey("evidence", id)) ?? "unavailable") };
  }
  return out;
}

/** Most case ids one housekeeping call checks. */
const MAX_CASES = 1000;
const CHUNK = 100;

/**
 * Status of each given case the user can still see (RLS). A case missing from the answer is not visible any more
 * (reassigned away, D44) and its cached files are purged. `ok: false` on any error: purge nothing.
 */
export async function fileCacheCaseStatuses(ids: unknown): Promise<{ ok: true; cases: { id: string; status: string }[] } | { ok: false }> {
  await requireRole(STAFF_ROLES);
  const list = parseIdList(ids, MAX_CASES);
  if (!list) return { ok: false };
  const supabase = await createClient();
  const cases: { id: string; status: string }[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const { data, error } = await supabase.from("cases").select("id, status").in("id", list.slice(i, i + CHUNK));
    if (error) return { ok: false };
    for (const c of data ?? []) cases.push({ id: c.id, status: c.status });
  }
  return { ok: true, cases };
}
