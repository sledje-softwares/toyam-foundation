import { Badge, StatusBadge } from "@/components/ui";
import { formatDateTime, ROLE_LABELS } from "@/lib/format";
import { TASK_KIND_LABELS } from "@/lib/cases";
import type { Enums } from "@/lib/database.types";

export type ThreadFile = { id: string; original_filename: string | null; evidence_type: Enums<"evidence_type">; withdrawn_at: string | null; comments?: { id: string }[] | null };

export type ThreadMessage = {
  id: string;
  created_at: string;
  kind: Enums<"message_kind">;
  body: string | null;
  visibility: string;
  withdrawn_at: string | null;
  sender: { full_name: string; role: Enums<"user_role"> } | null;
  task: { title: string; kind: Enums<"task_kind">; status: Enums<"task_status"> } | null;
  files: ThreadFile[];
};

function StaffOnly() {
  return <Badge tone="warning">Staff only</Badge>;
}

function Files({ files }: { files: ThreadFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2 text-xs">
      {files.map((f) => (
        <li key={f.id} className="rounded border border-border bg-surface px-2 py-1">
          <span aria-hidden="true">{f.evidence_type === "photo" ? "▣" : f.evidence_type === "audio" ? "♪" : "▤"} </span>
          {f.original_filename || `${f.evidence_type} file`}
          {f.comments && f.comments.length > 0 && (
            <span className="text-text-muted" title={`${f.comments.length} operator comment(s), see Evidence`}>
              {" "}
              💬 {f.comments.length}
            </span>
          )}
          {f.withdrawn_at && <span className="text-text-muted"> (withdrawn)</span>}
        </li>
      ))}
    </ul>
  );
}

/** The case thread, oldest first. Staff-only messages (D32) are amber with a "Staff only" badge. */
export function ThreadView({ messages }: { messages: ThreadMessage[] }) {
  return (
    <ol className="space-y-3" aria-label="Case thread">
      {messages.map((m) => {
        const staff = m.visibility === "staff";
        const time = (
          <time dateTime={m.created_at} className="text-xs text-text-muted">
            {formatDateTime(m.created_at)}
          </time>
        );

        if (m.kind === "system") {
          return (
            <li key={m.id} className="flex flex-wrap items-center justify-center gap-2 text-center text-sm text-text-muted">
              {time}
              <span>{m.body}</span>
              {staff && <StaffOnly />}
            </li>
          );
        }

        if (m.kind === "request") {
          return (
            <li key={m.id} className="rounded border border-blue-300 bg-primary-soft p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">Request</Badge>
                {m.task && (
                  <>
                    <span className="font-medium">{m.task.title}</span>
                    <span className="text-text-muted">{TASK_KIND_LABELS[m.task.kind]}</span>
                    <StatusBadge kind="task_status" value={m.task.status} />
                  </>
                )}
                {staff && <StaffOnly />}
                <span className="ml-auto">{time}</span>
              </div>
              {m.body && <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>}
              {m.sender && <p className="mt-1 text-xs text-text-muted">By {m.sender.full_name}</p>}
            </li>
          );
        }

        return (
          <li
            key={m.id}
            className={`rounded border p-3 text-sm ${staff ? "border-l-4 border-amber-300 border-l-amber-500 bg-warning-soft" : "border-border bg-surface"}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{m.sender?.full_name ?? "Unknown"}</span>
              {m.sender && <span className="text-xs text-text-muted">{ROLE_LABELS[m.sender.role]}</span>}
              {staff && <StaffOnly />}
              {m.task && <span className="text-xs text-text-muted">· {m.task.title}</span>}
              <span className="ml-auto">{time}</span>
            </div>
            {m.withdrawn_at ? (
              <p className="mt-1 italic text-text-muted">Message withdrawn by the sender.</p>
            ) : (
              <>
                {m.body && <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>}
                <Files files={m.files} />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
