/**
 * Server-side wrapper for the `report-generate` edge function (supabase/functions/report-generate/README.md). Called
 * with the signed-in user's own session: supabase-js sends their access token as the Bearer, there is no service-role
 * key in this app. The database decides who may generate (staff, case owner or orchestrator/admin, editable status).
 */
import { createClient } from "@/lib/supabase/server";
import { parseGenerateReply, UNAVAILABLE, type GenerateMode, type GenerateResult } from "./report-generate-core";

export * from "./report-generate-core";

async function readError(error: unknown): Promise<unknown> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      return await (ctx as Response).json();
    } catch {
      // not JSON
    }
  }
  return null;
}

export async function callReportGenerate(req: { caseId: string; mode: GenerateMode; notes?: string | null }): Promise<GenerateResult> {
  const supabase = await createClient();
  try {
    const body: Record<string, unknown> = { case_id: req.caseId, mode: req.mode };
    if (req.mode === "generate" && req.notes) body.notes = req.notes;
    const { data, error } = await supabase.functions.invoke("report-generate", { body });
    return parseGenerateReply(req.mode, error ? await readError(error) : data);
  } catch {
    return { ok: false, code: "unavailable", message: UNAVAILABLE, retryAfter: null };
  }
}
