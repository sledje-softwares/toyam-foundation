// View-model helpers for the offline experience (docs/11 "Offline experience", items 1-10).
// Pure: text and state mapping only, so every visible string is covered by tests.
import {
  allSentNotification, canSignOut, CLOCK_SHEET, drainDoneText, DRAIN_PAGE, formatBytes, freshness, gentlePromptText,
  HELD_TEXT, lastTryLine, lowStorage, needsGentlePrompt, offlineBar, outboxHeader, outboxSummary, outboxTotals,
  pendingTicks, REMOVE_FILE_DIALOG, isPending, type OutboxItem, type OutboxSnapshot,
} from '../outbox';

export type Tone = 'amber' | 'neutral' | 'grey';

// 1. offline bar
export function barView(s: Pick<OutboxSnapshot, 'online' | 'items' | 'sending'>): { visible: boolean; text: string; tone: Tone } {
  const b = offlineBar(s);
  if (b.kind === 'hidden') return { visible: false, text: '', tone: 'neutral' };
  return { visible: true, text: b.text, tone: b.kind === 'offline' ? 'amber' : 'neutral' };
}

// 2. clock sheet
/** `reason`: the thread's status line for this item (gap 30, thread/model.ts pendingStatus), shown under the body. */
export function clockSheetView(item: Pick<OutboxItem, 'state' | 'last_attempt_at'>, now: Date, reason: string | null = null) {
  return {
    title: CLOCK_SHEET.title,
    body: item.state === 'held' ? HELD_TEXT : CLOCK_SHEET.body,
    // the held body already says it; other reasons (network, refused upload, sign-in) add a line
    reason: item.state === 'held' || reason === HELD_TEXT ? null : reason,
    lastTry: lastTryLine(item.last_attempt_at, now),
    primary: CLOCK_SHEET.primary,
    secondary: CLOCK_SHEET.secondary,
  };
}

// 3. outbox screen
export interface CaseName { case_ref: string; title: string | null }

export function outboxView(items: readonly OutboxItem[], names: Record<string, CaseName | undefined>, now: Date) {
  const header = outboxHeader(items);
  const cards = outboxSummary(items).map((c) => {
    const n = names[c.case_id];
    const files = items
      .filter((i) => i.case_id === c.case_id && isPending(i))
      .flatMap((i) => i.files.map((f) => ({
        messageId: i.client_message_id,
        fileId: f.id,
        label: `${f.original_filename ?? f.evidence_type} · ${formatBytes(f.size_bytes)}`,
      })));
    return {
      caseId: c.case_id,
      title: n ? `${n.case_ref}${n.title ? ` · ${n.title}` : ''}` : 'Case',
      // held cases show the spec wording instead of progress
      progressText: c.held_text ? null : c.progress_text,
      progress: c.progress,
      showProgress: c.held_text === null,
      heldText: c.held_text,
      sending: c.sending,
      lastTry: lastTryLine(c.last_attempt_at, now),
      sendNowLabel: 'Send now',
      files,
    };
  });
  return {
    title: 'Outbox',
    empty: header.empty,
    summary: header.text,
    cards,
    removeHint: 'Press and hold a file to remove it from the phone.',
    remove: REMOVE_FILE_DIALOG,
  };
}

/** Cases menu entry, hidden when the Outbox is empty. */
export const outboxMenuLabel = (items: readonly OutboxItem[]): string | null => outboxHeader(items).menu_label;

// 4. freshness
export function freshnessView(lastSyncedAt: string | null | undefined, now: Date) {
  const f = freshness(lastSyncedAt, now);
  return { text: f.text, tone: (f.stale ? 'amber' : 'grey') as Tone };
}

// 5. checklist with hollow pending ticks
export interface ChecklistRow {
  checklist_item_id: string;
  description: string;
  category_code: string | null;
  status: string;
  evidence_count: number;
}

export type TickState = 'done' | 'pending' | 'todo';

export function checklistView(
  rows: readonly ChecklistRow[], items: readonly OutboxItem[], online: boolean,
  lastSyncedAt: string | null, now: Date,
) {
  const like = rows.map((r) => ({
    id: r.checklist_item_id, category_code: r.category_code, ticked: r.status !== 'pending' || r.evidence_count > 0,
  }));
  const pending = new Map(pendingTicks(like, items, online).map((p) => [p.checklist_item_id, p.caption]));
  return {
    title: 'Checklist',
    freshness: freshnessView(lastSyncedAt, now),
    rows: rows.map((r, i) => {
      const caption = pending.get(r.checklist_item_id) ?? null;
      const state: TickState = like[i]?.ticked ? 'done' : caption ? 'pending' : 'todo';
      // hollow tick = outline only, grey; never a cross
      return { id: r.checklist_item_id, text: r.description, state, mark: state === 'done' ? '✓' : state === 'pending' ? '○✓' : '○', caption };
    }),
  };
}

// 6. notification
export const allSentContent = (count: number) => allSentNotification(count);

// 7. gentle prompt
export function promptView(items: readonly OutboxItem[], now: Date, snap: Pick<OutboxSnapshot, 'last_success_at' | 'last_prompt_at'>) {
  const t = outboxTotals(items);
  if (!needsGentlePrompt(t.oldest_queued_at, now, { lastSuccessAt: snap.last_success_at, lastPromptAt: snap.last_prompt_at })) return null;
  const n = t.files > 0 ? t.files : t.items;
  return gentlePromptText(n);
}

// 8. low storage
export function storageView(freeBytes: number | null, items: readonly OutboxItem[]) {
  if (freeBytes === null) return { banner: null, cameraDialog: null };
  const t = outboxTotals(items);
  const l = lowStorage(freeBytes, t.bytes, t.files);
  if (l.level === 'ok') return { banner: null, cameraDialog: null };
  return { banner: l.banner, cameraDialog: l.level === 'block' ? l.dialog : null };
}

// 9. sign-out
export function signOutView(items: readonly OutboxItem[]) {
  const c = canSignOut(items);
  if (c.allowed) return { allowed: true as const };
  return { allowed: false as const, title: c.title, body: c.body, openOutbox: c.buttons[0], stay: c.buttons[1] };
}

// 10. drain
export type DrainPhase = 'checking' | 'draining' | 'done';

export function drainView(items: readonly OutboxItem[], startTotal: number, phase: DrainPhase, closedSent?: number) {
  let refused = 0;
  let waiting = 0;
  let sent = 0;
  for (const i of items) {
    if (i.state === 'held') refused += i.files.length;
    else if (isPending(i)) waiting += i.files.length;
    else sent += i.files.length;
  }
  const total = Math.max(startTotal, sent + refused + waiting);
  // sent rows may be dropped once the queue empties: derive sent from the starting total
  const sentAll = Math.max(sent, total - refused - waiting);
  const done = phase === 'done' || (phase === 'draining' && waiting === 0 && total > 0);
  return {
    title: DRAIN_PAGE.title,
    body: DRAIN_PAGE.body(total),
    progress: `${sentAll} of ${total} sent`,
    done,
    total,
    fraction: total === 0 ? 1 : sentAll / total,
    sent: sentAll,
    discarded: refused,
    doneText: drainDoneText(closedSent ?? sentAll, refused),
  };
}
