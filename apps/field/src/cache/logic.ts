// Pure cache rules: message trimming, new-task detection for held files.
export const MESSAGE_LIMIT = 200;

/** Keeps the newest `limit` messages (input in any order, output oldest first). */
export function trimMessages<T extends { created_at: string }>(msgs: readonly T[], limit = MESSAGE_LIMIT): T[] {
  return [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-limit);
}

export interface OpenTask { task_id: string; case_id: string; created_at?: string }

/**
 * Open tasks seen for the first time on a case that has held files: one `{caseId, taskId}` per case
 * (the newest new task), so `outbox.retryHeld` runs once per new task. `known` = task ids already seen
 * (null = never stored, so every open task counts as new).
 */
export function newTasksForHeld(
  open: readonly OpenTask[], known: ReadonlySet<string> | null, heldCaseIds: ReadonlySet<string>,
): { caseId: string; taskId: string }[] {
  const byCase = new Map<string, OpenTask>();
  for (const t of open) {
    if (!heldCaseIds.has(t.case_id) || known?.has(t.task_id)) continue;
    const cur = byCase.get(t.case_id);
    if (!cur || (t.created_at ?? '') >= (cur.created_at ?? '')) byCase.set(t.case_id, t);
  }
  return [...byCase.values()].map((t) => ({ caseId: t.case_id, taskId: t.task_id }));
}
