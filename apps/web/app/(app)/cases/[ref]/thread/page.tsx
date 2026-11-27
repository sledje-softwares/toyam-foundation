import { notFound } from "next/navigation";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { chronological, MESSAGE_MAX, THREAD_LIMIT } from "@/lib/cases";
import { EmptyState, ErrorState } from "@/components/ui";
import { Composer } from "@/components/cases/composer";
import { ThreadView, type ThreadMessage } from "@/components/cases/thread-view";
import { postCaseMessageAction } from "../actions";
import { loadCase, refParam } from "../load";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default async function CaseThreadPage({ params }: { params: Promise<{ ref: string }> }) {
  await requireRole(STAFF_ROLES);
  const ref = refParam((await params).ref);
  const c = ref ? await loadCase(ref) : null;
  if (!c || c === "error") notFound();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("case_messages")
    .select(
      "id, created_at, kind, body, visibility, withdrawn_at, sender:profiles!case_messages_sender_id_fkey(full_name, role), task:tasks!case_messages_task_id_fkey(title, kind, status), files:evidence!evidence_message_id_fkey(id, original_filename, evidence_type, withdrawn_at, comments:evidence_comments(id))",
    )
    .eq("case_id", c.id)
    .order("created_at", { ascending: false })
    .limit(THREAD_LIMIT);

  // Read pointer for ticks / unread counts; failure is not worth an error on screen.
  await supabase.rpc("mark_thread_read", { p_case_id: c.id });

  const messages: ThreadMessage[] = chronological(
    (data ?? []).map((m) => ({ ...m, sender: one(m.sender), task: one(m.task), files: m.files ?? [] })),
  );

  return (
    <div className="max-w-4xl space-y-4">
      {error ? (
        <ErrorState what="The thread" />
      ) : messages.length === 0 ? (
        <EmptyState title="No messages yet" description="System events, requests, field uploads and notes appear here." />
      ) : (
        <>
          {messages.length >= THREAD_LIMIT && (
            <p className="text-sm text-text-muted">Showing the latest {THREAD_LIMIT} messages.</p>
          )}
          <ThreadView messages={messages} />
        </>
      )}
      <Composer caseId={c.id} caseRef={c.case_ref} action={postCaseMessageAction} maxLength={MESSAGE_MAX} />
    </div>
  );
}
