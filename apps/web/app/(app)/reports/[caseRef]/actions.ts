"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { getFileLinks, linkErrorMessage, linkKey } from "@/lib/evidence-view";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import {
  approvalModel,
  APPROVER_ROLES,
  conflictMessage,
  editLock,
  EDITOR_ROLES,
  INITIAL_SECTION_STATE,
  parseSaveResult,
  planSectionSave,
  readSectionForm,
  REQUESTER_ROLES,
  type ActionResult,
  type LinkResult,
  type SectionState,
} from "@/lib/reports";
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

/**
 * Called by the Generate button after a version is recorded (or a run fails because values changed): the browser
 * wrote through its own session, so the server-rendered workspace must be told to drop its cached render first.
 */
export async function revalidateWorkspace(caseRef: string): Promise<void> {
  await requireRole(STAFF_ROLES);
  const ref = CaseRef.safeParse(caseRef);
  if (!ref.success) return;
  revalidateReports(ref.data);
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

/**
 * Saves the changed fields of one section through public.save_case_field_values(p_case_id, p_values, p_expected):
 * owner / orchestrator / admin only (D44, D45), editable statuses only, atomic compare-and-set per field. Fields
 * changed underneath come back as conflicts (not written); the others are saved.
 */
export async function saveSection(_prev: SectionState, fd: FormData): Promise<SectionState> {
  const me = await requireRole(EDITOR_ROLES);
  const caseId = String(fd.get("case_id") ?? "");
  const sectionId = String(fd.get("section_id") ?? "");
  const values = submittedValues(fd);
  const fail = (error: string, extra: Partial<SectionState> = {}): SectionState => ({
    error,
    fieldErrors: {},
    conflicts: {},
    conflictInfo: {},
    values,
    savedAt: null,
    saved: 0,
    ...extra,
  });
  if (!Id.safeParse(caseId).success || !Id.safeParse(sectionId).success) return fail(RELOAD);

  const supabase = await createClient();
  const { data: c, error: caseError } = await supabase
    .from("cases")
    .select("id, case_ref, status, template_id, office_owner_id")
    .eq("id", caseId)
    .maybeSingle();
  if (caseError || !c || !c.template_id) return fail(RELOAD);
  // Same rules as the database; checked here first for a clear message.
  const lock = editLock(me.role, c.status, c.office_owner_id === me.id);
  if (!lock.editable) return fail(lock.reason);

  // The section must belong to the case's template version (the database checks every field again).
  const { data: fields, error: fieldsError } = await supabase
    .from("case_template_fields")
    .select("id, key, field_type, is_required, options")
    .eq("template_id", c.template_id)
    .eq("section_id", sectionId);
  if (fieldsError || !fields?.length) return fail(RELOAD);

  const plan = planSectionSave(fields, readSectionForm(fd.entries()));
  if (Object.keys(plan.errors).length) return fail("Check the highlighted fields.", { fieldErrors: plan.errors });
  if (!plan.writes.length) return { ...INITIAL_SECTION_STATE, savedAt: Date.now() };

  const { data, error } = await supabase.rpc("save_case_field_values", {
    p_case_id: c.id,
    p_values: Object.fromEntries(plan.writes.map((w) => [w.key, w.value])),
    p_expected: Object.fromEntries(plan.writes.map((w) => [w.key, w.expected])),
  });
  if (error) {
    const mapped = mapDbError(error);
    const claim = plan.writes.find((w) => w.key === "insurer_claim_no");
    if (error.code === "23505" && claim) return fail(mapped.message, { fieldErrors: { [claim.key]: mapped.message } });
    return fail(mapped.message);
  }
  const result = parseSaveResult(data);
  if (!result) return fail(RELOAD);
  if (result.saved.length) revalidateReports(c.case_ref);

  const keys = Object.keys(result.conflicts);
  if (keys.length) {
    return fail(conflictMessage(result.saved.length, keys.length), {
      conflicts: Object.fromEntries(keys.map((k) => [k, result.conflicts[k].value])),
      conflictInfo: Object.fromEntries(keys.map((k) => [k, { by: result.conflicts[k].by, at: result.conflicts[k].at }])),
      saved: result.saved.length,
    });
  }
  return { ...INITIAL_SECTION_STATE, savedAt: Date.now(), saved: result.saved.length };
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
type RequestData = z.infer<typeof RequestInput>;

/**
 * The approval model for the version the form names, with the same rules the page shows (report_approvals_guard
 * checks owner, status and required fields again, G5). Redirects with a flash when the request is not allowed.
 */
async function checkRequest(
  supabase: Awaited<ReturnType<typeof createClient>>,
  me: { id: string; role: Parameters<typeof approvalModel>[0]["role"] },
  data: RequestData,
  oneStep: boolean,
): Promise<void> {
  const back = workspacePath(data.case_ref);
  const [c, versions, progress] = await Promise.all([
    supabase.from("cases").select("status, office_owner_id, case_templates(requires_approval)").eq("id", data.case_id).maybeSingle(),
    supabase.from("reports").select("id, version, report_approvals(id, decision, requested_by, requested_at)").eq("case_id", data.case_id),
    supabase.from("v_report_progress").select("required_total, required_filled").eq("case_id", data.case_id),
  ]);
  if (!c.data || versions.error || progress.error) {
    await setFlash(RELOAD, "error");
    redirect(back);
  }
  const model = approvalModel({
    role: me.role,
    ownsCase: c.data.office_owner_id === me.id,
    requiresApproval: oneOf(c.data.case_templates)?.requires_approval ?? true,
    status: c.data.status,
    versions: (versions.data ?? []).map((v) => ({ id: v.id, version: v.version, approval: oneOf(v.report_approvals) })),
    requiredMissing: (progress.data ?? []).reduce((n, s) => n + Math.max(0, (s.required_total ?? 0) - (s.required_filled ?? 0)), 0),
  });
  if (!model.canRequest || model.oneStep !== oneStep || model.latest?.id !== data.report_id) {
    const fallback = oneStep ? "This version cannot be approved. Reload the page." : "Approval cannot be requested for this version. Reload the page.";
    await setFlash(model.requestBlocked ?? fallback, "error");
    redirect(back);
  }
}

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
  await checkRequest(supabase, me, parsed.data, false);

  const { error } = await supabase.from("report_approvals").insert({ case_id: parsed.data.case_id, report_id: parsed.data.report_id });
  if (error) {
    await setFlash(error.code === "23505" ? "Approval was already requested for this version." : mapDbError(error).message, "error");
    redirect(back);
  }
  revalidateReports(parsed.data.case_ref);
  await setFlash("Approval requested. The orchestrators have been notified.");
  redirect(back);
}

const ApproveOwnInput = RequestInput.extend({
  comments: z.string().trim().max(2000, { message: "Keep the comment under 2000 characters." }),
});

/**
 * D47: an orchestrator / admin approves the latest version in one step through
 * public.approve_own_report(p_report_id, p_comment): request + approval by the same person in one transaction,
 * under the report_approvals_guard rules; no orchestrator notification; the case owner is told if someone else.
 */
export async function approveOwnReport(fd: FormData): Promise<void> {
  const me = await requireRole(APPROVER_ROLES);
  const parsed = ApproveOwnInput.safeParse({
    case_id: fd.get("case_id"),
    report_id: fd.get("report_id"),
    case_ref: fd.get("case_ref"),
    comments: String(fd.get("comments") ?? ""),
  });
  if (!parsed.success) {
    const caseRef = CaseRef.safeParse(fd.get("case_ref"));
    await setFlash(parsed.error.issues[0]?.path[0] === "comments" ? parsed.error.issues[0].message : RELOAD, "error");
    redirect(caseRef.success ? workspacePath(caseRef.data) : "/reports");
  }
  const back = workspacePath(parsed.data.case_ref);
  const supabase = await createClient();
  await checkRequest(supabase, me, parsed.data, true);

  const { error } = await supabase.rpc("approve_own_report", { p_report_id: parsed.data.report_id, p_comment: parsed.data.comments || undefined });
  if (error) {
    await setFlash(mapDbError(error).message, "error");
    redirect(back);
  }
  revalidateReports(parsed.data.case_ref);
  await setFlash("Report approved. It can now be sent to the insurer.");
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
/** 5-minute link to any evidence file (R2 or insurer attachment) via the evidence-view function; RLS decides. */
export async function evidenceLink(evidenceId: string): Promise<LinkResult> {
  await requireRole(STAFF_ROLES);
  if (!Id.safeParse(evidenceId).success) return { error: RELOAD, url: null };
  const r = await getFileLinks({ evidenceIds: [evidenceId] });
  if (!r.ok) return { error: r.message, url: null };
  const link = r.links.get(linkKey("evidence", evidenceId));
  return link ? { error: null, url: link.url } : { error: linkErrorMessage(r.errors.get(linkKey("evidence", evidenceId)) ?? "unavailable"), url: null };
}
