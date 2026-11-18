"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { AckInput, CloseInput, firstIssue, ManualInput, ReopenInput, safeBack } from "@/lib/submissions";
import { mapDbError } from "@/lib/validation/db-errors";

// Every action checks ownership again in the database (private.can_manage_case, D44); the page only hides buttons.

async function done(back: string, message: string, kind: "success" | "error" = "success"): Promise<never> {
  await setFlash(message, kind);
  redirect(back);
}

function revalidate(caseRef: string | null) {
  revalidatePath("/submissions");
  revalidatePath("/reports");
  if (caseRef) {
    revalidatePath(`/reports/${encodeURIComponent(caseRef)}`);
    revalidatePath(`/cases/${encodeURIComponent(caseRef)}`);
  }
}

/** public.record_submission_ack(p_submission_id, p_ack_at, p_note, p_insurer_reference): once per submission. */
export async function recordAcknowledgement(fd: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const back = safeBack(fd.get("back"));
  const parsed = AckInput.safeParse({
    submission_id: fd.get("submission_id"),
    ack_at: String(fd.get("ack_at") ?? ""),
    insurer_reference: String(fd.get("insurer_reference") ?? ""),
    note: String(fd.get("note") ?? ""),
  });
  if (!parsed.success) return done(back, firstIssue(parsed.error), "error");
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_submission_ack", {
    p_submission_id: parsed.data.submission_id,
    p_ack_at: parsed.data.ack_at ?? new Date().toISOString(),
    p_note: parsed.data.note ?? "",
    p_insurer_reference: parsed.data.insurer_reference ?? undefined,
  });
  if (error) return done(back, mapDbError(error).message, "error");
  revalidate(null);
  return done(back, "Acknowledgement recorded.");
}

/** public.record_manual_submission(...): the latest report version, delivered on the insurer's portal or another way. */
export async function recordManualSubmission(fd: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const back = safeBack(fd.get("back"));
  const parsed = ManualInput.safeParse({
    case_ref: String(fd.get("case_ref") ?? ""),
    channel: fd.get("channel"),
    formats: fd.getAll("formats").map(String),
    submitted_at: String(fd.get("submitted_at") ?? ""),
    insurer_reference: String(fd.get("insurer_reference") ?? ""),
    note: String(fd.get("note") ?? ""),
  });
  if (!parsed.success) return done(back, firstIssue(parsed.error), "error");
  const supabase = await createClient();
  const { data: c } = await supabase.from("cases").select("id, case_ref").eq("case_ref", parsed.data.case_ref).maybeSingle();
  if (!c) return done(back, `No case ${parsed.data.case_ref}. Check the reference.`, "error");
  const { error } = await supabase.rpc("record_manual_submission", {
    p_case_id: c.id,
    p_channel: parsed.data.channel,
    p_formats: parsed.data.formats,
    p_insurer_reference: parsed.data.insurer_reference ?? "",
    p_note: parsed.data.note ?? "",
    p_submitted_at: parsed.data.submitted_at ?? undefined,
  });
  if (error) return done(back, mapDbError(error).message, "error");
  revalidate(c.case_ref);
  return done(back, `Submission recorded for ${c.case_ref}.`);
}

/** public.reopen_case(p_case_id, p_reason): submitted → office review on an insurer's query. */
export async function reopenCase(fd: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const back = safeBack(fd.get("back"));
  const parsed = ReopenInput.safeParse({ case_id: fd.get("case_id"), reason: String(fd.get("reason") ?? "") });
  if (!parsed.success) return done(back, firstIssue(parsed.error), "error");
  const supabase = await createClient();
  const { error } = await supabase.rpc("reopen_case", { p_case_id: parsed.data.case_id, p_reason: parsed.data.reason });
  if (error) return done(back, mapDbError(error).message, "error");
  const { data: c } = await supabase.from("cases").select("case_ref").eq("id", parsed.data.case_id).maybeSingle();
  revalidate(c?.case_ref ?? null);
  return done(back, `${c?.case_ref ?? "The case"} is reopened and back in office review. The owner has been notified.`);
}

/**
 * public.close_case(p_case_id, p_note): submitted → closed once the insurer has acknowledged the latest submission;
 * orchestrators / admins may close without an acknowledgement with a reason. A closed case is final.
 */
export async function closeCase(fd: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const back = safeBack(fd.get("back"));
  const parsed = CloseInput.safeParse({
    case_id: fd.get("case_id"),
    without_ack: fd.get("without_ack") === "1",
    note: String(fd.get("note") ?? ""),
  });
  if (!parsed.success) return done(back, firstIssue(parsed.error), "error");
  const supabase = await createClient();
  const { error } = await supabase.rpc("close_case", {
    p_case_id: parsed.data.case_id,
    ...(parsed.data.note && { p_note: parsed.data.note }),
  });
  if (error) return done(back, mapDbError(error).message, "error");
  const { data: c } = await supabase.from("cases").select("case_ref").eq("id", parsed.data.case_id).maybeSingle();
  revalidate(c?.case_ref ?? null);
  return done(back, `${c?.case_ref ?? "The case"} is closed.`);
}
