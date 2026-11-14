import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatPhone, formatRelativeDay } from "@/lib/format";
import {
  canRaiseTask,
  caseHref,
  checklistProgress,
  formatBytes,
  isGuid,
  itemDone,
  lateUploadWindow,
  plural,
  settingInt,
} from "@/lib/tasks";
import { DueText, TaskKindBadge } from "@/components/tasks/task-badges";
import { Badge, ButtonLink, ErrorState, PageHeader, StatusBadge } from "@/components/ui";

export const metadata = { title: "Task" };

// One literal (not concatenated) so the client can infer the row type.
const TASK_SELECT =
  "id, title, kind, status, instructions, due_at, location_text, created_at, started_at, completed_at, parent_task_id, case_id, cases!inner(id, case_ref, status, insurer_claim_no, insurers(name, code), owner:profiles!cases_office_owner_id_fkey(full_name)), assignee:profiles!tasks_assignee_id_fkey(id, full_name, phone, region, is_active), creator:profiles!tasks_created_by_fkey(full_name)";

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside && <p className="text-sm text-text-muted">{aside}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-1">
      <dt className="text-text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const taskLink = (t: { id: string; title: string }) => (
  <Link href={`/tasks/${t.id}`} className="text-primary underline hover:no-underline">
    {t.title}
  </Link>
);

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(STAFF_ROLES);
  const { id } = await params;
  if (!isGuid(id)) notFound();

  const supabase = await createClient();
  const now = new Date();
  const { data: t, error } = await supabase.from("tasks").select(TASK_SELECT).eq("id", id).maybeSingle();
  if (error) return <ErrorState what="This task" />;
  if (!t) notFound();
  const c = t.cases;

  const [checklistRes, notesRes, holdsRes, settingsRes, outboxRes, parentRes, childrenRes, filesRes] = await Promise.all([
    supabase
      .from("v_case_checklist")
      .select("checklist_item_id, position, description, category_id, is_mandatory, status, evidence_count")
      .eq("task_id", id)
      .order("position"),
    supabase.from("task_checklist_items").select("id, note").eq("task_id", id),
    supabase
      .from("task_holds")
      .select("id, profile_id, held_from, held_until, profiles(full_name, is_active, deactivated_at)")
      .eq("task_id", id)
      .order("held_from"),
    supabase.from("app_settings").select("key, value").in("key", ["late_upload_grace_hours", "drain_window_days"]),
    supabase.rpc("case_outbox_status", { p_case_id: c.id }),
    t.parent_task_id
      ? supabase.from("tasks").select("id, title, kind, status").eq("id", t.parent_task_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("tasks").select("id, title, kind, status, created_at").eq("parent_task_id", id).order("created_at"),
    supabase.from("evidence").select("id", { count: "exact", head: true }).eq("task_id", id).is("withdrawn_at", null),
  ]);

  const items = checklistRes.data ?? [];
  const catIds = [...new Set(items.map((i) => i.category_id).filter((x): x is string => Boolean(x)))];
  const { data: cats } = catIds.length
    ? await supabase.from("evidence_categories").select("id, name").in("id", catIds)
    : { data: [] as { id: string; name: string }[] };
  const catName = new Map((cats ?? []).map((x) => [x.id, x.name]));
  const notes = new Map((notesRes.data ?? []).map((n) => [n.id, n.note]));
  const progress = checklistProgress(items);

  const setting = (k: string) => (settingsRes.data ?? []).find((s) => s.key === k)?.value;
  const graceHours = settingInt(setting("late_upload_grace_hours"), 72);
  const drainDays = settingInt(setting("drain_window_days"), 7);
  const holds = holdsRes.data ?? [];
  const holders = new Set(holds.map((h) => h.profile_id));
  const outbox = (outboxRes.data ?? []).filter((o) => holders.has(o.profile_id) && o.pending_count > 0);

  const reinvHref = `/tasks/new?case=${encodeURIComponent(c.case_ref)}&kind=reinvestigation&parent=${t.id}`;

  return (
    <>
      <PageHeader
        title={t.title}
        breadcrumbs={[{ label: "Tasks", href: "/tasks" }, { label: c.case_ref, href: caseHref(c.case_ref) }, { label: t.title }]}
        badges={
          <>
            <StatusBadge kind="task_status" value={t.status} />
            <TaskKindBadge kind={t.kind} />
          </>
        }
        actions={
          <>
            {/* Open work is discussed in the thread; a re-investigation follows up finished work. */}
            {t.status === "completed" && canRaiseTask(c.status) && (
              <ButtonLink href={reinvHref} variant="secondary">
                Request re-investigation
              </ButtonLink>
            )}
            <ButtonLink href={caseHref(c.case_ref)}>Open case</ButtonLink>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Section title="Summary">
            <dl className="text-sm">
              <Row label="Case">
                <Link href={caseHref(c.case_ref)} className="font-medium text-primary underline hover:no-underline">
                  {c.case_ref}
                </Link>{" "}
                · {c.insurers?.name ?? "Unknown insurer"} · claim {c.insurer_claim_no}{" "}
                <StatusBadge kind="case_status" value={c.status} />
                <span className="block text-text-muted">Office: {c.owner?.full_name ?? "not assigned"}</span>
              </Row>
              <Row label="Operator">
                {t.assignee ? (
                  <>
                    {t.assignee.full_name} {!t.assignee.is_active && <Badge>Inactive</Badge>}
                    <span className="block text-text-muted">
                      {[t.assignee.phone ? formatPhone(t.assignee.phone) : null, t.assignee.region].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </>
                ) : (
                  "Unassigned"
                )}
              </Row>
              <Row label="Due">
                <DueText task={t} now={now} />
              </Row>
              <Row label="Location">{t.location_text || "—"}</Row>
              <Row label="Assigned">
                {formatDateTime(t.created_at)}
                {t.creator?.full_name ? ` by ${t.creator.full_name}` : ""}
              </Row>
              <Row label="Started">{formatDateTime(t.started_at)}</Row>
              <Row label="Completed">{formatDateTime(t.completed_at)}</Row>
              <Row label="Files">{plural(filesRes.count ?? 0, "file")} received on this task</Row>
              {parentRes.data && <Row label="Follows">{taskLink(parentRes.data)}</Row>}
              {(childrenRes.data ?? []).length > 0 && (
                <Row label="Follow-ups">
                  <ul>
                    {(childrenRes.data ?? []).map((ch) => (
                      <li key={ch.id} className="flex flex-wrap items-center gap-2">
                        {taskLink(ch)} <StatusBadge kind="task_status" value={ch.status} />
                      </li>
                    ))}
                  </ul>
                </Row>
              )}
            </dl>
            <h3 className="mt-4 text-sm font-semibold">{t.kind === "re_investigation" ? "Request" : "Instructions"}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm">{t.instructions || <span className="text-text-muted">None.</span>}</p>
          </Section>
        </div>

        <div className="space-y-5">
          <Section
            title="Checklist"
            aside={
              items.length
                ? `${progress.mandatoryDone} of ${progress.mandatoryTotal} required done · ${progress.done} of ${progress.total} in all`
                : undefined
            }
          >
            {checklistRes.error ? (
              <p className="text-sm text-danger">The checklist could not be loaded.</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-text-muted">No checklist on this task.</p>
            ) : (
              <ol className="divide-y divide-border text-sm">
                {items.map((i) => {
                  const matched = i.status === "pending" && (i.evidence_count ?? 0) > 0;
                  const note = notes.get(i.checklist_item_id);
                  return (
                    <li key={i.checklist_item_id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                      <div>
                        <p className={itemDone(i) ? "" : "font-medium"}>
                          {i.position}. {i.description}
                        </p>
                        <p className="text-xs text-text-muted">
                          {[i.is_mandatory ? "Required" : "Optional", i.category_id ? catName.get(i.category_id) : null].filter(Boolean).join(" · ")}
                          {note ? ` · Note: ${note}` : ""}
                        </p>
                      </div>
                      <span className="flex items-center gap-2">
                        {matched ? <Badge tone="success">Matched</Badge> : <StatusBadge kind="checklist_status" value={i.status} />}
                        {(i.evidence_count ?? 0) > 0 && <span className="text-xs text-text-muted">{plural(i.evidence_count ?? 0, "file")}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <Section title="Phone and late uploads">
            {outboxRes.error ? (
              <p className="text-sm text-danger">Files waiting on phones could not be loaded.</p>
            ) : outbox.length === 0 ? (
              <p className="text-sm text-text-muted">No files waiting on the operator&apos;s phone.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {outbox.map((o) => (
                  <li key={o.device_id}>
                    <span className="font-medium">{o.full_name}</span>: {plural(o.pending_count, "file")}
                    {o.pending_bytes ? ` (${formatBytes(o.pending_bytes)})` : ""} waiting on phone, last online{" "}
                    {formatRelativeDay(o.reported_at, now)}
                    {!o.is_active && <Badge>Inactive</Badge>}
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mt-4 text-sm font-semibold">Who held this task</h3>
            <p className="text-xs text-text-muted">
              Files captured while an operator held the task are accepted up to {graceHours} h after the hold ended (task completed,
              cancelled or reassigned).
            </p>
            {holds.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">Nobody yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {holds.map((h) => {
                  const w = lateUploadWindow({ held_until: h.held_until, deactivated_at: h.profiles.deactivated_at }, graceHours, now, drainDays);
                  return (
                    <li key={h.id}>
                      <span className="font-medium">{h.profiles.full_name}</span> {formatDateTime(h.held_from)} →{" "}
                      {h.held_until ? formatDateTime(h.held_until) : "now"}
                      {!h.profiles.is_active && (
                        <>
                          {" "}
                          <Badge>Inactive</Badge>
                        </>
                      )}
                      <span className="block text-text-muted">
                        {w.state === "current"
                          ? "Current holder."
                          : w.state === "late_open"
                            ? `Late uploads accepted until ${formatDateTime(w.until)}.`
                            : `Late uploads closed ${formatDateTime(w.until)}.`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
