import { createClient } from "@/lib/supabase/server";
import {
  bestMatchScores,
  buildWorkspace,
  focusSection,
  MATCH_MIN_SCORE,
  sectionEvidence,
  type PanelFile,
  type PanelGroups,
  type VersionRow,
  type WorkspaceSection,
} from "@/lib/reports";
import type { Enums } from "@/lib/database.types";
import { toCachedFile } from "@/lib/file-cache/view-core";
import { ocrDisplay } from "@/lib/ocr-display";
import type { SendRow, SendTarget } from "@/lib/report-send-core";

type Supabase = Awaited<ReturnType<typeof createClient>>;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export type Workspace = {
  case: {
    id: string;
    case_ref: string;
    status: Enums<"case_status">;
    insurer_claim_no: string;
    due_at: string | null;
    office_owner_id: string | null;
    owner: string | null;
    insurer: { name: string; code: string } | null;
  };
  template: {
    id: string;
    name: string;
    variant: string;
    version: number;
    requires_approval: boolean;
    output_formats: string[];
    default_output_format: string;
    report_email: unknown;
    is_active: boolean;
  } | null;
  sections: WorkspaceSection[];
  focused: WorkspaceSection | null;
  focusedCategories: { id: string; name: string }[];
  panel: PanelGroups<PanelFile>;
  labelOptions: { id: string; name: string }[];
  pendingSuggestions: number;
  versions: VersionRow[];
  lastSubmission: { submitted_at: string; channel: Enums<"submission_channel"> } | null;
  /** 8.2: report emails of the case, newest first. */
  sends: SendRow[];
  /** report_send_target(): the insurer's latest mail to reply to; null when none or not allowed. */
  sendTarget: SendTarget | null;
  /** Field values by key (subject / file name patterns). */
  valuesByKey: Record<string, string>;
};

