"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { caseHref } from "@/lib/cases";
import { canChooseOwner, placeCreateError, readNewCaseForm, validateNewCase, type NewCaseFormState } from "@/lib/new-case";
import { mapDbError } from "@/lib/validation/db-errors";
import { loadOwnerOptions, loadTemplate } from "./load";

/**
 * Creates a case directly: public.create_case_direct(p_template_id, p_values, p_owner_id, p_note).
 * The database writes the case, its field values, status history, assignment, thread messages and audit row.
 */
export async function createCaseAction(prev: NewCaseFormState, formData: FormData): Promise<NewCaseFormState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const r = await create(formData);
  return { ...r, attempt };
}

async function create(formData: FormData): Promise<NewCaseFormState> {
  const me = await requireRole(STAFF_ROLES);
  const form = readNewCaseForm(formData.entries());
  const values = form.values;
  const supabase = await createClient();

  const tpl = form.templateId ? await loadTemplate(supabase, form.templateId) : null;
  if (tpl === "error") return { error: "The template could not be loaded. Try again.", fieldErrors: {}, values };
  if (!tpl) return { error: "This template is no longer in use. Start again from New case.", fieldErrors: {}, values };

  let ownerIds = new Set<string>();
  if (canChooseOwner(me.role)) {
    const owners = await loadOwnerOptions(supabase, new Date());
    if (!owners) return { error: "The staff list could not be loaded. Try again.", fieldErrors: {}, values };
    ownerIds = new Set(owners.map((o) => o.value));
  }

  const { errors, formError, input } = validateNewCase(form, tpl.fields, { role: me.role, ownerIds });
  if (!input) return { error: formError, fieldErrors: errors, values };

  const { data, error } = await supabase.rpc("create_case_direct", {
    p_template_id: input.p_template_id,
    p_values: input.p_values,
    // the generated types mark defaulted parameters optional, not nullable
    ...(input.p_owner_id ? { p_owner_id: input.p_owner_id } : {}),
    ...(input.p_note ? { p_note: input.p_note } : {}),
  });
  if (error) {
    const placed = placeCreateError(error.code, mapDbError(error).message, tpl.fields);
    return { error: placed.formError, fieldErrors: placed.fieldErrors, values };
  }
  const ref = data?.[0]?.case_ref;
  if (!ref) return { error: "The case was not created. Try again.", fieldErrors: {}, values };

  await setFlash(`Case ${ref} created.`);
  revalidatePath("/cases");
  revalidatePath("/dashboard");
  redirect(caseHref(ref));
}
