// Pure selectors for the UI (docs/11 "Offline experience", spec 1–10). Wording is exact.
import { relativeTime } from '../lib/time';
import { isPending, type OutboxItem } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MB = 1024 * 1024;

export const GENTLE_PROMPT_AFTER_MS = 6 * HOUR;
export const ALL_SENT_MIN_WAIT_MS = MIN;
export const LOW_STORAGE_WARN_BYTES = 500 * MB;
export const LOW_STORAGE_BLOCK_BYTES = 200 * MB;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const files = (n: number) => plural(n, 'file', 'files');

/** "512 KB", "3.4 MB", "1.2 GB". */
export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < MB) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * MB) return `${(b / MB).toFixed(1)} MB`;
  return `${(b / (1024 * MB)).toFixed(1)} GB`;
}

export interface OutboxTotals {
  /** Pending messages (queued, uploading, held), including text-only ones. */
  items: number;
  /** Files still on the phone. */
  files: number;
  bytes: number;
  held_files: number;
  /** Device clock: when the oldest waiting message was saved. */
  oldest_queued_at: string | null;
  /** Device clock: capture time of the oldest waiting file (for report_outbox_status). */
  oldest_captured_at: string | null;
}

export function outboxTotals(items: readonly OutboxItem[]): OutboxTotals {
  const t: OutboxTotals = { items: 0, files: 0, bytes: 0, held_files: 0, oldest_queued_at: null, oldest_captured_at: null };
  for (const it of items) {
    if (!isPending(it)) continue;
    t.items++;
    if (t.oldest_queued_at === null || it.created_at < t.oldest_queued_at) t.oldest_queued_at = it.created_at;
    for (const f of it.files) {
      t.files++;
      t.bytes += f.size_bytes;
      if (it.state === 'held') t.held_files++;
      if (t.oldest_captured_at === null || f.device_captured_at < t.oldest_captured_at) t.oldest_captured_at = f.device_captured_at;
    }
  }
  return t;
}

// ---------------------------------------------------------------- spec 1: offline bar

export type OfflineBar =
  | { kind: 'hidden' }
  | { kind: 'offline'; count: number; bytes: number; text: string }
  | { kind: 'sending'; k: number; n: number; text: string };

export interface BarInput {
  online: boolean;
  items: readonly OutboxItem[];
  sending: { k: number; n: number } | null;
}

export function offlineBar(s: BarInput): OfflineBar {
  const t = outboxTotals(s.items);
  if (!s.online) {
    return {
      kind: 'offline',
      count: t.files,
      bytes: t.bytes,
      text: t.files === 0 ? 'Offline · you can keep working' : `Offline · ${files(t.files)} saved on this phone`,
    };
  }
  if (s.sending && s.sending.n > 0) {
    return { kind: 'sending', k: s.sending.k, n: s.sending.n, text: `Sending ${s.sending.k} of ${s.sending.n}…` };
  }
  return { kind: 'hidden' };
}

// ---------------------------------------------------------------- spec 2: 🕓 sheet

/** "Last try: 5 min ago" or "Waiting for signal". */
export function lastTryLine(lastAttemptAt: string | null, now: Date): string {
  return lastAttemptAt ? `Last try: ${relativeTime(lastAttemptAt, now)}` : 'Waiting for signal';
}

export const CLOCK_SHEET = {
  title: 'Saved on this phone',
  body: 'This will send by itself when you have signal. You can close the app or switch off the phone — nothing will be lost.',
  primary: 'Send now',
  secondary: 'Open Outbox',
} as const;

// ---------------------------------------------------------------- spec 3: Outbox screen

export interface CaseOutboxSummary {
  case_id: string;
  /** Files of this case in the current run (sent + waiting). */
  total_files: number;
  sent_files: number;
  pending_files: number;
  pending_bytes: number;
  held_files: number;
  /** 0–1 for the progress bar. */
  progress: number;
  /** True while one of its messages is uploading. */
  sending: boolean;
  last_attempt_at: string | null;
  /** "{k} of {n} files sent". */
  progress_text: string;
  /** Shown instead of progress when every waiting file is held. */
  held_text: string | null;
}

export const HELD_TEXT = 'Waiting for the office — they can see these files';

