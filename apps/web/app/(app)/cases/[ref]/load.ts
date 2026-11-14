import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isCaseRef } from "@/lib/cases";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

const CASE_SELECT =
  "id, case_ref, insurer_claim_no, claim_type, status, received_at, due_at, closed_at, policy_no, claim_amount, incident_date, suspicion_summary, template_id, office_owner_id, office_assigned_at, assignment_method, insurers(name, code, tat_days), case_templates(name, variant, version), owner:profiles!cases_office_owner_id_fkey(id, full_name, is_active), orchestrator:profiles!cases_orchestrator_id_fkey(full_name)";

/** The route param as a case ref (null when it cannot be one). */
export function refParam(raw: string): string | null {
  let ref = raw;
  try {
    ref = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isCaseRef(ref) ? ref : null;
}

/**
 * The case header, loaded once per request and shared by the case layout and its tabs (RLS: staff read all cases).
 * null = no such case; "error" = the query failed.
 */
export const loadCase = cache(async (ref: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("cases").select(CASE_SELECT).eq("case_ref", ref).maybeSingle();
  if (error) return "error" as const;
  if (!data) return null;
  return {
    ...data,
    insurers: one(data.insurers),
    case_templates: one(data.case_templates),
    owner: one(data.owner),
    orchestrator: one(data.orchestrator),
  };
});

export type LoadedCase = Exclude<Awaited<ReturnType<typeof loadCase>>, "error" | null>;
