// The outbox engine: queue → upload files → post the message, with the same client_message_id on
// every retry (rule 6). Pure TypeScript with injected store / server / transport / clock.
import { backoffDelay } from './backoff';
import { emptyBatch, allSentEvent, outboxTotals, type SendBatch } from './selectors';
import { type PostMessage, type Server, ServerError, type Transport } from './server';
import { assertTransition, tickRank } from './stateMachine';
import type { Store } from './store';
import { type HeldReason, isPending, type NewItem, type OutboxFile, type OutboxItem } from './types';

export type OutboxMode = 'normal' | 'drain';

export type OutboxEvent =
  /** Queue drained after a file waited > 1 min (spec 6). Fired once per drain. */
  | { type: 'all_sent'; count: number; case_id: string | null }
  /** Session refused: the app should call field-drain `status`. Sending is paused. */
  | { type: 'auth_blocked' }
  /** Drain window over / finished / device unknown: the app calls `finish` and wipes. */
  | { type: 'drain_closed' }
  /** Drain said the operator is active again: back to normal sign-in. */
  | { type: 'reactivated' };

export interface OutboxSnapshot {
  items: readonly OutboxItem[];
  online: boolean;
  mode: OutboxMode;
  paused: boolean;
  /** Files sent in the current drain run and its total, while sending. */
  sending: { k: number; n: number } | null;
  last_success_at: string | null;
  last_prompt_at: string | null;
  /** Earliest time the engine will retry by itself (null = not waiting on backoff). */
  next_retry_at: string | null;
}

export interface OutboxDeps {
  store: Store;
  server: Server;
  transport: Transport;
  /** Device id registered with register_field_device(); null = do not report. */
  deviceId: string | null;
  now?: () => Date;
  random?: () => number;
  uuid: () => string;
  /** Delete a sandbox file once its message is stored. */
  removeFile?: (localPath: string) => Promise<void>;
  /** Wake-up timer for backoff; returns a cancel function. */
  schedule?: (ms: number, fn: () => void) => () => void;
  log?: (msg: string) => void;
}

const REPORT_EVERY_MS = 60_000;
const META_SUCCESS = 'last_success_at';
const META_PROMPT = 'last_prompt_at';

