"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { getFileLinks, linkErrorMessage, linkKey } from "@/lib/evidence-view";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { approvalModel, APPROVER_ROLES, editLock, EDITOR_ROLES, planSectionSave, readSectionForm, REQUESTER_ROLES, type ActionResult, type LinkResult, type SectionState } from "@/lib/reports";
import { mapDbError } from "@/lib/validation/db-errors";

const Id = z.guid();
const CaseRef = z.string().regex(/^[A-Za-z0-9_\-/]{3,40}$/);
const RELOAD = "Reload the page and try again.";

function oneOf<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function workspacePath(caseRef: string): string {
  return `/reports/${encodeURIComponent(caseRef)}`;
}

function revalidateReports(caseRef: string) {
  revalidatePath(workspacePath(caseRef));
  revalidatePath("/reports");
}

// ---------------------------------------------------------------------
// 7.1 Save a section's values
// ---------------------------------------------------------------------
function submittedValues(fd: FormData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const { values, present } = readSectionForm(fd.entries());
  for (const k of present) out[k] = values.get(k) ?? [];
  return out;
}

/** Upserts the changed fields of one section into case_field_values (source office). */
export async function saveSection(_prev: SectionState, fd: FormData): Promise<SectionState> {
  const me = await requireRole(EDITOR_ROLES);
  const caseId = String(fd.get("case_id") ?? "");
  const sectionId = String(fd.get("section_id") ?? "");
  const values = submittedValues(fd);
  const fail = (error: string, extra: Partial<SectionState> = {}): SectionState => ({
    error,
    fieldErrors: {},
    conflicts: {},
    values,
    savedAt: null,
    saved: 0,
    ...extra,
  });
  if (!Id.safeParse(caseId).success || !Id.safeParse(sectionId).success) return fail(RELOAD);

  const supabase = await createClient();
  const { data: c, error: caseError } = await supabase.from("cases").select("id, case_ref, status, template_id").eq("id", caseId).maybeSingle();
  if (caseError || !c || !c.template_id) return fail(RELOAD);
  const lock = editLock(me.role, c.status);
  if (!lock.editable) return fail(lock.reason);

  // The section must belong to the case's template version (the trigger checks every field again).
  const { data: fields, error: fieldsError } = await supabase
    .from("case_template_fields")
    .select("id, key, field_type, is_required, options")
    .eq("template_id", c.template_id)
    .eq("section_id", sectionId);
  if (fieldsError || !fields?.length) return fail(RELOAD);

  const { data: currentRows, error: currentError } = await supabase
    .from("case_field_values")
    .select("field_id, value")
    .eq("case_id", c.id)
    .in("field_id", fields.map((f) => f.id));
  if (currentError) return fail(mapDbError(currentError).message);
  const keyOf = new Map(fields.map((f) => [f.id, f.key]));
  const current = new Map((currentRows ?? []).map((r) => [keyOf.get(r.field_id) ?? "", r.value]));

  const plan = planSectionSave(fields, readSectionForm(fd.entries()), current);
  const nErr = Object.keys(plan.errors).length;
  const nConf = Object.keys(plan.conflicts).length;
  if (nErr || nConf) {
    return fail(
      nConf
        ? `${nConf === 1 ? "A field was" : `${nConf} fields were`} changed by someone else while you were editing. Their value is shown under the field; save again to replace it.`
        : "Check the highlighted fields.",
      { fieldErrors: plan.errors, conflicts: plan.conflicts },
    );
  }
  if (!plan.writes.length) return { error: null, fieldErrors: {}, conflicts: {}, values: {}, savedAt: Date.now(), saved: 0 };

  const { error } = await supabase.from("case_field_values").upsert(
    plan.writes.map((w) => ({
      case_id: c.id,
      field_id: w.field_id,
      value: w.value,
      source: "office" as const,
      confidence: null,
      source_evidence_id: null,
      source_ref: null,
    })),
    { onConflict: "case_id,field_id" },
  );
  if (error) return fail(mapDbError(error).message);

  revalidateReports(c.case_ref);
  return { error: null, fieldErrors: {}, conflicts: {}, values: {}, savedAt: Date.now(), saved: plan.writes.length };
}

