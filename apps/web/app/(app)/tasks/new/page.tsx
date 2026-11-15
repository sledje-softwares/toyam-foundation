import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { SearchParams } from "@/lib/list-params";
import { canRaiseTask, caseHref, defaultKind, isCaseRef, isGuid, noFieldWorkReason } from "@/lib/tasks";
import { emptyTaskForm, parseMode, type TaskFormValues } from "@/lib/tasks-form";
import { Button, EmptyState, ErrorState, InlineAlert, PageHeader, StatusBadge, TextInput } from "@/components/ui";
import { loadCase, loadCaseTasks, loadChecklistOptions, loadOperators } from "./load";
import { TaskForm } from "./task-form";

export const metadata = { title: "Assign field task" };

function one(v: string | string[] | undefined): string {
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

/** `kind=reinvestigation` (also `re_investigation`) opens the form in request mode. */
function modeOf(sp: SearchParams) {
  const k = one(sp.kind);
  return parseMode(k === "re_investigation" ? "reinvestigation" : k);
}

export default async function NewTaskPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole(STAFF_ROLES);
  const sp = await searchParams;
  const mode = modeOf(sp);
  const reinv = mode === "reinvestigation";
  const title = reinv ? "Request re-investigation" : "Assign field task";
  const ref = one(sp.case);

  if (!ref) {
    return (
      <>
        <PageHeader title={title} breadcrumbs={[{ label: "Tasks", href: "/tasks" }, { label: title }]} />
        <form action="/tasks/new" method="get" className="flex max-w-md flex-wrap items-end gap-3">
          {reinv && <input type="hidden" name="kind" value="reinvestigation" />}
          <div className="flex-1">
            <label htmlFor="case-ref" className="mb-1 block text-sm font-medium">
              Case reference
            </label>
            <TextInput id="case-ref" name="case" required placeholder="INV-2026-000123" autoComplete="off" />
          </div>
          <Button type="submit">Continue</Button>
        </form>
        <p className="mt-3 text-sm text-text-muted">Field work is usually assigned from the case page.</p>
      </>
    );
  }
  if (!isCaseRef(ref)) notFound();

  const supabase = await createClient();
  const now = new Date();
  const c = await loadCase(supabase, { ref });
  if (c === "error") return <ErrorState what="This case" />;
  if (!c) notFound();

  const crumbs = [{ label: "Tasks", href: "/tasks" }, { label: c.case_ref, href: caseHref(c.case_ref) }, { label: title }];
  const header = (
    <>
      <PageHeader title={title} breadcrumbs={crumbs} />
      <div className="mb-5 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border bg-surface px-4 py-3 text-sm">
        <Link href={caseHref(c.case_ref)} className="font-medium text-primary underline hover:no-underline">
          {c.case_ref}
        </Link>
        <span>{c.insurer_name ?? "Unknown insurer"}</span>
        <span className="text-text-muted">Claim {c.insurer_claim_no}</span>
        <StatusBadge kind="case_status" value={c.status} />
        <span className="text-text-muted">Office: {c.owner_name ?? "not assigned"}</span>
      </div>
    </>
  );

  if (!canRaiseTask(c.status)) {
    // D46: a submitted case is reopened from Submissions (the insurer's request) before new field work.
    return (
      <>
        {header}
        <div className="max-w-3xl">
          <InlineAlert tone="warning" title="This case takes no new field work">
            {c.status === "submitted" ? (
              <>
                This case was submitted. Reopen it from{" "}
                <Link href="/submissions" className="font-medium underline hover:no-underline">
                  Submissions
                </Link>{" "}
                when the insurer asks; it goes back to office review and field work can then be assigned.
              </>
            ) : (
              noFieldWorkReason(c.status)
            )}
          </InlineAlert>
        </div>
      </>
    );
  }

  const [operators, checklists, previous] = await Promise.all([
    loadOperators(supabase, now),
    loadChecklistOptions(supabase, c),
    loadCaseTasks(supabase, c.id),
  ]);
  if (!operators) return <ErrorState what="Field operators" />;

  if (operators.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="No active field operators" description="An admin adds field operators in Users." />
      </>
    );
  }

  // Defaults. Re-investigation: the parent from the URL (or the latest task), its operator if still active, no checklist.
  const wantedParent = one(sp.parent);
  const parent = reinv ? (isGuid(wantedParent) ? previous.find((t) => t.id === wantedParent) : undefined) ?? previous[0] : undefined;
  const parentOperator = parent?.assignee_id && operators.some((o) => o.id === parent.assignee_id) ? parent.assignee_id : "";
  const defaults: TaskFormValues = {
    ...emptyTaskForm(mode),
    case_id: c.id,
    kind: reinv ? "re_investigation" : defaultKind(previous),
    parent_task_id: parent?.id ?? "",
    assignee_id: parentOperator,
    title: reinv ? "Re-investigation" : "Field investigation",
    checklist_id: reinv ? "" : (checklists.find((o) => o.is_default)?.id ?? (checklists.length === 1 ? checklists[0].id : "")),
  };

  return (
    <>
      {header}
      {reinv && (
        <p className="mb-5 max-w-3xl text-sm text-text-muted">
          A re-investigation is a new field task linked to the earlier one. The request is posted in the case thread, the
          operator is notified, and the case goes back to field work.
        </p>
      )}
      <TaskForm
        mode={mode}
        caseId={c.id}
        caseRef={c.case_ref}
        operators={operators}
        checklists={checklists}
        previous={previous}
        defaults={defaults}
        caseDueAt={c.due_at}
      />
    </>
  );
}
