import { formatDateTime } from "@/lib/format";
import { isOverdue, TASK_KIND_LABELS, type TaskKind } from "@/lib/tasks";
import { Badge } from "@/components/ui";

export function TaskKindBadge({ kind }: { kind: TaskKind }) {
  const k = TASK_KIND_LABELS[kind];
  return <Badge tone={k.tone}>{k.label}</Badge>;
}

/** Due date-time (IST) with an "Overdue" badge for open tasks past due. */
export function DueText({ task, now }: { task: { status: string; due_at: string | null }; now: Date }) {
  if (!task.due_at) return <span className="text-text-muted">No due date</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {formatDateTime(task.due_at)}
      {isOverdue(task, now) && <Badge tone="danger">Overdue</Badge>}
    </span>
  );
}
