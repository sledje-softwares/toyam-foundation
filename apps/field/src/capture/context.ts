// What the composer needs about a case (pure): the operator's open task and the checklist's categories.

export interface Chip {
  code: string;
  name: string;
}

export interface CaptureContext {
  /** Open task (pending / in progress) of this operator on the case; null = completed (text only). */
  taskId: string | null;
  chips: Chip[];
  /** ISO time of the last successful load. */
  loadedAt: string;
}

/** Newest open task, from rows the RLS already limits to this operator. */
export function openTaskId(rows: readonly { id: string; status: string; created_at: string }[]): string | null {
  const open = rows.filter((r) => r.status === 'pending' || r.status === 'in_progress');
  open.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return open[0]?.id ?? null;
}

/** One chip per category used by the case checklist, in checklist order; inactive categories skipped. */
export function chipsFrom(
  checklist: readonly { category_id: string | null; position?: number | null }[],
  categories: readonly { id: string; code: string; name: string; is_active?: boolean }[],
): Chip[] {
  const byId = new Map(categories.filter((c) => c.is_active !== false).map((c) => [c.id, c]));
  const rows = [...checklist].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const out: Chip[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const c = r.category_id ? byId.get(r.category_id) : undefined;
    if (!c || seen.has(c.code)) continue;
    seen.add(c.code);
    out.push({ code: c.code, name: c.name });
  }
  return out;
}

/** Attach state shown by the composer. */
export type AttachState = { kind: 'ready'; taskId: string } | { kind: 'completed'; text: string } | { kind: 'unknown'; text: string };

export const UNKNOWN_TEXT = 'Connect to the internet once to load this case before adding photos.';

export function attachState(ctx: CaptureContext | null, completedText: string): AttachState {
  if (!ctx) return { kind: 'unknown', text: UNKNOWN_TEXT };
  return ctx.taskId ? { kind: 'ready', taskId: ctx.taskId } : { kind: 'completed', text: completedText };
}