/** One card per case with something still on the phone, oldest first. */
export function outboxSummary(items: readonly OutboxItem[]): CaseOutboxSummary[] {
  const by = new Map<string, CaseOutboxSummary & { _oldest: string }>();
  for (const it of items) {
    let s = by.get(it.case_id);
    if (!s) {
      s = {
        case_id: it.case_id, total_files: 0, sent_files: 0, pending_files: 0, pending_bytes: 0, held_files: 0,
        progress: 0, sending: false, last_attempt_at: null, progress_text: '', held_text: null, _oldest: it.created_at,
      };
      by.set(it.case_id, s);
    }
    const n = it.files.length;
    s.total_files += n;
    if (isPending(it)) {
      s.pending_files += n;
      s.pending_bytes += it.files.reduce((b, f) => b + f.size_bytes, 0);
      if (it.state === 'held') s.held_files += n;
      if (it.state === 'uploading') s.sending = true;
      if (it.created_at < s._oldest) s._oldest = it.created_at;
    } else {
      s.sent_files += n;
    }
    if (it.last_attempt_at && (!s.last_attempt_at || it.last_attempt_at > s.last_attempt_at)) s.last_attempt_at = it.last_attempt_at;
  }
  const out: CaseOutboxSummary[] = [];
  for (const { _oldest, ...s } of [...by.values()].sort((a, b) => a._oldest.localeCompare(b._oldest))) {
    if (s.pending_files === 0 && !items.some((i) => i.case_id === s.case_id && isPending(i))) continue;
    s.progress = s.total_files === 0 ? 0 : s.sent_files / s.total_files;
    s.progress_text = `${s.sent_files} of ${files(s.total_files)} sent`;
    s.held_text = s.held_files > 0 && s.held_files === s.pending_files ? HELD_TEXT : null;
    out.push(s);
  }
  return out;
}

/** Outbox header line: "{N} files · {size} saved on this phone", or the empty state. */
export function outboxHeader(items: readonly OutboxItem[]): { empty: boolean; text: string; menu_label: string | null } {
  const t = outboxTotals(items);
  if (t.items === 0) return { empty: true, text: 'Everything is sent ✓', menu_label: null };
  return { empty: false, text: `${files(t.files)} · ${formatBytes(t.bytes)} saved on this phone`, menu_label: `Outbox (${t.files})` };
}

export const REMOVE_FILE_DIALOG = {
  action: 'Remove from phone',
  body: 'Remove this file? It has not been sent to the office and will be deleted from this phone.',
  cancel: 'Keep',
  confirm: 'Remove',
} as const;

// ---------------------------------------------------------------- spec 4: freshness

export function freshness(lastSyncedAt: string | null | undefined, now: Date): { text: string; stale: boolean } {
  if (!lastSyncedAt) return { text: 'Not downloaded yet — open this case once with signal', stale: true };
  const age = now.getTime() - new Date(lastSyncedAt).getTime();
  if (Number.isNaN(age)) return { text: 'Not downloaded yet — open this case once with signal', stale: true };
  if (age < 24 * HOUR) return { text: `Updated ${relativeTime(lastSyncedAt, now)}`, stale: false };
  const d = Math.floor(age / (24 * HOUR));
  return { text: `Updated ${plural(d, 'day', 'days')} ago`, stale: true };
}

// ---------------------------------------------------------------- spec 5: hollow ticks

export interface ChecklistItemLike {
  id: string;
  category_code: string | null;
  /** Server tick (D41). */
  ticked: boolean;
}

export interface PendingTick {
  checklist_item_id: string;
  caption: 'Sending…' | 'Saved on phone';
}

/** Items covered by a waiting file (picked item or category chip) that the server has not ticked yet. */
export function pendingTicks(checklist: readonly ChecklistItemLike[], items: readonly OutboxItem[], online: boolean): PendingTick[] {
  const ids = new Set<string>();
  const cats = new Set<string>();
  for (const it of items) {
    if (!isPending(it) || it.files.length === 0) continue;
    if (it.category_code) cats.add(it.category_code);
    for (const f of it.files) if (f.checklist_item_id) ids.add(f.checklist_item_id);
  }
  const caption = online ? 'Sending…' : 'Saved on phone';
  return checklist
    .filter((c) => !c.ticked && (ids.has(c.id) || (c.category_code !== null && cats.has(c.category_code))))
    .map((c) => ({ checklist_item_id: c.id, caption }));
}

// ---------------------------------------------------------------- spec 6: all sent

export interface SendBatch {
  /** Files stored since the queue was last empty. */
  sent: number;
  oldest_queued_at: string | null;
  last_case_id: string | null;
}

export const emptyBatch = (): SendBatch => ({ sent: 0, oldest_queued_at: null, last_case_id: null });

/** Fires when the queue is empty, something was sent, and a file waited ≥ 1 min. Reset the batch after. */
export function allSentEvent(batch: SendBatch, pendingFiles: number, now: Date): { count: number; case_id: string | null } | null {
  if (pendingFiles > 0 || batch.sent === 0 || !batch.oldest_queued_at) return null;
  if (now.getTime() - new Date(batch.oldest_queued_at).getTime() < ALL_SENT_MIN_WAIT_MS) return null;
  return { count: batch.sent, case_id: batch.last_case_id };
}

