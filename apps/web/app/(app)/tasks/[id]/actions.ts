"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { caseHref, isGuid } from "@/lib/tasks";
import { parseCancelForm, parseCompleteForm, parseReassignForm, readEditForm, validateEditForm, type TaskActionResult } from "@/lib/tasks-actions";
import { mapDbError } from "@/lib/validation/db-errors";
import { loadOperators } from "../new/load";

const RELOAD = "Reload the page and try again.";
const fail = (error: string, fieldErrors: Record<string, string> = {}): TaskActionResult => ({ error, fieldErrors });

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function loadTask(supabase: Supabase, id: string) {
  const { data } = await supabase
    .from("tasks")
    .select("id, title, kind, assignee_id, due_at, cases!inner(case_ref)")
    .eq("id", id)
    .maybeSingle();
  return data;
}

async function done(taskId: string, caseRef: string, message: string): Promise<never> {
  await setFlash(message);
  revalidatePath("/tasks", "layout");
  revalidatePath(caseHref(caseRef), "layout");
  redirect(`/tasks/${taskId}`);
}

function fieldFail(errors: Record<string, string>): TaskActionResult {
  return errors.task_id ? fail(RELOAD) : fail("Check the highlighted fields.", errors);
}

/**
 * public.complete_field_task(p_task_id, p_note). The database posts the event, notifies the operator, ends the hold
 * (late uploads stay open, D43) and moves the case to office review when no field work is left.
 */
export async function completeTaskAction(formData: FormData): Promise<TaskActionResult> {
  await requireRole(STAFF_ROLES);
  const { errors, input } = parseCompleteForm(formData);
  if (!input) return fieldFail(errors);
  const supabase = await createClient();
  const t = await loadTask(supabase, input.p_task_id);
  if (!t) return fail("This task was not found.");
  const { error } = await supabase.rpc("complete_field_task", input);
  if (error) return fail(mapDbError(error).message);
  return done(t.id, t.cases.case_ref, `Field work marked complete: ${t.title}.`);
}

/** public.cancel_field_task(p_task_id, p_reason). The database posts the event, notifies the operator and ends the hold. */
export async function cancelTaskAction(formData: FormData): Promise<TaskActionResult> {
  await requireRole(STAFF_ROLES);
  const { errors, input } = parseCancelForm(formData);
  if (!input) return fieldFail(errors);
  const supabase = await createClient();
  const t = await loadTask(supabase, input.p_task_id);
  if (!t) return fail("This task was not found.");
  const { error } = await supabase.rpc("cancel_field_task", input);
  if (error) return fail(mapDbError(error).message);
  return done(t.id, t.cases.case_ref, `Field work cancelled: ${t.title}.`);
}

/**
 * public.reassign_field_task(p_task_id, p_assignee_id, p_reason). The old operator keeps the late-upload window for
 * files captured while holding the task (D43, task_holds).
 */
export async function reassignTaskAction(formData: FormData): Promise<TaskActionResult> {
  await requireRole(STAFF_ROLES);
  const id = formData.get("task_id");
  if (typeof id !== "string" || !isGuid(id)) return fail(RELOAD);
  const supabase = await createClient();
  const [t, operators] = await Promise.all([loadTask(supabase, id), loadOperators(supabase, new Date())]);
  if (!t) return fail("This task was not found.");
  if (!operators) return fail("The operators could not be loaded. Try again.");
  const { errors, input } = parseReassignForm(formData, {
    operatorIds: new Set(operators.map((o) => o.id)),
    currentAssigneeId: t.assignee_id,
  });
  if (!input) return fieldFail(errors);
  const { error } = await supabase.rpc("reassign_field_task", input);
  if (error) return fail(mapDbError(error).message);
  const name = operators.find((o) => o.id === input.p_assignee_id)?.full_name ?? "the new operator";
  return done(t.id, t.cases.case_ref, `Field work reassigned to ${name}.`);
}

/** public.update_field_task(p_task_id, p_title, p_instructions, p_due_at, p_location_text): replaces all four values. */
export async function updateTaskAction(formData: FormData): Promise<TaskActionResult> {
  await requireRole(STAFF_ROLES);
  const id = formData.get("task_id");
  if (typeof id !== "string" || !isGuid(id)) return fail(RELOAD);
  const supabase = await createClient();
  const t = await loadTask(supabase, id);
  if (!t) return fail("This task was not found.");
  const { errors, input } = validateEditForm(id, readEditForm(formData), {
    now: new Date(),
    isRequest: t.kind === "re_investigation",
    currentDueAt: t.due_at,
  });
  if (!input) return fieldFail(errors);
  const { data: changed, error } = await supabase.rpc("update_field_task", input);
  if (error) return fail(mapDbError(error).message);
  return done(t.id, t.cases.case_ref, changed ? "Task updated. The operator is notified." : "Nothing changed.");
}
