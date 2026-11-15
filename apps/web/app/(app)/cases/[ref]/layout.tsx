import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { caseHref, dueState, newTaskHref } from "@/lib/cases";
import { CLAIM_TYPE_LABELS } from "@/lib/checklists";
import { templateLabel } from "@/lib/intake-review";
import { canRaiseTask } from "@/lib/tasks";
import { Badge, ButtonLink, ErrorState, PageHeader, StatusBadge } from "@/components/ui";
import { CaseTabs } from "@/components/cases/case-tabs";
import { loadCase, refParam } from "./load";

export async function generateMetadata({ params }: { params: Promise<{ ref: string }> }) {
  return { title: refParam((await params).ref) ?? "Case" };
}

export default async function CaseLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ref: string }> }) {
  await requireRole(STAFF_ROLES);
  const ref = refParam((await params).ref);
  if (!ref) notFound();
  const c = await loadCase(ref);
  if (c === "error") {
    return (
      <>
        <PageHeader title={ref} breadcrumbs={[{ label: "Cases", href: "/cases" }, { label: ref }]} />
        <ErrorState what="This case" />
      </>
    );
  }
  if (!c) notFound();

  const supabase = await createClient();
  const [messages, files] = await Promise.all([
    supabase.from("case_messages").select("id", { count: "exact", head: true }).eq("case_id", c.id),
    supabase.from("evidence").select("id", { count: "exact", head: true }).eq("case_id", c.id),
  ]);

  const due = dueState(c.due_at, c.status, new Date());
  const facts: { label: string; value: React.ReactNode }[] = [
    { label: "Insurer", value: c.insurers ? `${c.insurers.name} (${c.insurers.code})` : "—" },
    { label: "Template", value: c.case_templates ? templateLabel(c.case_templates) : CLAIM_TYPE_LABELS[c.claim_type] },
    { label: "Claim no.", value: c.insurer_claim_no },
    { label: "Received", value: formatDate(c.received_at) },
    {
      label: "Due",
      value: (
        <>
          {formatDate(c.due_at)}
          {c.insurers && <span className="text-text-muted"> (TAT {c.insurers.tat_days} d)</span>}
        </>
      ),
    },
    {
      label: "Owner",
      value: c.owner ? (
        <>
          {c.owner.full_name}
          {!c.owner.is_active && <span className="text-text-muted"> (inactive)</span>}
        </>
      ) : (
        <span className="font-medium text-warning">Unassigned</span>
      ),
    },
  ];

  const base = caseHref(c.case_ref);
  return (
    <>
      <PageHeader
        title={c.case_ref}
        breadcrumbs={[{ label: "Cases", href: "/cases" }, { label: c.case_ref }]}
        badges={
          <>
            <StatusBadge kind="case_status" value={c.status} />
            {due.kind !== "done" && <Badge tone={due.tone}>{due.label}</Badge>}
          </>
        }
        actions={
          canRaiseTask(c.status) ? (
            <>
              <ButtonLink href={newTaskHref(c.case_ref)}>Assign field task</ButtonLink>
              <ButtonLink href={newTaskHref(c.case_ref, "re_investigation")} variant="secondary">
                Request re-investigation
              </ButtonLink>
            </>
          ) : c.status === "submitted" ? (
            // D46: no field work on a submitted case until it is reopened on the insurer's request.
            <ButtonLink href="/submissions" variant="secondary">
              Reopen from Submissions
            </ButtonLink>
          ) : null
        }
      />
      <dl className="-mt-3 mb-5 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {facts.map((f) => (
          <div key={f.label} className="flex gap-1">
            <dt className="text-text-muted">{f.label}:</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      <CaseTabs
        tabs={[
          { href: base, label: "Overview" },
          { href: caseHref(c.case_ref, "thread"), label: "Thread", count: messages.count ?? undefined },
          { href: caseHref(c.case_ref, "evidence"), label: "Evidence", count: files.count ?? undefined },
          { href: caseHref(c.case_ref, "history"), label: "History" },
        ]}
      />
      {children}
    </>
  );
}
