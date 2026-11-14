"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { caseHref, isCaseRef, MESSAGE_MAX, parseComposerMode, REASON_MAX, REASON_MIN, type CaseActionResult } from "@/lib/cases";
import { mapDbError } from "@/lib/validation/db-errors";


const fail = (error: string, fieldErrors: Record<string, string> = {}): CaseActionResult => ({ error, fieldErrors });

function refresh(ref: string) {
  if (isCaseRef(ref)) revalidatePath(caseHref(ref), "layout");
  revalidatePath("/cases");
}

const ReassignInput = z.object({
  case_id: z.guid(),
  case_ref: z.string(),
  assignee_id: z.guid({ message: "Choose who takes the case." }),
  reason: z
    .string()
    .trim()
    .min(REASON_MIN, { message: "Give a reason for the reassignment." })
    .max(REASON_MAX, { message: `Keep the reason under ${REASON_MAX} characters.` }),
});

/** 4.2: public.reassign_case(p_case_id, p_assignee_id, p_reason). Orchestrator / admin only (the database checks too). */
export async function reassignCaseAction(formData: FormData): Promise<CaseActionResult> {
  await requireRole(["orchestrator", "admin"]);
  const parsed = ReassignInput.safeParse({
    case_id: formData.get("case_id"),
    case_ref: formData.get("case_ref"),
    assignee_id: formData.get("assignee_id"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = String(i.path[0]);
      if ((k === "assignee_id" || k === "reason") && !fieldErrors[k]) fieldErrors[k] = i.message;
    }
    return fail(Object.keys(fieldErrors).length ? "Check the highlighted fields." : "Reload the page and try again.", fieldErrors);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reassign_case", {
    p_case_id: parsed.data.case_id,
    p_assignee_id: parsed.data.assignee_id,
    p_reason: parsed.data.reason,
  });
  if (error) return fail(mapDbError(error).message);

  const { data: who } = await supabase.from("profiles").select("full_name").eq("id", parsed.data.assignee_id).maybeSingle();
  refresh(parsed.data.case_ref);
  return { error: null, fieldErrors: {}, message: `Case reassigned to ${who?.full_name ?? "the new owner"}.` };
}

const CaseInput = z.object({ case_id: z.guid(), case_ref: z.string() });

/** Unassigned case: public.retry_auto_assign(p_case_id) runs the assignment rules again (null = nobody available). */
export async function retryAutoAssignAction(formData: FormData): Promise<CaseActionResult> {
  await requireRole(["orchestrator", "admin"]);
  const parsed = CaseInput.safeParse({ case_id: formData.get("case_id"), case_ref: formData.get("case_ref") });
  if (!parsed.success) return fail("Reload the page and try again.");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("retry_auto_assign", { p_case_id: parsed.data.case_id });
  if (error) return fail(mapDbError(error).message);
  refresh(parsed.data.case_ref);
  if (!data) return fail("No one is available to take this case. Reassign it by hand or update availability.");
  return { error: null, fieldErrors: {}, message: "Case assigned automatically." };
}

const MessageInput = z.object({
  case_id: z.guid(),
  case_ref: z.string(),
  client_message_id: z.guid(),
  mode: z.enum(["staff", "field"]),
  body: z
    .string()
    .trim()
    .min(1, { message: "Write a message first." })
    .max(MESSAGE_MAX, { message: `At most ${MESSAGE_MAX} characters.` }),
});

/**
 * 4.7 composer. mode "staff": public.post_staff_note() — staff-only (D32), never shown to field users.
 * mode "field": public.post_thread_message(kind 'text') — visible to the field operators on the case.
 * Both are idempotent on client_message_id (made in the browser per draft).
 */
export async function postCaseMessageAction(formData: FormData): Promise<CaseActionResult> {
  await requireRole(STAFF_ROLES);
  const parsed = MessageInput.safeParse({
    case_id: formData.get("case_id"),
    case_ref: formData.get("case_ref"),
    client_message_id: formData.get("client_message_id"),
    mode: parseComposerMode(formData.get("mode")) ?? "",
    body: formData.get("body") ?? "",
  });
  if (!parsed.success) {
    const bodyIssue = parsed.error.issues.find((i) => i.path[0] === "body");
    if (bodyIssue) return fail(bodyIssue.message, { body: bodyIssue.message });
    return fail("Reload the page and try again.");
  }
  const { case_id, case_ref, client_message_id, mode, body } = parsed.data;

  const supabase = await createClient();
  const { error } =
    mode === "staff"
      ? await supabase.rpc("post_staff_note", { p_case_id: case_id, p_client_message_id: client_message_id, p_body: body })
      : await supabase.rpc("post_thread_message", {
          p_case_id: case_id,
          p_client_message_id: client_message_id,
          p_kind: "text",
          p_body: body,
        });
  if (error) return fail(mapDbError(error).message);
  refresh(case_ref);
  return { error: null, fieldErrors: {}, message: mode === "staff" ? "Staff note added." : "Message sent to the field." };
}