// ---------------------------------------------------------------------
// 7.5 Relevance and labels
// ---------------------------------------------------------------------
const RelevanceInput = z.object({
  evidence_id: Id,
  case_ref: CaseRef,
  relevance: z.enum(["unreviewed", "relevant", "not_relevant"]),
});

/** evidence.relevance (p_evidence_staff_u; evidence_guard stamps who and when). */
export async function setRelevance(fd: FormData): Promise<ActionResult> {
  await requireRole(EDITOR_ROLES);
  const parsed = RelevanceInput.safeParse({ evidence_id: fd.get("evidence_id"), case_ref: fd.get("case_ref"), relevance: fd.get("relevance") });
  if (!parsed.success) return { error: RELOAD };
  const supabase = await createClient();
  const { data, error } = await supabase.from("evidence").update({ relevance: parsed.data.relevance }).eq("id", parsed.data.evidence_id).select("id");
  if (error || data?.length !== 1) return { error: error ? mapDbError(error).message : RELOAD };
  revalidateReports(parsed.data.case_ref);
  return { error: null };
}

const LabelsInput = z.object({
  evidence_id: Id,
  case_ref: CaseRef,
  category_ids: z.array(Id).max(5, { message: "Choose at most 5 categories." }),
});

/** public.set_evidence_labels(p_evidence_id uuid, p_category_ids uuid[]): replaces the active labels with human ones. */
export async function correctLabels(fd: FormData): Promise<ActionResult> {
  await requireRole(EDITOR_ROLES);
  const parsed = LabelsInput.safeParse({
    evidence_id: fd.get("evidence_id"),
    case_ref: fd.get("case_ref"),
    category_ids: [...new Set(fd.getAll("category_id").map(String))],
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.path[0] === "category_ids" ? parsed.error.issues[0].message : RELOAD };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_evidence_labels", { p_evidence_id: parsed.data.evidence_id, p_category_ids: parsed.data.category_ids });
  if (error) return { error: mapDbError(error).message };
  revalidateReports(parsed.data.case_ref);
  return { error: null };
}

// ---------------------------------------------------------------------
// 8.1 Approval
// ---------------------------------------------------------------------
const RequestInput = z.object({ case_id: Id, report_id: Id, case_ref: CaseRef });

/** insert report_approvals: report_approvals_guard moves the case to orchestrator_review and notifies orchestrators. */
export async function requestApproval(fd: FormData): Promise<void> {
  const me = await requireRole(REQUESTER_ROLES);
  const parsed = RequestInput.safeParse({ case_id: fd.get("case_id"), report_id: fd.get("report_id"), case_ref: fd.get("case_ref") });
  if (!parsed.success) {
    await setFlash(RELOAD, "error");
    redirect("/reports");
  }
  const back = workspacePath(parsed.data.case_ref);
  const supabase = await createClient();

  // The same rules the page shows (the database does not check required fields or the status yet: gap G5).
  const [c, versions, progress] = await Promise.all([
    supabase.from("cases").select("status, case_templates(requires_approval)").eq("id", parsed.data.case_id).maybeSingle(),
    supabase.from("reports").select("id, version, report_approvals(id, decision, requested_by, requested_at)").eq("case_id", parsed.data.case_id),
    supabase.from("v_report_progress").select("required_total, required_filled").eq("case_id", parsed.data.case_id),
  ]);
  if (!c.data || versions.error || progress.error) {
    await setFlash(RELOAD, "error");
    redirect(back);
  }
  const model = approvalModel({
    role: me.role,
    requiresApproval: oneOf(c.data.case_templates)?.requires_approval ?? true,
    status: c.data.status,
    versions: (versions.data ?? []).map((v) => ({ id: v.id, version: v.version, approval: oneOf(v.report_approvals) })),
    requiredMissing: (progress.data ?? []).reduce((n, s) => n + Math.max(0, (s.required_total ?? 0) - (s.required_filled ?? 0)), 0),
  });
  if (!model.canRequest || model.latest?.id !== parsed.data.report_id) {
    await setFlash(model.requestBlocked ?? "Approval cannot be requested for this version. Reload the page.", "error");
    redirect(back);
  }

  const { error } = await supabase.from("report_approvals").insert({ case_id: parsed.data.case_id, report_id: parsed.data.report_id });
  if (error) {
    await setFlash(error.code === "23505" ? "Approval was already requested for this version." : mapDbError(error).message, "error");
    redirect(back);
  }
  revalidateReports(parsed.data.case_ref);
  await setFlash("Approval requested. The orchestrators have been notified.");
  redirect(back);
}

const DecideInput = z
  .object({
    approval_id: Id,
    case_ref: CaseRef,
    decision: z.enum(["approved", "changes_requested"]),
    comments: z.string().trim().max(2000, { message: "Keep the comment under 2000 characters." }),
  })
  .refine((v) => v.decision !== "changes_requested" || v.comments.length >= 3, {
    message: "Say what needs to change.",
    path: ["comments"],
  });

/** update report_approvals.decision (orchestrator / admin; decided once; changes → office_review + requester notified). */
export async function decideApproval(fd: FormData): Promise<void> {
  await requireRole(APPROVER_ROLES);
  const parsed = DecideInput.safeParse({
    approval_id: fd.get("approval_id"),
    case_ref: fd.get("case_ref"),
    decision: fd.get("decision"),
    comments: String(fd.get("comments") ?? ""),
  });
  const caseRef = CaseRef.safeParse(fd.get("case_ref"));
  const back = caseRef.success ? workspacePath(caseRef.data) : "/reports";
  if (!parsed.success) {
    await setFlash(parsed.error.issues[0]?.path[0] === "comments" ? parsed.error.issues[0].message : RELOAD, "error");
    redirect(back);
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("report_approvals")
    .update({ decision: parsed.data.decision, comments: parsed.data.comments || null })
    .eq("id", parsed.data.approval_id)
    .eq("decision", "pending")
    .select("id");
  if (error || data?.length !== 1) {
    await setFlash(error ? mapDbError(error).message : "This approval was already decided. Reload to see the decision.", "error");
    redirect(back);
  }
  revalidateReports(parsed.data.case_ref);
  await setFlash(parsed.data.decision === "approved" ? "Report approved." : "Changes requested. The office has been notified.");
  redirect(back);
}

// ---------------------------------------------------------------------
// Short-lived links (files are never public)
// ---------------------------------------------------------------------
/** 60-second signed link to a generated report file (bucket `reports`, staff read). */
export async function reportFileLink(reportId: string, format: string): Promise<LinkResult> {
  await requireRole(STAFF_ROLES);
  if (!Id.safeParse(reportId).success || !["pdf", "docx"].includes(format)) return { error: RELOAD, url: null };
  const supabase = await createClient();
  const { data } = await supabase.from("report_files").select("storage_path").eq("report_id", reportId).eq("format", format).maybeSingle();
  if (!data?.storage_path) return { error: "This file is not available.", url: null };
  const signed = await supabase.storage.from("reports").createSignedUrl(data.storage_path, 60);
  if (signed.error || !signed.data) return { error: "The download link could not be created. Try again.", url: null };
  return { error: null, url: signed.data.signedUrl };
}

/** 5-minute link to any evidence file (R2 or insurer attachment) via the evidence-view function; RLS decides. */
export async function evidenceLink(evidenceId: string): Promise<LinkResult> {
  await requireRole(STAFF_ROLES);
  if (!Id.safeParse(evidenceId).success) return { error: RELOAD, url: null };
  const r = await getFileLinks({ evidenceIds: [evidenceId] });
  if (!r.ok) return { error: r.message, url: null };
  const link = r.links.get(linkKey("evidence", evidenceId));
  return link ? { error: null, url: link.url } : { error: linkErrorMessage(r.errors.get(linkKey("evidence", evidenceId)) ?? "unavailable"), url: null };
}
