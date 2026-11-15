import { createClient } from "@/lib/supabase/server";
import { assigneeOptions, OPEN_STATUSES } from "@/lib/cases";
import { newCaseFields, type NewCaseField, type TemplateOption } from "@/lib/new-case";

/** Shared by /cases/new and its server action, so both offer and accept the same template, fields and owners. */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type InsurerWithTemplates = { id: string; name: string; code: string; templates: TemplateOption[] };

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Active insurers that have at least one active template (in use), with those templates. */
export async function loadInsurerTemplates(supabase: Supabase): Promise<InsurerWithTemplates[] | null> {
  const { data, error } = await supabase
    .from("case_templates")
    .select("id, claim_type, variant, version, name, insurers!inner(id, name, code, is_active)")
    .eq("is_active", true)
    .eq("insurers.is_active", true)
    .order("claim_type")
    .order("variant");
  if (error) return null;
  const byInsurer = new Map<string, InsurerWithTemplates>();
  for (const t of data ?? []) {
    const i = one(t.insurers);
    if (!i) continue;
    const entry = byInsurer.get(i.id) ?? { id: i.id, name: i.name, code: i.code, templates: [] };
    entry.templates.push({ id: t.id, claim_type: t.claim_type, variant: t.variant, version: t.version, name: t.name });
    byInsurer.set(i.id, entry);
  }
  return [...byInsurer.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type TemplateForNewCase = TemplateOption & { insurer_id: string; insurer_name: string; fields: NewCaseField[] };

/** The active template with its intake fields; null when it is not (or no longer) in use; "error" on failure. */
export async function loadTemplate(supabase: Supabase, id: string): Promise<TemplateForNewCase | null | "error"> {
  const { data: t, error } = await supabase
    .from("case_templates")
    .select("id, claim_type, variant, version, name, insurer_id, insurers!inner(name, is_active)")
    .eq("id", id)
    .eq("is_active", true)
    .eq("insurers.is_active", true)
    .maybeSingle();
  if (error) return "error";
  if (!t) return null;
  const { data: rows, error: fErr } = await supabase
    .from("case_template_fields")
    .select("key, label, field_type, is_required, options, help_text, position, case_template_sections(position, title)")
    .eq("template_id", t.id)
    .eq("source", "intake");
  if (fErr) return "error";
  const fields = newCaseFields(
    (rows ?? []).map((r) => {
      const s = one(r.case_template_sections);
      return { ...r, section_position: s?.position ?? 0, section_title: s?.title ?? null };
    }),
  );
  return {
    id: t.id,
    claim_type: t.claim_type,
    variant: t.variant,
    version: t.version,
    name: t.name,
    insurer_id: t.insurer_id,
    insurer_name: one(t.insurers)?.name ?? "",
    fields,
  };
}

/** Owners an orchestrator / admin may pick: active staff, available first, then by open cases. */
export async function loadOwnerOptions(supabase: Supabase, now: Date): Promise<{ value: string; label: string }[] | null> {
  const [staff, open] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, role, availability, availability_until, max_open_cases")
      .eq("is_active", true)
      .in("role", ["office", "orchestrator", "admin"])
      .order("full_name"),
    supabase.from("cases").select("office_owner_id").in("status", OPEN_STATUSES).not("office_owner_id", "is", null).limit(10000),
  ]);
  if (staff.error || open.error) return null;
  const counts = new Map<string, number>();
  for (const r of open.data ?? []) if (r.office_owner_id) counts.set(r.office_owner_id, (counts.get(r.office_owner_id) ?? 0) + 1);
  return assigneeOptions(staff.data ?? [], counts, null, now);
}
