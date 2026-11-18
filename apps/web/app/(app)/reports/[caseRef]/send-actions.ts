"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { EDITOR_ROLES } from "@/lib/reports";
import { CaseRef, firstIssue, kickMessage, kickReportSend, SendIdInput, SendInput, SETTLE_ROLES, SettleInput } from "@/lib/report-send";
import { mapDbError } from "@/lib/validation/db-errors";

// 8.2 Send to insurer (D50). The database decides every rule again (request_report_send, retry_report_send,
// resolve_report_send: staff who manage the case, latest approved version, formats, no open send); the page only
// hides buttons. The mail itself is sent by the report-send function, started here with the user's session.

function workspacePath(caseRef: string): string {
  return `/reports/${encodeURIComponent(caseRef)}`;
}

async function done(back: string, message: string, kind: "success" | "error" = "success"): Promise<never> {
  await setFlash(message, kind);
  redirect(back);
}

function backOf(fd: FormData): string {
  const r = CaseRef.safeParse(fd.get("case_ref"));
  return r.success ? workspacePath(r.data) : "/reports";
}

function revalidate(caseRef: string) {
  revalidatePath(workspacePath(caseRef));
  revalidatePath("/reports");
  revalidatePath("/submissions");
  revalidatePath(`/cases/${encodeURIComponent(caseRef)}`);
}

/** public.request_report_send(...) then the sender is asked to deliver it at once (the Worker sweep is the fallback). */
export async function requestSend(fd: FormData): Promise<void> {
  await requireRole(EDITOR_ROLES);
  const back = backOf(fd);
  const parsed = SendInput.safeParse({
    case_id: fd.get("case_id"),
    case_ref: fd.get("case_ref"),
    formats: fd.getAll("formats").map(String),
    to: String(fd.get("to") ?? ""),
    cc: String(fd.get("cc") ?? ""),
    subject: String(fd.get("subject") ?? ""),
    body: String(fd.get("body") ?? ""),
    attachment_name: String(fd.get("attachment_name") ?? ""),
  });
  if (!parsed.success) return done(back, firstIssue(parsed.error), "error");
  const v = parsed.data;
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("request_report_send", {
    p_case_id: v.case_id,
    p_formats: v.formats,
    p_to: v.to,
    p_cc: v.cc,
    p_subject: v.subject,
    p_body: v.body,
    p_attachment_name: v.attachment_name,
  });
  if (error || !id) return done(back, error ? mapDbError(error).message : "The send could not be queued. Try again.", "error");
  const kick = await kickReportSend(id);
  revalidate(v.case_ref);
  return done(back, kickMessage(kick), kick.ok || kick.code !== "unavailable" ? "success" : "error");
}

/** public.retry_report_send(p_id): failed → queued (same Message-ID), then delivered at once. */
export async function retrySend(fd: FormData): Promise<void> {
  await requireRole(EDITOR_ROLES);
  const back = backOf(fd);
  const parsed = SendIdInput.safeParse({ send_id: fd.get("send_id"), case_ref: fd.get("case_ref") });
  if (!parsed.success) return done(back, "Reload the page and try again.", "error");
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_report_send", { p_id: parsed.data.send_id });
  if (error) return done(back, mapDbError(error).message, "error");
  const kick = await kickReportSend(parsed.data.send_id);
  revalidate(parsed.data.case_ref);
  return done(back, kickMessage(kick), kick.ok || kick.code !== "unavailable" ? "success" : "error");
}

/** A queued send the sender did not pick up (e.g. it was unreachable): ask again. */
export async function sendNow(fd: FormData): Promise<void> {
  await requireRole(EDITOR_ROLES);
  const back = backOf(fd);
  const parsed = SendIdInput.safeParse({ send_id: fd.get("send_id"), case_ref: fd.get("case_ref") });
  if (!parsed.success) return done(back, "Reload the page and try again.", "error");
  const kick = await kickReportSend(parsed.data.send_id);
  revalidate(parsed.data.case_ref);
  return done(back, kickMessage(kick), kick.ok || kick.code === "not_queued" ? "success" : "error");
}

/**
 * public.resolve_report_send(p_id, p_was_sent): an unknown outcome settled after checking the shared Gmail's Sent
 * folder. Sent → the submission is recorded (a test run stays a test run); not sent → failed, may be retried.
 * Orchestrator / admin in the UI.
 */
export async function settleSend(fd: FormData): Promise<void> {
  await requireRole(SETTLE_ROLES);
  const back = backOf(fd);
  const parsed = SettleInput.safeParse({ send_id: fd.get("send_id"), case_ref: fd.get("case_ref"), was_sent: fd.get("was_sent") });
  if (!parsed.success) return done(back, "Say whether the email is in the Sent folder.", "error");
  const supabase = await createClient();
  const wasSent = parsed.data.was_sent === "yes";
  const { error } = await supabase.rpc("resolve_report_send", { p_id: parsed.data.send_id, p_was_sent: wasSent });
  if (error) return done(back, mapDbError(error).message, "error");
  revalidate(parsed.data.case_ref);
  return done(back, wasSent ? "Recorded as sent." : "Recorded as not sent. You can retry it now.");
}
