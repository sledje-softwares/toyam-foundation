// Thread view model (docs/11 "Thread attachments"; docs/14 gaps 6, 7, 9, 30). Pure: no React Native imports.
//
// One list of rows built from three sources:
//   - server messages (case_messages under RLS) with their files (evidence rows of those messages),
//   - outbox items of this case (saved on the phone, being sent, or just stored),
//   - "delivered" items: outbox rows the engine already pruned whose server copy has not been fetched yet.
// A row is keyed by client_message_id whenever there is one, so an outbox item and the server message it
// becomes are the same React row: no flicker, no gap between "left the outbox" and "fetched".
import type { Msg } from '../cache/caseCache';
import { formatBytes, HELD_TEXT } from '../outbox/selectors';
import { tickRank } from '../outbox/stateMachine';
import { isPending, type OutboxFile, type OutboxItem } from '../outbox/types';

/** v_evidence_processing.state */
export type ProcState = 'none' | 'pending' | 'processing' | 'failed' | 'done';

/** An evidence row of a thread message, as the field app reads it (RLS: own files + visible office files). */
export interface ServerFile {
  id: string;
  message_id: string;
  evidence_type: string;
  mime_type: string | null;
  size_bytes: number | null;
  original_filename: string | null;
  sha256: string | null;
  /** Widths of the shrunk copies the caller can read (evidence_derivatives; [] before the policy exists). */
  copies: number[];
  processing: ProcState;
}

export type FileKind = 'image' | 'video' | 'audio' | 'document';
/**
 * Per-file progress while the message is on the phone; `duplicate` = the case already held this file (the
 * server kept the message without a new copy, rule 6). null = server file (nothing pending).
 */
export type FileState = 'waiting' | 'sending' | 'sent' | 'held' | 'duplicate' | null;

export interface LocalSources {
  /** The original in the outbox sandbox (only while the message is still pending; deleted after ✓). */
  original: string | null;
  w384: string | null;
  w1600: string | null;
}

export interface ThreadFile {
  /** Stable across delivery: the file's SHA-256 (same on the phone and on the server), else the evidence / local id. */
  key: string;
  sha256: string | null;
  evidenceId: string | null;
  kind: FileKind;
  name: string;
  sizeBytes: number | null;
  mime: string | null;
  local: LocalSources | null;
  copies: number[];
  state: FileState;
  /** 0–1 while sending. */
  progress: number | null;
}

export type Tick = 'clock' | 'stored' | 'processed' | 'seen';

export interface ThreadRow {
  key: string;
  messageId: string | null;
  clientMessageId: string | null;
  mine: boolean;
  kind: Msg['kind'];
  text: string | null;
  withdrawn: boolean;
  /** Server time for stored messages, phone time for items still on the phone. */
  at: string;
  images: ThreadFile[];
  others: ThreadFile[];
  fileCount: number;
  /** Own messages only. */
  tick: Tick | null;
  /** Own messages: where the message is, changing in place ("Saved on this phone" → "Sending 2 of 5 files" → "Sent" → "Processed"). */
  label: string | null;
  /** Why an item is stuck on the phone (gap 30); null when all is normal and once stored. */
  status: string | null;
  /** True while the item is on the phone: tapping the row opens the 🕓 sheet. */
  pending: boolean;
  /** Show "Retry" (send now): stuck on the phone with a reason, and online. */
  retry: boolean;
  /** Some of the phone's files were already on the case (shown as "Already sent earlier"). */
  hasDuplicates: boolean;
  /** The server message is in the list (the row no longer depends on the outbox). */
  fromServer: boolean;
}

export const TICK_TEXT: Record<Tick, string> = { clock: '🕓', stored: '✓', processed: '✓✓', seen: '✓✓' };

// ------------------------------------------------------------------ file kinds and labels

export function fileKind(evidenceType: string, mime: string | null): FileKind {
  if (evidenceType === 'photo') return 'image';
  if (evidenceType === 'video') return 'video';
  if (evidenceType === 'audio') return 'audio';
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'document';
}

