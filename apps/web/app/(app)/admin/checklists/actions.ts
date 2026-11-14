"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { SavePayloadSchema } from "@/lib/checklists";
import { createClient } from "@/lib/supabase/server";
import { mapDbError, mapZeroRows, type DbErrorLike } from "@/lib/validation/db-errors";

export type SaveResult = { ok: true; id: string; version: number } | { ok: false; error: string; field?: "name" };
export type StatusResult = { ok: true } | { ok: false; error: string };

const RELOAD = "Reload the page and try again.";

function checklistError(error: DbErrorLike): { error: string; field?: "name" } {
  if (error?.code === "40001") return { error: "This checklist was changed by someone else. Reload to see their changes." };
  if (error?.code === "23505" && /uq_active_template/.test(error.message ?? "")) {
    return { error: "Another checklist in use for this claim type and insurer has this name.", field: "name" };
  }
  return { error: mapDbError(error).message };
}

/** Save through save_checklist_template() (one transaction; RLS: admin only). Never touches task_checklist_items. */
export async function saveChecklistAction(input: unknown): Promise<SaveResult> {
  await requireRole(["admin"]);
  const parsed = SavePayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields." };
  const p = parsed.data;
  const supabase = await createClient();
  // The generated types mark the nullable arguments as string; null means "create" / "all insurers".
  const { data, error } = await supabase.rpc("save_checklist_template", {
    p_template_id: p.id as string,
    p_expected_version: p.expected_version as number,
    p_name: p.name,
    p_claim_type: p.claim_type,
    p_insurer_id: p.insurer_id as string,
    p_items: p.items,
  });
  if (error) return { ok: false, ...checklistError(error) };
  const row = data?.[0];
  if (!row) return { ok: false, error: mapZeroRows().message };
  revalidatePath("/admin/checklists", "layout");
  return { ok: true, id: row.id, version: row.version };
}

/** Put in use via activate_checklist_template() (swaps out the same-name one); take out of use is a plain RLS update. */
export async function setInUseAction(id: string, inUse: boolean): Promise<StatusResult> {
  await requireRole(["admin"]);
  if (!z.guid().safeParse(id).success || typeof inUse !== "boolean") return { ok: false, error: RELOAD };
  const supabase = await createClient();
  if (inUse) {
    const { error } = await supabase.rpc("activate_checklist_template", { p_id: id });
    if (error) return { ok: false, ...checklistError(error) };
  } else {
    const { data, error } = await supabase.from("checklist_templates").update({ is_active: false }).eq("id", id).select("id");
    if (error) return { ok: false, ...checklistError(error) };
    if (!data || data.length !== 1) return { ok: false, error: mapZeroRows().message };
  }
  revalidatePath("/admin/checklists", "layout");
  return { ok: true };
}
