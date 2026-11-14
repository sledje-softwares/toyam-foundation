/**
 * Server-side wrapper for the `evidence-view` edge function (contract: supabase/functions/evidence-view/README.md).
 * Called with the signed-in user's own session (their JWT is sent); no service-role key exists in this app. RLS
 * decides which files the user gets links for. Links live 5 minutes: ask again per request, never cache them.
 */
import { createClient } from "@/lib/supabase/server";
import { batchBodies, mergeResults, parseViewReply, type Disposition, type LinksResult, type ViewBody } from "./evidence-view-core";

export * from "./evidence-view-core";

async function readError(error: unknown): Promise<LinksResult> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      return parseViewReply(await (ctx as Response).json());
    } catch {
      // not JSON: fall through
    }
  }
  return parseViewReply(null);
}

async function call(supabase: Awaited<ReturnType<typeof createClient>>, body: ViewBody): Promise<LinksResult> {
  try {
    const { data, error } = await supabase.functions.invoke("evidence-view", { body });
    if (error) return await readError(error);
    return parseViewReply(data);
  } catch {
    return parseViewReply(null);
  }
}

/**
 * Short-lived links for evidence rows and/or email attachments, batched 50 per call (calls run in parallel).
 * Keys of `links` / `errors` are `linkKey(kind, id)`.
 */
export async function getFileLinks(req: {
  evidenceIds?: string[];
  attachmentIds?: string[];
  disposition?: Disposition;
}): Promise<LinksResult> {
  const bodies = batchBodies(req.evidenceIds ?? [], req.attachmentIds ?? [], req.disposition ?? "inline");
  if (!bodies.length) return { ok: true, links: new Map(), errors: new Map() };
  const supabase = await createClient();
  return mergeResults(await Promise.all(bodies.map((b) => call(supabase, b))));
}