export function allSentNotification(count: number): { title: string; body: string } {
  return { title: `All ${count} files sent ✓`, body: 'The office has them now.' };
}

// ---------------------------------------------------------------- spec 7: gentle prompt

/**
 * True once per 6-hour stretch with files waiting and no successful send.
 * The stretch starts at the latest of: oldest waiting file, last successful send, last prompt.
 */
export function needsGentlePrompt(
  oldestQueuedAt: string | null,
  now: Date,
  opts: { lastSuccessAt?: string | null; lastPromptAt?: string | null } = {},
): boolean {
  if (!oldestQueuedAt) return false;
  const from = Math.max(
    new Date(oldestQueuedAt).getTime(),
    opts.lastSuccessAt ? new Date(opts.lastSuccessAt).getTime() : -Infinity,
    opts.lastPromptAt ? new Date(opts.lastPromptAt).getTime() : -Infinity,
  );
  return now.getTime() - from >= GENTLE_PROMPT_AFTER_MS;
}

export function gentlePromptText(n: number): { title: string; body: string; button: string } {
  return {
    title: `${files(n)} ${n === 1 ? 'is' : 'are'} still on this phone`,
    body: 'They will send by themselves when you have signal. If you are on Wi-Fi or mobile data now, tap to send.',
    button: 'Send now',
  };
}

// ---------------------------------------------------------------- spec 8: low storage

export type LowStorage =
  | { level: 'ok' }
  | { level: 'warn'; banner: string }
  | { level: 'block'; banner: string; dialog: { body: string; primary: 'Open Outbox'; secondary: 'OK' } };

/**
 * warn: free < 500 MB, or free minus the queue's bytes < 200 MB; block (camera dialog): free < 200 MB.
 * Never deletes queued files.
 */
export function lowStorage(freeBytes: number, queuedBytes: number, queuedFiles: number): LowStorage {
  const banner = `Phone storage is almost full. Your ${queuedFiles} saved files are safe — connect to send them and free space.`;
  if (freeBytes < LOW_STORAGE_BLOCK_BYTES) {
    return {
      level: 'block',
      banner,
      dialog: { body: 'Not enough space for more photos. Send saved files first, or free space on the phone.', primary: 'Open Outbox', secondary: 'OK' },
    };
  }
  if (freeBytes < LOW_STORAGE_WARN_BYTES || freeBytes - queuedBytes < LOW_STORAGE_BLOCK_BYTES) return { level: 'warn', banner };
  return { level: 'ok' };
}

// ---------------------------------------------------------------- spec 9: sign-out

export type SignOutCheck =
  | { allowed: true }
  | { allowed: false; count: number; title: string; body: string; buttons: ['Open Outbox', 'Stay signed in'] };

export function canSignOut(items: readonly OutboxItem[]): SignOutCheck {
  const t = outboxTotals(items);
  if (t.items === 0) return { allowed: true };
  const n = t.files > 0 ? t.files : t.items;
  return {
    allowed: false,
    count: n,
    title: `${files(n)} ${n === 1 ? 'is' : 'are'} not sent yet`,
    body: 'Signing out would delete them from this phone. Connect to the internet and wait for them to send.',
    buttons: ['Open Outbox', 'Stay signed in'],
  };
}

// ---------------------------------------------------------------- spec 10: drain

export interface DrainProgress {
  sent: number;
  total: number;
  /** Files the server refused (held) — "could not be sent". */
  refused: number;
  done: boolean;
  text: string;
}

/** Progress of the remote-sign-out drain; `done` when nothing sendable is left. */
export function drainProgress(items: readonly OutboxItem[]): DrainProgress {
  let sent = 0;
  let refused = 0;
  let waiting = 0;
  for (const it of items) {
    if (it.state === 'held') refused += it.files.length;
    else if (isPending(it)) waiting += it.files.length;
    else sent += it.files.length;
  }
  const total = sent + refused + waiting;
  return { sent, total, refused, done: waiting === 0, text: `${sent} of ${total} sent` };
}

export const DRAIN_PAGE = {
  title: 'Your access has been removed',
  body: (n: number) => `Sending the ${n} files you took before that. Keep the app open or connected — this finishes by itself.`,
} as const;

export function drainDoneText(sent: number, discarded: number): string {
  if (discarded === 0) return 'All files sent. This phone is now signed out.';
  return `${sent} files were sent. ${discarded} could not be sent and have been removed.`;
}