const KIND_NAME: Record<FileKind, string> = { image: 'Photo', video: 'Video', audio: 'Audio', document: 'Document' };
export const KIND_ICON: Record<FileKind, string> = { image: '🖼', video: '🎬', audio: '🎤', document: '📄' };

/** "inspection.pdf · 1.2 MB" (name falls back to the kind). */
export function chipLabel(f: Pick<ThreadFile, 'name' | 'sizeBytes'>): string {
  return f.sizeBytes !== null && f.sizeBytes > 0 ? `${f.name} · ${formatBytes(f.sizeBytes)}` : f.name;
}

export const filesCountText = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`;

// ------------------------------------------------------------------ grid

export const GRID_MAX_TILES = 6;

export interface GridLayout {
  /** Tiles per row. */
  columns: number;
  /** Indexes of the images shown as tiles. */
  shown: number[];
  /** "+N" on the last tile (images not shown), 0 = none. */
  more: number;
}

/** 1 → one large tile, 2 → 2 across, 3 → 3 across, 4 → 2 × 2, 5–6 → 3 across, more → 6 tiles with "+N" on the 6th. */
export function gridLayout(n: number, max = GRID_MAX_TILES): GridLayout {
  if (n <= 0) return { columns: 0, shown: [], more: 0 };
  const count = Math.min(n, max);
  const columns = count === 1 ? 1 : count === 2 || count === 4 ? 2 : 3;
  const shown = Array.from({ length: count }, (_, i) => i);
  // the last tile is covered by "+N", so it counts as not shown
  const more = n > max ? n - max + 1 : 0;
  return { columns, shown, more };
}

// ------------------------------------------------------------------ outbox files

/** waiting / sending / sent / held for each file of an outbox item; progress while sending. */
export function outboxFileStates(it: Pick<OutboxItem, 'state' | 'files'>): { state: Exclude<FileState, null>; progress: number | null }[] {
  if (it.state === 'held') return it.files.map(() => ({ state: 'held' as const, progress: null }));
  if (!isPending(it as OutboxItem)) return it.files.map(() => ({ state: 'sent' as const, progress: null }));
  let current = it.state === 'uploading';
  return it.files.map((f) => {
    if (f.storage_path) return { state: 'sent' as const, progress: null };
    if (current) {
      current = false; // files go one at a time, in order
      const p = f.size_bytes > 0 ? Math.min(1, f.bytes_sent / f.size_bytes) : 0;
      return { state: 'sending' as const, progress: p };
    }
    return { state: 'waiting' as const, progress: null };
  });
}

function outboxThreadFile(it: OutboxItem, f: OutboxFile, st: { state: Exclude<FileState, null>; progress: number | null }): ThreadFile {
  const kind = fileKind(f.evidence_type, f.mime_type);
  const copy = (w: number) => f.copies?.find((c) => c.width === w)?.local_path ?? null;
  return {
    key: f.sha256 || f.id,
    sha256: f.sha256 || null,
    evidenceId: null,
    kind,
    name: f.original_filename ?? KIND_NAME[kind],
    sizeBytes: f.size_bytes,
    mime: f.mime_type,
    // the original is deleted once the message is stored; the copies stay until they are recorded
    local: { original: isPending(it) ? f.local_path : null, w384: copy(384), w1600: copy(1600) },
    copies: [],
    state: st.state,
    progress: st.progress,
  };
}

function serverThreadFile(f: ServerFile): ThreadFile {
  const kind = fileKind(f.evidence_type, f.mime_type);
  return {
    key: f.sha256 ?? f.id,
    sha256: f.sha256,
    evidenceId: f.id,
    kind,
    name: f.original_filename ?? KIND_NAME[kind],
    sizeBytes: f.size_bytes,
    mime: f.mime_type,
    local: null,
    copies: f.copies,
    state: null,
    progress: null,
  };
}

// ------------------------------------------------------------------ status line (gap 30)

export interface SendContext {
  online: boolean;
  /** The engine paused sending (session trouble). */
  paused: boolean;
  next_retry_at: string | null;
}

export const STATUS = {
  offline: 'Waiting for network',
  noServer: 'No connection to the server — will retry',
  refused: 'Upload refused — will retry',
  session: 'Checking your sign-in — will retry',
  waiting: 'Waiting to send',
  drainText: 'Text messages are not sent after sign-out',
} as const;

export const LABEL = {
  saved: 'Saved on this phone',
  held: 'Waiting for the office',
  sent: 'Sent',
  processed: 'Processed',
  seen: 'Seen by the office',
  duplicate: 'Already sent earlier',
} as const;

function nextTry(nextRetryAt: string | null, now: Date): string {
  if (!nextRetryAt) return '';
  const ms = new Date(nextRetryAt).getTime() - now.getTime();
  if (Number.isNaN(ms) || ms <= 0) return '';
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? ' · next try within a minute' : ` · next try in ${min} min`;
}

/**
 * Why an item is stuck on the phone; never "failed" (docs/11 Offline experience). null while all is normal
 * (saved and about to go, or sending) and once stored.
 */
export function pendingStatus(it: Pick<OutboxItem, 'state' | 'files' | 'last_error' | 'held_reason'>, ctx: SendContext, now: Date): string | null {
  if (!isPending(it as OutboxItem)) return null;
  if (it.state === 'held') return it.held_reason === 'drain_text' ? STATUS.drainText : HELD_TEXT;
  if (it.state === 'uploading') return null;
  if (!ctx.online) return STATUS.offline;
  if (ctx.paused || it.last_error?.startsWith('auth:')) return STATUS.session;
  const err = it.last_error;
  if (err?.startsWith('transient:')) {
    const code = err.slice('transient:'.length);
    const base = code === 'network' || code === 'upload_cancelled' || code === 'client' ? STATUS.noServer : STATUS.refused;
    return base + nextTry(ctx.next_retry_at, now);
  }
  const later = nextTry(ctx.next_retry_at, now);
  return later ? STATUS.waiting + later : null;
}

/** The in-place state text of an own message. */
export function ownLabel(tick: Tick, it: Pick<OutboxItem, 'state' | 'files'> | null): string {
  if (tick === 'seen') return LABEL.seen;
  if (tick === 'processed') return LABEL.processed;
  if (tick === 'stored') return LABEL.sent;
  if (it?.state === 'held') return LABEL.held;
  if (it?.state === 'uploading') {
    const n = it.files.length;
    if (n === 0) return 'Sending…';
    const done = it.files.filter((f) => f.storage_path).length;
    return `Sending ${Math.min(done + 1, n)} of ${filesCountText(n)}`;
  }
  return LABEL.saved;
}

// ------------------------------------------------------------------ ticks

/**
 * Own messages: 🕓 on the phone, ✓ stored, ✓✓ every file processed (v_evidence_processing = done),
 * blue ✓✓ seen by the office (case_thread_state().staff_last_read_at ≥ message time). Ticks only move forward.
 */
export function serverTick(at: string, files: readonly Pick<ServerFile, 'processing'>[], staffLastReadAt: string | null): Tick {
  if (staffLastReadAt && notBefore(staffLastReadAt, at)) return 'seen';
  if (files.length > 0 && files.every((f) => f.processing === 'done')) return 'processed';
  return 'stored';
}

/** a ≥ b as instants (PostgREST trims fractional seconds, so strings are not compared). */
function notBefore(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a >= b : x >= y;
}

const RANK: Record<Tick, number> = { clock: 0, stored: 1, processed: 2, seen: 3 };
const outboxTick = (it: OutboxItem): Tick => {
  const r = tickRank(it.state);
  return r === 3 ? 'seen' : r === 2 ? 'processed' : r === 1 ? 'stored' : 'clock';
};
const maxTick = (a: Tick, b: Tick): Tick => (RANK[a] >= RANK[b] ? a : b);

// ------------------------------------------------------------------ delivered items (gap 6)

/** A delivered item is forgotten after this long even if its server copy never shows (safety valve). */
export const DELIVERED_KEEP_MS = 7 * 24 * 3_600_000;

export interface Delivery {
  /** Outbox items seen in the last snapshot (the engine mutates them in place). */
  seen: ReadonlyMap<string, OutboxItem>;
  /** client_message_ids that were already stored (message_id set) at the last snapshot. */
  stored: ReadonlySet<string>;
  /** Stored items the engine has dropped whose server message is not fetched yet. */
  delivered: ReadonlyMap<string, OutboxItem>;
  /** Confirmed by a thread fetch while still in the outbox: not kept when the outbox prunes them. */
  confirmed: ReadonlySet<string>;
}

export const emptyDelivery = (): Delivery => ({ seen: new Map(), stored: new Set(), delivered: new Map(), confirmed: new Set() });

/** A thread fetch has the server messages of these items with all their files: stop keeping them. */
export function confirmDelivery(d: Delivery, ids: readonly string[]): Delivery {
  const hit = ids.filter((id) => d.delivered.has(id) || (d.seen.has(id) && !d.confirmed.has(id)));
  if (hit.length === 0) return d;
  const delivered = new Map(d.delivered);
  for (const id of hit) delivered.delete(id);
  return { ...d, delivered, confirmed: new Set([...d.confirmed, ...hit.filter((id) => d.seen.has(id))]) };
}

/** Delivered items restored from the phone's cache after a restart (live outbox items win). */
export function restoreDelivery(d: Delivery, saved: readonly OutboxItem[]): Delivery {
  const delivered = new Map(d.delivered);
  for (const it of saved) {
    if (!d.seen.has(it.client_message_id) && !d.confirmed.has(it.client_message_id) && !delivered.has(it.client_message_id)) {
      delivered.set(it.client_message_id, it);
    }
  }
  return { ...d, delivered };
}

/**
 * App-wide (OutboxProvider, persisted in the read cache): keeps a stored item after the outbox prunes it,
 * until a thread fetch confirms the server message with the same client_message_id (`confirmed`), so the
 * bubble never disappears, also across leaving the thread and restarts. Items removed while still pending
 * (Remove from phone) or replaced by the late-upload split are not kept; anything older than 7 days is dropped.
 */
export function trackDelivery(prev: Delivery, current: readonly OutboxItem[], serverClientIds: ReadonlySet<string>, now?: Date): Delivery {
  const seen = new Map(current.map((i) => [i.client_message_id, i] as const));
  const stored = new Set(current.filter((i) => i.message_id !== null).map((i) => i.client_message_id));
  const splitFrom = new Set(current.map((i) => i.split_from).filter((x): x is string => !!x));
  const delivered = new Map<string, OutboxItem>();
  const keep = (it: OutboxItem) => {
    const id = it.client_message_id;
    if (seen.has(id) || serverClientIds.has(id) || prev.confirmed.has(id) || splitFrom.has(id)) return;
    if (it.message_id === null && tickRank(it.state) === 0) return;
    const at = Date.parse(it.stored_at ?? it.created_at);
    if (now && !Number.isNaN(at) && now.getTime() - at > DELIVERED_KEEP_MS) return;
    delivered.set(id, it);
  };
  for (const it of prev.delivered.values()) keep(it);
  for (const it of prev.seen.values()) keep(it);
  // a confirmation only matters until the outbox prunes the item
  const confirmed = new Set([...prev.confirmed].filter((id) => seen.has(id)));
  return { seen, stored, delivered, confirmed };
}

/** True when an item of this case got stored since the last snapshot: fetch the thread now. */
export function newlyStored(prev: Pick<Delivery, 'stored'>, current: readonly OutboxItem[]): boolean {
  return current.some((i) => i.message_id !== null && !prev.stored.has(i.client_message_id));
}

/** Outbox items to merge: the live ones plus the delivered ones (optionally of one case). */
export const deliveryItems = (d: Delivery, caseId?: string): OutboxItem[] =>
  [...d.seen.values(), ...d.delivered.values()].filter((i) => caseId === undefined || i.case_id === caseId);

/** Rows whose server message is in the list with every file: their delivered entry can go. */
export function confirmedIds(rows: readonly Pick<ThreadRow, 'clientMessageId' | 'messageId' | 'pending' | 'hasDuplicates' | 'fromServer'>[]): string[] {
  return rows.filter((r) => r.fromServer && r.clientMessageId && !r.hasDuplicates).map((r) => r.clientMessageId as string);
}

/**
 * Rows already on screen keep their order (no jumps when an item is handed over from the outbox to the
 * server list); rows new to the screen go where the natural order puts them (after the nearest earlier row).
 * Returns the keys in display order.
 */
export function stableOrder(prevKeys: readonly string[], rows: readonly Pick<ThreadRow, 'key'>[]): string[] {
  const present = new Set(rows.map((r) => r.key));
  const out = prevKeys.filter((k) => present.has(k));
  const placed = new Set(out);
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i]!.key;
    if (placed.has(k)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const pos = out.indexOf(rows[j]!.key);
      if (pos >= 0) { at = pos + 1; break; }
    }
    out.splice(at, 0, k);
    placed.add(k);
  }
  return out;
}

// ------------------------------------------------------------------ merge

export interface MergeInput {
  server: readonly Msg[];
  files: readonly ServerFile[];
  /** Outbox items of this case plus delivered ones (trackDelivery). */
  outbox: readonly OutboxItem[];
  me: string | null;
  staffLastReadAt: string | null;
  send: SendContext;
  now: Date;
}

function split(files: ThreadFile[]): { images: ThreadFile[]; others: ThreadFile[] } {
  return { images: files.filter((f) => f.kind === 'image'), others: files.filter((f) => f.kind !== 'image') };
}

/** Rows oldest first. Items still on the phone (or not fetched yet) come after every server message. */
export function mergeThread(input: MergeInput): ThreadRow[] {
  const byMessage = new Map<string, ServerFile[]>();
  for (const f of input.files) {
    const l = byMessage.get(f.message_id);
    if (l) l.push(f);
    else byMessage.set(f.message_id, [f]);
  }
  const local = new Map(input.outbox.map((i) => [i.client_message_id, i] as const));
  const matched = new Set<string>();
  const rows: ThreadRow[] = [];

  const bySha = new Map<string, ServerFile>();
  for (const f of input.files) if (f.sha256 && !bySha.has(f.sha256)) bySha.set(f.sha256, f);

  const server = [...input.server].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const m of server) {
    const cid = m.client_message_id ?? null;
    const it = cid ? local.get(cid) : undefined;
    if (cid && it) matched.add(cid);
    const mine = input.me !== null && m.sender_id === input.me;
    const withdrawn = m.withdrawn_at !== null;
    const sf = withdrawn ? [] : byMessage.get(m.id) ?? [];
    let files: ThreadFile[];
    let dup = false;
    if (it && !withdrawn) {
      // the phone knows the message: keep its file order (same tiles, same keys) and its local copies
      const own = new Map(sf.map((f) => [f.sha256, f] as const));
      files = it.files.map((o) => {
        const phone = outboxThreadFile(it, o, { state: 'sent', progress: null });
        const here = own.get(o.sha256);
        if (here) return { ...serverThreadFile(here), local: phone.local };
        const earlier = bySha.get(o.sha256);
        if (earlier) {
          // post_thread_message skipped a file the case already holds (rule 6): show it, marked
          dup = true;
          return { ...serverThreadFile(earlier), local: phone.local, state: 'duplicate' as const };
        }
        return phone; // server files not fetched yet (old cache)
      });
      const known = new Set(it.files.map((o) => o.sha256));
      for (const f of sf) if (!f.sha256 || !known.has(f.sha256)) files.push(serverThreadFile(f));
    } else {
      files = sf.map(serverThreadFile);
    }
    let tick: Tick | null = null;
    if (mine && !withdrawn && m.kind !== 'system') {
      tick = serverTick(m.created_at, sf, input.staffLastReadAt);
      if (it) tick = maxTick(tick, outboxTick(it));
    }
    rows.push({
      key: cid ?? m.id,
      messageId: m.id,
      clientMessageId: cid,
      mine,
      kind: m.kind,
      text: withdrawn ? null : m.body,
      withdrawn,
      at: m.created_at,
      ...split(files),
      fileCount: files.length,
      tick,
      label: tick ? ownLabel(tick, it ?? null) : null,
      status: null,
      pending: false,
      retry: false,
      hasDuplicates: dup,
      fromServer: true,
    });
  }

  const rest = input.outbox
    .filter((i) => !matched.has(i.client_message_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const it of rest) {
    const states = outboxFileStates(it);
    const files = it.files.map((f, i) => outboxThreadFile(it, f, states[i] ?? { state: 'waiting', progress: null }));
    const tick = outboxTick(it);
    const status = pendingStatus(it, input.send, input.now);
    rows.push({
      key: it.client_message_id,
      messageId: it.message_id,
      clientMessageId: it.client_message_id,
      mine: true,
      kind: it.kind,
      text: it.caption,
      withdrawn: false,
      at: it.created_at,
      ...split(files),
      fileCount: files.length,
      tick,
      label: ownLabel(tick, it),
      status,
      pending: isPending(it),
      retry: isPending(it) && status !== null && input.send.online && it.held_reason !== 'drain_text',
      hasDuplicates: false,
      fromServer: false,
    });
  }
  return rows;
}

/** Text for a row without files or caption. */
export function rowFallbackText(r: Pick<ThreadRow, 'kind' | 'withdrawn' | 'fileCount'>): string {
  if (r.withdrawn) return 'Message withdrawn';
  if (r.fileCount > 0) return '';
  // a media message always had files; none stored = every one was already on the case
  return r.kind === 'voice' ? 'Voice note' : r.kind === 'media' ? 'Files already sent earlier' : '';
}

/** "3 files · Sent ✓" meta line pieces for a row. */
export function rowMeta(r: Pick<ThreadRow, 'fileCount' | 'tick'> & { label?: string | null }): { count: string | null; label: string | null; tick: string | null; blue: boolean } {
  return {
    count: r.fileCount > 1 ? filesCountText(r.fileCount) : null,
    label: r.label ?? null,
    tick: r.tick ? TICK_TEXT[r.tick] : null,
    blue: r.tick === 'seen',
  };
}

// ------------------------------------------------------------------ unread (gap 9)

export interface ListRowLike { case_id: string; last_message_at: string | null; unread_count: number }

/**
 * The server badge (field_case_list) never counts the operator's own messages; the app marks the thread read
 * (mark_thread_read) whenever it shows it online. Offline, the time of the newest message shown in the
 * thread is kept on the phone: a cached list row whose last message is not newer shows no badge.
 */
export function applyLocalReads<T extends ListRowLike>(rows: readonly T[], reads: Readonly<Record<string, string>>): T[] {
  return rows.map((r) => {
    const read = reads[r.case_id];
    if (!read || r.unread_count === 0) return r;
    if (r.last_message_at === null || notBefore(read, r.last_message_at)) return { ...r, unread_count: 0 };
    return r;
  });
}

/** Newest message time the operator has seen in a thread (server rows only), or null. */
export function readMark(msgs: readonly Pick<Msg, 'created_at'>[]): string | null {
  let max: string | null = null;
  for (const m of msgs) if (max === null || !notBefore(max, m.created_at)) max = m.created_at;
  return max;
}

/** The images of a row for the viewer, in order (index = tile index). */
export const viewerImages = (r: Pick<ThreadRow, 'images'>): ThreadFile[] => r.images;
