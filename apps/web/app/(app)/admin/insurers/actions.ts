"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { mapDbError, mapZeroRows } from "@/lib/validation/db-errors";
import { domainConflictMessage, hasInsurerErrors, insurerErrors, mergeHints, readInsurerForm, type InsurerFieldErrors } from "@/lib/insurer-form";
import { checkTemplateFile, DOCX_MIME, templatePath } from "@/lib/template-file";

export type InsurerSaveState = { error: string | null; fieldErrors: InsurerFieldErrors; saved: boolean };
export type TemplateState = { error: string | null; uploaded: boolean };

const Id = z.guid();
const RELOAD = "Reload the page and try again.";
const BUCKET = "report-templates";

/** Create (no insurer_id) or update. Plain RLS writes under the admin's session. */
export async function saveInsurerAction(_prev: InsurerSaveState, formData: FormData): Promise<InsurerSaveState> {
  await requireRole(["admin"]);
  const rawId = String(formData.get("insurer_id") ?? "");
  const id = rawId ? rawId : null;
  if (id && !Id.safeParse(id).success) return { error: RELOAD, fieldErrors: {}, saved: false };

  const v = readInsurerForm(formData);
  const fieldErrors = insurerErrors(v);
  if (hasInsurerErrors(fieldErrors)) return { error: "Check the highlighted fields.", fieldErrors, saved: false };

  const supabase = await createClient();
  const columns = {
    name: v.name,
    code: v.code,
    sender_domains: v.sender_domains,
    tat_days: Number(v.tat_days),
    submission_channel: v.submission_channel as "email" | "portal" | "other",
    reply_to_email: v.reply_to_email || null,
    portal_url: v.portal_url || null,
  };

  const fail = (error: Parameters<typeof mapDbError>[0]): InsurerSaveState => {
    const m = mapDbError(error);
    const conflict = domainConflictMessage(error?.message ?? "");
    if (conflict) return { error: null, fieldErrors: { sender_domains: conflict }, saved: false };
    return m.field === "name" || m.field === "code" ? { error: null, fieldErrors: { [m.field]: m.message }, saved: false } : { error: m.message, fieldErrors: {}, saved: false };
  };

  if (!id) {
    const { data, error } = await supabase
      .from("insurers")
      .insert({ ...columns, extraction_hints: mergeHints({}, v.notes, v.aliases) as never })
      .select("id")
      .single();
    if (error || !data) return fail(error);
    revalidatePath("/admin/insurers", "layout");
    await setFlash("Insurer saved.");
    redirect(`/admin/insurers/${data.id}`);
  }

  // Unknown extraction_hints keys (added by M3) are kept: merge into what is stored.
  const current = await supabase.from("insurers").select("extraction_hints").eq("id", id).maybeSingle();
  if (current.error) return fail(current.error);
  if (!current.data) return { error: mapZeroRows().message, fieldErrors: {}, saved: false };
  const { data, error } = await supabase
    .from("insurers")
    .update({ ...columns, extraction_hints: mergeHints(current.data.extraction_hints, v.notes, v.aliases) as never })
    .eq("id", id)
    .select("id");
  if (error) return fail(error);
  if (!data || data.length !== 1) return { error: mapZeroRows().message, fieldErrors: {}, saved: false };
  revalidatePath("/admin/insurers", "layout");
  return { error: null, fieldErrors: {}, saved: true };
}

export async function setInsurerActiveAction(insurerId: string, active: boolean): Promise<{ error: string | null; done: boolean }> {
  await requireRole(["admin"]);
  if (!Id.safeParse(insurerId).success) return { error: RELOAD, done: false };
  const supabase = await createClient();
  const { data, error } = await supabase.from("insurers").update({ is_active: active }).eq("id", insurerId).select("id");
  if (error) return { error: mapDbError(error).message, done: false };
  if (!data || data.length !== 1) return { error: mapZeroRows().message, done: false };
  revalidatePath("/admin/insurers", "layout");
  return { error: null, done: true };
}

/** Uploads a new template version (old files are kept) and points report_template_path at it. */
export async function uploadTemplateAction(_prev: TemplateState, formData: FormData): Promise<TemplateState> {
  await requireRole(["admin"]);
  const insurerId = String(formData.get("insurer_id") ?? "");
  if (!Id.safeParse(insurerId).success) return { error: RELOAD, uploaded: false };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a .docx file first.", uploaded: false };
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const problem = checkTemplateFile({ name: file.name, size: file.size, type: file.type }, head);
  if (problem) return { error: problem, uploaded: false };

  const supabase = await createClient();
  const path = templatePath(insurerId, file.name);
  const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: DOCX_MIME, upsert: false });
  if (up.error) return { error: "The file was not uploaded. You may not have permission. Try again.", uploaded: false };
  const { data, error } = await supabase.from("insurers").update({ report_template_path: path }).eq("id", insurerId).select("id");
  if (error || !data || data.length !== 1) return { error: "The file was uploaded but the insurer was not updated. Try again.", uploaded: false };
  revalidatePath("/admin/insurers", "layout");
  return { error: null, uploaded: true };
}

/** 60-second signed link to the insurer's current template. Staff may read the bucket (RLS). */
export async function templateLinkAction(insurerId: string): Promise<{ error: string | null; url: string | null }> {
  await requireRole(["admin"]);
  if (!Id.safeParse(insurerId).success) return { error: RELOAD, url: null };
  const supabase = await createClient();
  const { data } = await supabase.from("insurers").select("report_template_path").eq("id", insurerId).maybeSingle();
  const path = data?.report_template_path;
  if (!path) return { error: "No template has been uploaded.", url: null };
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (signed.error || !signed.data) return { error: "The download link could not be created. Try again.", url: null };
  return { error: null, url: signed.data.signedUrl };
}