export class Outbox {
  private d: Required<Omit<OutboxDeps, 'deviceId'>> & { deviceId: string | null };
  private items = new Map<string, OutboxItem>();
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: OutboxEvent) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private online = false;
  private mode: OutboxMode = 'normal';
  private paused = false;
  private failures = 0;
  private nextRetryAt: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private batch: SendBatch = emptyBatch();
  private lastSuccessAt: string | null = null;
  private lastPromptAt: string | null = null;
  private lastReportAt = -Infinity;
  private reportDirty = true;
  private snap: OutboxSnapshot | null = null;

  constructor(deps: OutboxDeps) {
    this.d = {
      now: () => new Date(),
      random: Math.random,
      removeFile: async () => {},
      schedule: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      log: () => {},
      ...deps,
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Load the persisted queue. Items cut off mid-upload (app killed) go back to queued. */
  async init(): Promise<void> {
    const rows = await this.d.store.load();
    this.items.clear();
    for (const it of rows) {
      if (it.state === 'uploading') {
        it.state = 'queued';
        for (const f of it.files) f.bytes_sent = 0;
        await this.d.store.put(it);
      }
      this.items.set(it.client_message_id, it);
    }
    this.lastSuccessAt = await this.d.store.getMeta(META_SUCCESS);
    this.lastPromptAt = await this.d.store.getMeta(META_PROMPT);
    this.batch = { ...emptyBatch(), oldest_queued_at: this.oldestQueued() };
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: OutboxEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Stable between changes (for useSyncExternalStore). */
  snapshot(): OutboxSnapshot {
    if (!this.snap) {
      const items = [...this.items.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      this.snap = {
        items,
        online: this.online,
        mode: this.mode,
        paused: this.paused,
        sending: this.running && this.batchSize() > 0 ? { k: this.batch.sent, n: this.batchSize() } : null,
        last_success_at: this.lastSuccessAt,
        last_prompt_at: this.lastPromptAt,
        next_retry_at: this.nextRetryAt === null ? null : new Date(this.nextRetryAt).toISOString(),
      };
    }
    return this.snap;
  }

  // ------------------------------------------------------------------ commands

  /** Save a message on the phone (🕓). Files must already be in the sandbox. */
  async enqueue(input: NewItem): Promise<OutboxItem> {
    const item: OutboxItem = {
      client_message_id: this.d.uuid(),
      case_id: input.case_id,
      task_id: input.task_id,
      kind: input.kind ?? (input.files.length > 0 ? 'media' : 'text'),
      caption: input.caption?.trim() || null,
      category_code: input.category_code ?? null,
      reply_to: input.reply_to ?? null,
      files: input.files.map((f) => ({ ...f, id: this.d.uuid(), storage_path: null, bytes_sent: 0 })),
      state: 'queued',
      created_at: this.d.now().toISOString(),
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      held_reason: null,
      message_id: null,
      stored_at: null,
      split_from: null,
    };
    await this.save(item);
    if (this.batch.oldest_queued_at === null) this.batch.oldest_queued_at = item.created_at;
    this.reportDirty = true;
    this.changed();
    void this.run();
    return item;
  }

  /** NetInfo change. Coming online resets the backoff and sends at once; going offline stops quietly. */
  setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    this.resetBackoff();
    this.changed();
    if (online) void this.run();
  }

  /** "Send now": reset the backoff, give held items of the case (or all) another try, run. */
  async sendNow(caseId?: string): Promise<void> {
    for (const it of this.items.values()) {
      if (it.state === 'held' && (!caseId || it.case_id === caseId)) await this.requeue(it);
    }
    this.resetBackoff();
    this.changed();
    await this.run();
  }

  /**
   * The office raised a new task on the case (spec 3): held files move to it. Their uploaded copies
   * were keyed to the old task, so they are uploaded again under the new task's path.
   */
  async retryHeld(caseId: string, newTaskId: string): Promise<void> {
    for (const it of this.items.values()) {
      if (it.state !== 'held' || it.case_id !== caseId || it.held_reason === 'drain_text') continue;
      it.task_id = newTaskId;
      for (const f of it.files) {
        f.storage_path = null;
        f.bytes_sent = 0;
      }
      await this.requeue(it);
    }
    this.resetBackoff();
    this.changed();
    await this.run();
  }

  /** Ticks from the server (✓✓ / blue ✓✓) for items still in the outbox. Never downgrades. */
  async markTicks(updates: { client_message_id: string; state: 'processed' | 'seen' }[]): Promise<void> {
    for (const u of updates) {
      const it = this.items.get(u.client_message_id);
      if (!it || tickRank(it.state) === 0 || tickRank(u.state) <= tickRank(it.state)) continue;
      it.state = u.state;
      await this.save(it);
    }
    this.changed();
  }

  /** "Remove from phone" after the confirmation dialog. Only unsent files. Returns true if removed. */
  async removeFile(clientMessageId: string, fileId: string): Promise<boolean> {
    const it = this.items.get(clientMessageId);
    if (!it || (it.state !== 'queued' && it.state !== 'held')) return false;
    const f = it.files.find((x) => x.id === fileId);
    if (!f) return false;
    it.files = it.files.filter((x) => x.id !== fileId);
    await this.d.removeFile(f.local_path);
    if (it.files.length === 0 && it.kind !== 'text') {
      this.items.delete(clientMessageId);
      await this.d.store.remove(clientMessageId);
    } else {
      await this.save(it);
    }
    this.reportDirty = true;
    this.changed();
    void this.maybeReport(false);
    return true;
  }

  /** Switch to the field-drain server after remote sign-out (or back). Resumes sending. */
  useServer(server: Server, mode: OutboxMode): void {
    this.d.server = server;
    this.mode = mode;
    this.paused = false;
    this.resetBackoff();
    this.changed();
    void this.run();
  }

  setDeviceId(deviceId: string | null): void {
    this.d.deviceId = deviceId;
    this.reportDirty = true;
  }

  /** Record that the 6-hour prompt was shown (spec 7). */
  async markPrompted(): Promise<void> {
    this.lastPromptAt = this.d.now().toISOString();
    await this.d.store.setMeta(META_PROMPT, this.lastPromptAt);
    this.changed();
  }

  /** Sign-out / drain finished: delete queue, files and meta. Returns how many files were discarded. */
  async wipe(): Promise<number> {
    let discarded = 0;
    for (const it of this.items.values()) {
      for (const f of it.files) {
        if (isPending(it)) discarded++;
        await this.d.removeFile(f.local_path);
      }
    }
    this.items.clear();
    await this.d.store.clear();
    this.batch = emptyBatch();
    this.lastSuccessAt = null;
    this.lastPromptAt = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.changed();
    return discarded;
  }

  /** One sending pass; concurrent callers share it. Resolves when it stops (empty, offline, backoff). */
  run(): Promise<void> {
    if (this.running) {
      this.again = true; // a request during the tail of a pass is not lost
    } else {
      this.running = (async () => {
        do {
          this.again = false;
          await this.loop();
        } while (this.again);
      })().finally(() => {
        this.running = null;
        this.changed();
      });
      this.changed();
    }
    return this.running;
  }

  // ------------------------------------------------------------------ engine

  private async loop(): Promise<void> {
    for (;;) {
      if (!this.online || this.paused) break;
      if (this.nextRetryAt !== null && this.d.now().getTime() < this.nextRetryAt) break;
      const next = this.nextQueued();
      if (!next) break;
      const stop = await this.sendItem(next);
      if (stop) break;
    }
    await this.maybeReport(true);
    this.checkAllSent();
    this.scheduleWake();
  }

  /** Returns true when the loop should stop (transient error, auth, drain closed). */
  private async sendItem(it: OutboxItem): Promise<boolean> {
    const now = this.d.now().toISOString();
    if (this.mode === 'drain' && it.kind === 'text') {
      await this.hold(it, 'drain_text', 'text messages are not drained');
      return false;
    }
    assertTransition(it.state, 'uploading');
    it.state = 'uploading';
    it.attempts += 1;
    it.last_attempt_at = now;
    await this.save(it);
    this.changed();
    try {
      for (const f of it.files) {
        if (f.storage_path) continue; // already in R2: never uploaded twice
        await this.uploadFile(it, f);
      }
      const messageId = await this.d.server.postMessage(toPostMessage(it));
      assertTransition(it.state, 'stored');
      it.state = 'stored';
      it.message_id = messageId;
      it.stored_at = this.d.now().toISOString();
      it.last_error = null;
      await this.save(it);
      for (const f of it.files) await this.d.removeFile(f.local_path).catch(() => {});
      this.failures = 0;
      this.nextRetryAt = null;
      this.lastSuccessAt = it.stored_at;
      await this.d.store.setMeta(META_SUCCESS, this.lastSuccessAt);
      this.batch.sent += it.files.length;
      this.batch.last_case_id = it.case_id;
      this.reportDirty = true;
      this.changed();
      await this.maybeReport(true);
      return false;
    } catch (e) {
      return this.onError(it, e);
    }
  }

  private async uploadFile(it: OutboxItem, f: OutboxFile): Promise<void> {
    if (!it.task_id) throw new ServerError('window_closed', 'no_task', 'no task to upload under');
    const p = await this.d.server.presign({
      case_id: it.case_id,
      task_id: it.task_id,
      sha256: f.sha256,
      ext: f.ext,
      device_captured_at: f.device_captured_at,
    });
    await this.d.transport.put(p.url, p.headers, f.local_path, (n) => {
      f.bytes_sent = n;
      this.changed();
    });
    f.storage_path = p.storage_path;
    f.bytes_sent = f.size_bytes;
    await this.save(it);
  }

  private async onError(it: OutboxItem, e: unknown): Promise<boolean> {
    const err = e instanceof ServerError ? e : new ServerError('transient', 'client', e instanceof Error ? e.message : String(e));
    this.d.log(`outbox ${it.client_message_id}: ${err.kind} ${err.code} ${err.message}`);
    it.last_error = `${err.kind}:${err.code}`;
    for (const f of it.files) if (!f.storage_path) f.bytes_sent = 0;
    switch (err.kind) {
      case 'window_closed':
        if (it.files.length > 1) await this.split(it);
        else await this.hold(it, 'upload_window_closed', err.code);
        return false;
      case 'rejected':
        await this.hold(it, 'rejected', err.code);
        return false;
      case 'auth':
      case 'drain_closed':
      case 'reactivated':
        await this.backToQueue(it);
        this.paused = true;
        this.changed();
        this.emit({ type: err.kind === 'auth' ? 'auth_blocked' : err.kind });
        return true;
      case 'transient':
        await this.backToQueue(it);
        this.failures += 1;
        this.nextRetryAt = this.d.now().getTime() + backoffDelay(this.failures, this.d.random);
        this.changed();
        return true;
    }
  }

  /** D43: one message per file, new client_message_id each, so eligible files still go. */
  private async split(it: OutboxItem): Promise<void> {
    const children: OutboxItem[] = it.files.map((f, i) => ({
      ...it,
      client_message_id: this.d.uuid(),
      caption: i === 0 ? it.caption : null,
      files: [f],
      state: 'queued',
      attempts: 0,
      last_error: null,
      split_from: it.client_message_id,
    }));
    await this.d.store.replace(it.client_message_id, children);
    this.items.delete(it.client_message_id);
    for (const c of children) this.items.set(c.client_message_id, c);
    this.changed();
  }

  private async hold(it: OutboxItem, reason: HeldReason, code: string): Promise<void> {
    if (it.state !== 'held') {
      assertTransition(it.state, 'held');
      it.state = 'held';
    }
    it.held_reason = reason;
    it.last_error = it.last_error ?? code;
    await this.save(it);
    this.reportDirty = true;
    this.changed();
  }

  private async backToQueue(it: OutboxItem): Promise<void> {
    assertTransition(it.state, 'queued');
    it.state = 'queued';
    await this.save(it);
  }

  private async requeue(it: OutboxItem): Promise<void> {
    assertTransition(it.state, 'queued');
    it.state = 'queued';
    it.held_reason = null;
    await this.save(it);
  }

  private resetBackoff(): void {
    this.failures = 0;
    this.nextRetryAt = null;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private scheduleWake(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!this.online || this.paused || this.nextRetryAt === null || !this.nextQueued()) return;
    const ms = Math.max(0, this.nextRetryAt - this.d.now().getTime());
    this.cancelTimer = this.d.schedule(ms, () => {
      this.cancelTimer = null;
      void this.run();
    });
  }

  private checkAllSent(): void {
    const totals = outboxTotals([...this.items.values()]);
    const ev = allSentEvent(this.batch, totals.files, this.d.now());
    if (totals.items === 0 && this.mode === 'normal') {
      // drained: drop the sent rows (the thread shows server ticks from now on) and reset the batch
      for (const it of [...this.items.values()]) {
        if (!isPending(it)) {
          this.items.delete(it.client_message_id);
          void this.d.store.remove(it.client_message_id);
        }
      }
      this.batch = emptyBatch();
      this.changed();
    }
    if (ev) this.emit({ type: 'all_sent', count: ev.count, case_id: ev.case_id });
  }

  private async maybeReport(afterSend: boolean): Promise<void> {
    const deviceId = this.d.deviceId;
    if (!deviceId || !this.online || this.paused || !this.reportDirty) return;
    const now = this.d.now().getTime();
    if (!afterSend && now - this.lastReportAt < REPORT_EVERY_MS) return;
    const t = outboxTotals([...this.items.values()]);
    this.lastReportAt = now;
    this.reportDirty = false;
    try {
      await this.d.server.reportOutbox({
        device_id: deviceId,
        pending_count: t.files,
        pending_bytes: t.bytes,
        oldest_pending_at: t.oldest_captured_at,
      });
    } catch (e) {
      this.reportDirty = true;
      this.d.log(`outbox report: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private nextQueued(): OutboxItem | undefined {
    let best: OutboxItem | undefined;
    for (const it of this.items.values()) {
      if (it.state === 'queued' && (!best || it.created_at < best.created_at)) best = it;
    }
    return best;
  }

  private oldestQueued(): string | null {
    let o: string | null = null;
    for (const it of this.items.values()) if (isPending(it) && (o === null || it.created_at < o)) o = it.created_at;
    return o;
  }

  private batchSize(): number {
    return this.batch.sent + outboxTotals([...this.items.values()].filter((i) => i.state !== 'held')).files;
  }

  private async save(it: OutboxItem): Promise<void> {
    this.items.set(it.client_message_id, it);
    await this.d.store.put(it);
  }

  private changed(): void {
    this.snap = null;
    for (const l of this.listeners) l();
  }

  private emit(e: OutboxEvent): void {
    for (const l of this.eventListeners) l(e);
  }
}

export function toPostMessage(it: OutboxItem): PostMessage {
  return {
    case_id: it.case_id,
    client_message_id: it.client_message_id,
    kind: it.kind,
    body: it.caption,
    task_id: it.task_id,
    reply_to: it.reply_to,
    items: it.files.map((f) => ({
      evidence_type: f.evidence_type,
      capture_source: f.capture_source,
      storage_path: f.storage_path ?? '',
      mime_type: f.mime_type,
      size_bytes: f.size_bytes,
      sha256: f.sha256,
      original_filename: f.original_filename,
      device_captured_at: f.device_captured_at,
      latitude: f.gps?.latitude ?? null,
      longitude: f.gps?.longitude ?? null,
      gps_accuracy_m: f.gps?.accuracy_m ?? null,
      checklist_item_id: f.checklist_item_id,
      category_code: it.category_code,
      ...(f.device_info ? { device_info: f.device_info } : {}),
      ...(f.exif ? { exif: f.exif } : {}),
      ...(f.ocr ? { ocr: f.ocr } : {}),
    })),
  };
}
