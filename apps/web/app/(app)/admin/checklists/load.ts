import { createClient } from "@/lib/supabase/server";
import { CLAIM_TYPES, isClaimType, openTaskCounts, type Category, type ClaimType, type EditorState, type OtherTemplate } from "@/lib/checklists";

export type Lookups = {
  insurers: { id: string; name: string; is_active: boolean }[];
  categories: Category[];
  /** Category ids used by the report sections of each claim type's case templates. */
  relevant: Record<ClaimType, string[]>;
  others: OtherTemplate[];
};

type Supabase = Awaited<ReturnType<typeof createClient>>;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export async function loadLookups(supabase: Supabase): Promise<Lookups | null> {
  const [ins, cats, sec, tpl] = await Promise.all([
    supabase.from("insurers").select("id, name, is_active").order("name"),
    supabase.from("evidence_categories").select("id, name, is_active").order("name"),
    supabase.from("case_template_section_categories").select("category_id, case_template_sections!inner(case_templates!inner(claim_type))").limit(5000),
    supabase.from("checklist_templates").select("id, name, claim_type, insurer_id, is_active, version").limit(2000),
  ]);
  if (ins.error || cats.error || tpl.error) return null;
  const relevant = Object.fromEntries(CLAIM_TYPES.map((c) => [c, [] as string[]])) as Record<ClaimType, string[]>;
  // Ordering only: if this lookup fails the select simply shows one list.
  for (const r of sec.data ?? []) {
    const claim = one(one(r.case_template_sections)?.case_templates)?.claim_type;
    if (isClaimType(claim) && !relevant[claim].includes(r.category_id)) relevant[claim].push(r.category_id);
  }
  return { insurers: ins.data ?? [], categories: cats.data ?? [], relevant, others: tpl.data ?? [] };
}

/** Distinct open tasks (pending / in progress) holding a copy of each template's items. */
export async function loadOpenTaskCounts(supabase: Supabase, templateIds: string[]): Promise<Record<string, number>> {
  if (templateIds.length === 0) return {};
  const { data } = await supabase
    .from("task_checklist_items")
    .select("task_id, checklist_template_items!inner(template_id), tasks!inner(status)")
    .in("checklist_template_items.template_id", templateIds)
    .in("tasks.status", ["pending", "in_progress"])
    .limit(20000);
  const rows = (data ?? []).map((r) => ({ task_id: r.task_id, template_id: one(r.checklist_template_items)?.template_id ?? null }));
  return Object.fromEntries(openTaskCounts(rows));
}

export type LoadedTemplate = { state: EditorState; is_active: boolean; updated_at: string };

export async function loadTemplate(supabase: Supabase, id: string): Promise<LoadedTemplate | null | "error"> {
  const { data, error } = await supabase
    .from("checklist_templates")
    .select("id, name, claim_type, insurer_id, is_active, version, updated_at, checklist_template_items(id, position, description, required_evidence_type, is_mandatory, camera_only, category_id)")
    .eq("id", id)
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  const items = [...(data.checklist_template_items ?? [])].sort((a, b) => a.position - b.position);
  return {
    is_active: data.is_active,
    updated_at: data.updated_at,
    state: {
      id: data.id,
      version: data.version,
      name: data.name,
      claim_type: data.claim_type,
      insurer_id: data.insurer_id ?? "",
      items: items.map((i) => ({
        key: i.id,
        id: i.id,
        description: i.description,
        required_evidence_type: i.required_evidence_type,
        is_mandatory: i.is_mandatory,
        camera_only: i.camera_only,
        category_id: i.category_id ?? "",
      })),
    },
  };
}
