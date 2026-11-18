/**
 * Server-side calls to the `report-send` edge function (supabase/functions/report-send/README.md), made with the
 * signed-in user's own session: supabase-js sends their access token as the Bearer; there is no service-role key or
 * shared secret in this app. The function checks that the user can see the send under RLS before it delivers it.
 */
import { createClient } from "@/lib/supabase/server";
import { parseKickReply, parseModeReply, type KickResult, type SenderMode } from "./report-send-core";

export * from "./report-send-core";

async function errorBody(error: unknown): Promise<unknown> {
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

/** Asks the sender to deliver a queued send now (it answers at once; delivery continues on the server). */
export async function kickReportSend(sendId: string): Promise<KickResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.functions.invoke("report-send", { body: { action: "send", id: sendId } });
    return parseKickReply(error ? await errorBody(error) : data);
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

/** Test or live mode of the sender, for the form's notice; null when it cannot be reached. */
export async function reportSenderMode(): Promise<SenderMode | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.functions.invoke("report-send", { body: { action: "mode" } });
    return error ? null : parseModeReply(data);
  } catch {
    return null;
  }
}
