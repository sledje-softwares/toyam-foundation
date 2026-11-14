"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { CLAIM_KEY, MAX_VALUE_LENGTH, readSubmittedValues, requiredErrors } from "@/lib/intake-review";
import { mapDbError } from "@/lib/validation/db-errors";

export type ConfirmState = {
  error: string | null;
  fieldErrors: Record<string, string>;
  /** What was submitted, so the form keeps it after a failed attempt. */
  values: Record<string, string>;
};

const ConfirmInput = z.object({
  extraction_id: z.guid(),
  template_id: z.guid({ message: "Choose a template." }),
  values: z.record(z.string(), z.string().max(MAX_VALUE_LENGTH, { message: `At most ${MAX_VALUE_LENGTH} characters.` })),
});

/** Creates the case from a review-queue item: public.confirm_intake(p_extraction_id uuid, p_template_id uuid, p_values jsonb). */
export async function confirmIntake(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  await requireRole(STAFF_ROLES);
  const supabase = await createClient();

  const extractionId = String(formData.get("extraction_id") ?? "");
  const templateId = String(formData.get("template_id") ?? "");

  // Only the chosen template's intake fields (plus the claim number) are sent.
  const { data: fields, error: fieldsError } = z.guid().safeParse(templateId).success
    ? await supabase.from("case_template_fields").select("key, is_required").eq("template_id", templateId).eq("source", "intake")
    : { data: [], error: null };
  if (fieldsError) return { error: mapDbError(fieldsError).message, fieldErrors: {}, values: {} };

  const values = readSubmittedValues(formData.entries(), [CLAIM_KEY, ...(fields ?? []).map((f) => f.key)]);
  const parsed = ConfirmInput.safeParse({ extraction_id: extractionId, template_id: templateId, values });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "values" && typeof issue.path[1] === "string") fieldErrors[issue.path[1]] = issue.message;
    }
    const top = parsed.error.issues.find((i) => i.path[0] !== "values");
    return { error: top ? (top.path[0] === "template_id" ? top.message : "Reload the page and try again.") : "Check the highlighted fields.", fieldErrors, values };
  }

  const missing = requiredErrors(fields ?? [], values);
  if (Object.keys(missing).length) {
    return { error: "Fill in the required fields before creating the case.", fieldErrors: missing, values };
  }

  const { data: caseId, error } = await supabase.rpc("confirm_intake", {
    p_extraction_id: parsed.data.extraction_id,
    p_template_id: parsed.data.template_id,
    p_values: parsed.data.values,
  });
  if (error || !caseId) return { error: mapDbError(error).message, fieldErrors: {}, values };

  const { data: created } = await supabase.from("cases").select("case_ref").eq("id", caseId).maybeSingle();
  // confirm_intake returns the existing case when the claim number is already known, so the wording is neutral.
  await setFlash(created?.case_ref ? `Intake confirmed: case ${created.case_ref}.` : "Intake confirmed.");
  revalidatePath("/intake", "layout");
  redirect(created?.case_ref ? `/cases/${encodeURIComponent(created.case_ref)}` : "/intake");
}

const RejectInput = z.object({
  extraction_id: z.guid(),
  reason: z
    .string()
    .trim()
    .min(3, { message: "Give a reason for dismissing this email." })
    .max(500, { message: "Keep the reason under 500 characters." }),
});

/** Dismisses a review-queue item: public.reject_intake(p_extraction_id uuid, p_reason text). */
export async function rejectIntake(formData: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const id = String(formData.get("extraction_id") ?? "");
  const back = z.guid().safeParse(id).success ? `/intake/${id}` : "/intake";

  const parsed = RejectInput.safeParse({ extraction_id: id, reason: String(formData.get("reason") ?? "") });
  if (!parsed.success) {
    await setFlash(parsed.error.issues[0]?.message ?? "Not dismissed. Try again.", "error");
    redirect(back);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_intake", {
    p_extraction_id: parsed.data.extraction_id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    await setFlash(mapDbError(error).message, "error");
    redirect(back);
  }

  await setFlash("Email dismissed from the intake queue.");
  revalidatePath("/intake", "layout");
  redirect("/intake");
}
