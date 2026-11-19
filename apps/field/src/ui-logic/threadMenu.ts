// Pure text for the thread menu (D41) and the sending-progress notification.
import { outboxHeader } from '../outbox/selectors';
import type { OutboxItem } from '../outbox/types';
import type { ChecklistRow } from './offline';

/** "Checklist (k/n)"; plain "Checklist" while nothing is cached. k counts items already ticked by the server. */
export function checklistMenuLabel(rows: readonly ChecklistRow[] | null | undefined): string {
  if (!rows || rows.length === 0) return 'Checklist';
  const k = rows.filter((r) => r.status !== 'pending' || r.evidence_count > 0).length;
  return `Checklist (${k}/${rows.length})`;
}

/** Thread menu entry for the Outbox (gap 30): always listed, "Outbox (N)" while files wait. */
export function threadOutboxLabel(items: readonly OutboxItem[]): string {
  return outboxHeader(items).menu_label ?? 'Outbox';
}

export interface SendingProgress { k: number; n: number }

/** Notification wording; null removes the notification. */
export function sendingNotificationText(s: SendingProgress | null): string | null {
  if (!s || s.n <= 0) return null;
  return `Sending ${Math.min(s.k, s.n)} of ${s.n} ${s.n === 1 ? 'file' : 'files'}`;
}
