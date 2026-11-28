import { createClient } from "@/lib/supabase/server";
import type { Enums } from "@/lib/database.types";
import { workloadMaps } from "@/lib/workload";
import { availabilityNote, sortChecklistOptions, type ChecklistOption, type TaskKind, type TaskStatus } from "@/lib/tasks";

/** Shared by the assign page and its server action, so both offer and accept the same choices. */

type Supabase = Awaited<ReturnType<typeof createClient>>;

const CASE_SELECT =
  "id, case_ref, status, claim_type, insurer_id, template_id, insurer_claim_no, due_at, insurers(name, code), owner:profiles!cases_office_owner_id_fkey(full_name)";

export type CaseForTask = {
  id: string;
  case_ref: string;
  status: string;
  claim_type: Enums<"claim_type">;
  insurer_id: string;
  template_id: string | null;
  insurer_claim_no: string;
  due_at: string | null;
  insurer_name: string | null;
  owner_name: string | null;
};

export type Operator = {
  id: string;
  full_name: string;
  region: string | null;
  open_tasks: number;
  availability: string | null;
};

export type CaseTask = {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: string;
  completed_at: string | null;
};

export async function loadCase(supabase: Supabase, by: { ref: string } | { id: string }): Promise<CaseForTask | null | "error"> {
  const q = supabase.from("cases").select(CASE_SELECT);
  const { data, error } = await ("ref" in by ? q.eq("case_ref", by.ref) : q.eq("id", by.id)).maybeSingle();
  if (error) return "error";
  if (!data) return null;
  return {
    id: data.id,
    case_ref: data.case_ref,
    status: data.status,
    claim_type: data.claim_type,
    insurer_id: data.insurer_id,
    template_id: data.template_id,
    insurer_claim_no: data.insurer_claim_no,
    due_at: data.due_at,
    insurer_name: data.insurers?.name ?? null,
    owner_name: data.owner?.full_name ?? null,
  };
}

/** Active field operators with their open-task load and availability (when set). */
export async function loadOperators(supabase: Supabase, now: Date): Promise<Operator[] | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, region, availability, availability_until")
    .eq("role", "field")
    .eq("is_active", true)
    .order("full_name")
    .limit(500);
  if (error) return null;
  const { data: open } = data?.length ? await supabase.rpc("staff_workload") : { data: [] };
  const load = workloadMaps(open ?? []).openTasks;
  return (data ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    region: p.region,
    open_tasks: load.get(p.id) ?? 0,
    availability: availabilityNote(p.availability, p.availability_until, now),
  }));
}

function itemCount(v: { count: number }[] | null | undefined): number {
  return v?.[0]?.count ?? 0;
}

/**
 * Checklists offered for a case: the in-use checklists linked to its case template (D20, D42), default first.
 * When the case has no template or no in-use link: in-use checklists of its claim type for its insurer or all insurers.
 */
export async function loadChecklistOptions(supabase: Supabase, c: CaseForTask): Promise<ChecklistOption[]> {
  if (c.template_id) {
    const { data } = await supabase
      .from("case_template_checklists")
      .select("is_default, checklist_templates!inner(id, name, is_active, checklist_template_items(count))")
      .eq("template_id", c.template_id)
      .eq("checklist_templates.is_active", true);
    const linked = (data ?? []).map((l) => ({
      id: l.checklist_templates.id,
      name: l.checklist_templates.name,
      items: itemCount(l.checklist_templates.checklist_template_items),
      is_default: l.is_default,
    }));
    if (linked.length) return sortChecklistOptions(linked);
  }
  const { data } = await supabase
    .from("checklist_templates")
    .select("id, name, checklist_template_items(count)")
    .eq("is_active", true)
    .eq("claim_type", c.claim_type)
    .or(`insurer_id.is.null,insurer_id.eq.${c.insurer_id}`)
    .limit(100);
  return sortChecklistOptions((data ?? []).map((t) => ({ id: t.id, name: t.name, items: itemCount(t.checklist_template_items), is_default: false })));
}

/** Tasks of the case, newest first (possible parents of a re-investigation). */
export async function loadCaseTasks(supabase: Supabase, caseId: string): Promise<CaseTask[]> {
  const { data } = await supabase
    .from("tasks")
    .select("id, title, kind, status, assignee_id, created_at, completed_at, assignee:profiles!tasks_assignee_id_fkey(full_name)")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    assignee_id: t.assignee_id,
    assignee_name: t.assignee?.full_name ?? null,
    created_at: t.created_at,
    completed_at: t.completed_at,
  }));
}