/** Everything the workspace shows, read with the user's session (RLS applies). null = not found, "error" = load failed. */
export async function loadWorkspace(supabase: Supabase, caseRef: string, requestedSection: string | null): Promise<Workspace | null | "error"> {
  const { data: c, error } = await supabase
    .from("cases")
    .select(
      "id, case_ref, status, insurer_claim_no, due_at, office_owner_id, template_id, insurers(name, code), owner:profiles!cases_office_owner_id_fkey(full_name), case_templates(id, name, variant, version, requires_approval, output_formats, default_output_format, report_email, is_active)",
    )
    .eq("case_ref", caseRef)
    .maybeSingle();
  if (error) return "error";
  if (!c) return null;

  const tpl = one(c.case_templates);
  const base = {
    id: c.id,
    case_ref: c.case_ref,
    status: c.status,
    insurer_claim_no: c.insurer_claim_no,
    due_at: c.due_at,
    office_owner_id: c.office_owner_id,
    owner: one(c.owner)?.full_name ?? null,
    insurer: one(c.insurers),
  };

  const [sectionsRes, fieldsRes, valuesRes, sectionCatsRes, categoriesRes, evidenceRes, processingRes, reportsRes, submissionRes, sendsRes, targetRes] = await Promise.all([
    tpl ? supabase.from("case_template_sections").select("id, key, title, position, guidance").eq("template_id", tpl.id) : null,
    tpl
      ? supabase.from("case_template_fields").select("id, section_id, key, label, field_type, source, is_required, options, help_text, position").eq("template_id", tpl.id)
      : null,
    supabase.from("case_field_values").select("field_id, value, source, updated_at").eq("case_id", c.id),
    tpl
      ? supabase
          .from("case_template_section_categories")
          .select("section_id, category_id, position, case_template_sections!inner(template_id)")
          .eq("case_template_sections.template_id", tpl.id)
      : null,
    supabase.from("evidence_categories").select("id, code, name"),
    supabase
      .from("evidence")
      .select(
        "id, case_id, sha256, size_bytes, evidence_type, mime_type, original_filename, storage_backend, storage_path, capture_source, server_received_at, relevance, evidence_labels(category_id, confidence, source, is_active, description), evidence_derivatives(width, sha256, size_bytes, pixel_width), evidence_ocr(engine, text, summary, is_current, created_at, page_no, mean_confidence)",
      )
      .eq("case_id", c.id)
      .is("withdrawn_at", null)
      .neq("evidence_type", "note")
      .eq("evidence_labels.is_active", true)
      .order("server_received_at", { ascending: false })
      .limit(1000),
    supabase.from("v_evidence_processing").select("evidence_id, state").eq("case_id", c.id).limit(1000),
    supabase
      .from("reports")
      .select(
        "id, version, origin, created_at, notes, creator:profiles!reports_uploaded_by_fkey(full_name), report_files(format, size_bytes), report_approvals(id, decision, requested_by, requested_at, decided_at, comments, requester:profiles!report_approvals_requested_by_fkey(full_name), decider:profiles!report_approvals_decided_by_fkey(full_name))",
      )
      .eq("case_id", c.id)
      .order("version", { ascending: false }),
    supabase.from("submissions").select("submitted_at, channel").eq("case_id", c.id).order("submitted_at", { ascending: false }).limit(1),
    supabase
      .from("report_sends")
      .select(
        "id, report_id, status, formats, to_addresses, cc_addresses, subject, requested_at, sent_at, attempts, error, test_recipient, requester:profiles!report_sends_requested_by_fkey(full_name)",
      )
      .eq("case_id", c.id)
      .order("requested_at", { ascending: false })
      .limit(20),
    // Raises 42501 for staff who do not manage the case: then there is simply no target.
    supabase.rpc("report_send_target", { p_case_id: c.id }),
  ]);
  if (sectionsRes?.error || fieldsRes?.error || valuesRes.error || evidenceRes.error || reportsRes.error) return "error";

  const sections = buildWorkspace(sectionsRes?.data ?? [], fieldsRes?.data ?? [], valuesRes.data ?? []);
  const focused = focusSection(sections, requestedSection);
  const catName = new Map((categoriesRes.data ?? []).map((k) => [k.id, k.name]));
  const sectionCats = [...(sectionCatsRes?.data ?? [])].sort((a, b) => a.position - b.position);
  const focusedCatIds = focused ? sectionCats.filter((r) => r.section_id === focused.id).map((r) => r.category_id) : [];

  // Field matches and suggestions only for the focused section's fields, and only for this case's files.
  const focusedFieldIds = focused?.fields.map((f) => f.id) ?? [];
  const [matchesRes, suggestionsRes] = focusedFieldIds.length
    ? await Promise.all([
        supabase
          .from("evidence_field_matches")
          .select("evidence_id, score, evidence!inner(case_id)")
          .eq("evidence.case_id", c.id)
          .in("field_id", focusedFieldIds)
          .gte("score", MATCH_MIN_SCORE)
          .limit(2000),
        supabase
          .from("field_suggestions")
          .select("id, evidence!inner(case_id)", { count: "exact", head: true })
          .eq("evidence.case_id", c.id)
          .in("field_id", focusedFieldIds)
          .eq("status", "pending"),
      ])
    : [null, null];
  const scores = bestMatchScores(matchesRes?.data ?? []);
  const processing = new Map((processingRes.data ?? []).map((p) => [p.evidence_id, p.state]));

  const files: PanelFile[] = (evidenceRes.data ?? []).map((e) => {
    const labels = (e.evidence_labels ?? []).filter((l) => l.is_active);
    return {
      id: e.id,
      server_received_at: e.server_received_at,
      relevance: e.relevance,
      categoryIds: labels.map((l) => l.category_id),
      type: e.evidence_type,
      name: e.original_filename ?? `${e.evidence_type} ${e.id.slice(0, 8)}`,
      mime: e.mime_type,
      source: e.capture_source,
      backend: e.storage_backend,
      labels: labels.map((l) => ({ categoryId: l.category_id, name: catName.get(l.category_id) ?? "Unknown", confidence: l.confidence, source: l.source })),
      description: labels.find((l) => l.description)?.description ?? null,
      ocr: ocrDisplay(e.evidence_ocr),
      processing: processing.get(e.id) ?? null,
      matchScore: scores.get(e.id) ?? null,
      // Thumbnails / previews load in the browser through the hash-checked file cache (no links signed per render).
      file: e.storage_path ? toCachedFile(e) : null,
    };
  });
  const groups = sectionEvidence(files, focusedCatIds, scores);


  // Label choices: the template's categories first (section order), then whatever is already applied.
  const optionIds = [...new Set([...sectionCats.map((r) => r.category_id), ...files.flatMap((f) => f.categoryIds)])];

  const versions: VersionRow[] = (reportsRes.data ?? []).map((r) => {
    const a = one(r.report_approvals);
    return {
      id: r.id,
      version: r.version,
      origin: r.origin,
      created_at: r.created_at,
      notes: r.notes,
      creator: one(r.creator)?.full_name ?? null,
      files: (r.report_files ?? []).map((f) => ({ format: f.format, size_bytes: f.size_bytes })),
      approval: a ? { id: a.id, decision: a.decision, requested_by: a.requested_by, requested_at: a.requested_at } : null,
      approvalDetail: a
        ? { requested_at: a.requested_at, requester: one(a.requester)?.full_name ?? null, decided_at: a.decided_at, decider: one(a.decider)?.full_name ?? null, comments: a.comments }
        : null,
    };
  });

  const sends: SendRow[] = (sendsRes.data ?? []).map((s) => ({
    id: s.id,
    report_id: s.report_id,
    status: s.status,
    formats: s.formats,
    to_addresses: s.to_addresses,
    cc_addresses: s.cc_addresses,
    subject: s.subject,
    requested_at: s.requested_at,
    sent_at: s.sent_at,
    attempts: s.attempts,
    error: s.error,
    test_recipient: s.test_recipient,
    requester: one(s.requester)?.full_name ?? null,
  }));
  const t = targetRes.error ? null : (targetRes.data?.[0] ?? null);
  const sendTarget: SendTarget | null = t
    ? { to_addresses: t.to_addresses ?? [], cc_addresses: t.cc_addresses ?? [], original_subject: t.original_subject ?? null }
    : null;
  const valuesByKey = Object.fromEntries(sections.flatMap((s) => s.fields.map((f) => [f.key, f.value] as const)));

  return {
    case: base,
    template: tpl,
    sections,
    focused,
    focusedCategories: focusedCatIds.map((id) => ({ id, name: catName.get(id) ?? "Unknown" })),
    panel: groups,
    labelOptions: optionIds.map((id) => ({ id, name: catName.get(id) ?? "Unknown" })),
    pendingSuggestions: suggestionsRes?.count ?? 0,
    versions,
    lastSubmission: submissionRes.data?.[0] ?? null,
    sends,
    sendTarget,
    valuesByKey,
  };
}
