"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { canRaiseTask, caseHref, isGuid, noFieldWorkReason } from "@/lib/tasks";
import { readTaskForm, validateTaskForm, type TaskFieldErrors, type TaskFormValues } from "@/lib/tasks-form";
import { mapDbError } from "@/lib/validation/db-errors";
import { loadCase, loadCaseTasks, loadChecklistOptions, loadOperators } from "./load";

export type TaskFormState = {
  error: string | null;
  fieldErrors: TaskFieldErrors;
  /** What was submitted, so the form keeps it after a failed attempt. */
  values: TaskFormValues | null;
};

const RELOAD = "Reload the page and try again.";

/**
 * Assigns field work or sends a re-investigation request:
 * public.create_field_task(p_case_id, p_assignee_id, p_title, p_instructions, p_checklist_template_id, p_kind, p_due_at,
 * p_location_text, p_parent_task_id). The database posts the thread message (a `request` for a re-investigation),
 * notifies the operator and moves the case to field work.
 */
export async function createFieldTaskAction(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  await requireRole(STAFF_ROLES);
  const values = readTaskForm(formData);
  if (!isGuid(values.case_id)) return { error: RELOAD, fieldErrors: {}, values };

  const supabase = await createClient();
  const now = new Date();
  const c = await loadCase(supabase, { id: values.case_id });
  if (c === "error") return { error: "The case could not be loaded. Try again.", fieldErrors: {}, values };
  if (!c) return { error: "This case was not found. It may have been removed.", fieldErrors: {}, values };
  if (!canRaiseTask(c.status)) {
    const why = c.status === "submitted" ? noFieldWorkReason(c.status) : "This case is closed or cancelled, so it takes no new field work.";
    return { error: why, fieldErrors: {}, values };
  }

  const [operators, checklists, tasks] = await Promise.all([
    loadOperators(supabase, now),
    loadChecklistOptions(supabase, c),
    loadCaseTasks(supabase, c.id),
  ]);
  if (!operators) return { error: "The operators could not be loaded. Try again.", fieldErrors: {}, values };

  const { errors, input } = validateTaskForm(values, {
    now,
    operatorIds: new Set(operators.map((o) => o.id)),
    checklistIds: new Set(checklists.map((o) => o.id)),
    parentIds: new Set(tasks.map((t) => t.id)),
  });
  if (!input) return { error: "Check the highlighted fields.", fieldErrors: errors, values };

  const { error } = await supabase.rpc("create_field_task", input);
  if (error) return { error: mapDbError(error).message, fieldErrors: {}, values };

  const name = operators.find((o) => o.id === input.p_assignee_id)?.full_name ?? "the operator";
  await setFlash(
    input.p_kind === "re_investigation"
      ? `Re-investigation sent to ${name} on case ${c.case_ref}.`
      : `Field work assigned to ${name} on case ${c.case_ref}.`,
  );
  revalidatePath("/tasks", "layout");
  revalidatePath(caseHref(c.case_ref));
  redirect(caseHref(c.case_ref));
}
