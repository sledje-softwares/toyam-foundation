import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/format";
import { buildHistory, type HistoryEntry } from "@/lib/cases";
import { Badge, EmptyState, ErrorState } from "@/components/ui";
import type { Tone } from "@/components/ui/badge";
import { loadCase, refParam } from "../load";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

const KIND: Record<HistoryEntry["kind"], { label: string; tone: Tone }> = {
  status: { label: "Status", tone: "info" },
  assignment: { label: "Assignment", tone: "warning" },
  field: { label: "Field", tone: "neutral" },
};

export default async function CaseHistoryPage({ params }: { params: Promise<{ ref: string }> }) {
  await requireRole(STAFF_ROLES);
  const ref = refParam((await params).ref);
  const c = ref ? await loadCase(ref) : null;
  if (!c || c === "error") notFound();

  const supabase = await createClient();
  const [status, assignments, fields, labels] = await Promise.all([
    supabase
      .from("case_status_history")
      .select("id, changed_at, from_status, to_status, note, by:profiles!case_status_history_changed_by_fkey(full_name)")
      .eq("case_id", c.id)
      .order("changed_at", { ascending: false })
      .limit(500),
    supabase
      .from("case_assignments")
      .select("id, assigned_at, method, reason, assignee:profiles!case_assignments_assignee_id_fkey(full_name), by:profiles!case_assignments_assigned_by_fkey(full_name)")
      .eq("case_id", c.id)
      .order("assigned_at", { ascending: false })
      .limit(500),
    // From the audit log through a staff-only function (the audit log itself stays admin-only).
    supabase.rpc("case_field_history", { p_case_id: c.id }).limit(500),
    c.template_id
      ? supabase.from("case_template_fields").select("key, label").eq("template_id", c.template_id)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (status.error || assignments.error) return <ErrorState what="The case history" />;

  const labelOf = new Map((labels.data ?? []).map((f) => [f.key, f.label]));
  const entries = buildHistory(
    (status.data ?? []).map((s) => ({ ...s, actor: one(s.by)?.full_name ?? null })),
    (assignments.data ?? []).map((a) => ({
      id: a.id,
      assigned_at: a.assigned_at,
      method: a.method,
      reason: a.reason,
      assignee: one(a.assignee)?.full_name ?? null,
      actor: one(a.by)?.full_name ?? null,
    })),
    (fields.data ?? []).map((f) => ({ ...f, field_key: f.field_key ? (labelOf.get(f.field_key) ?? f.field_key) : null })),
  );

  return (
    <div className="max-w-4xl">
      {fields.error && (
        <p className="mb-3 text-sm text-danger">Field changes could not be loaded; status and assignment history are shown.</p>
      )}
      {entries.length === 0 ? (
        <EmptyState title="No history yet" />
      ) : (
        <ol className="divide-y divide-border rounded border border-border bg-surface text-sm" aria-label="Case history, newest first">
          {entries.map((e) => (
            <li key={e.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
              <time dateTime={e.at} className="w-40 shrink-0 text-text-muted">
                {formatDateTime(e.at)}
              </time>
              <Badge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Badge>
              <div className="min-w-0 flex-1">
                <p>
                  {e.title}
                  {e.actor && <span className="text-text-muted"> · {e.actor}</span>}
                </p>
                {e.detail && <p className="break-words text-text-muted">{e.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
