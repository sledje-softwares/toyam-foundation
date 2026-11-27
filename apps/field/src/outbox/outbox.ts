// The outbox engine: queue → upload files → post the message, with the same client_message_id on
// every retry (rule 6). Pure TypeScript with injected store / server / transport / clock.
import { backoffDelay } from './backoff';
import { emptyBatch, allSentEvent, outboxTotals, type SendBatch } from './selectors';
import { type PostMessage, type Server, ServerError, type Transport } from './server';
import { assertTransition, tickRank } from './stateMachine';
import type { Store } from './store';
import { type HeldReason, isPending, MAX_COPY_ATTEMPTS, type NewItem, type OutboxCopy, type OutboxFile, type OutboxItem, type OutboxOcr } from './types';

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
  /**
   * D51: make the shrunk copies of an image in the sandbox (never throws; [] for non-images or when
   * it cannot). Left out = no copies are made or sent (the report uses the original).
   */
  makeCopies?: (file: OutboxFile) => Promise<OutboxCopy[]>;
  /**
   * Gap 35: read the text of a photo's 1600 px copy on the phone (ML Kit) and describe it (never
   * throws; null = nothing to send). Runs after the copies are made, off the send path; left out =
   * no device OCR.
   */
  readOcr?: (file: OutboxFile, item: OutboxItem) => Promise<OutboxOcr | null>;
  /** Wake-up timer for backoff; returns a cancel function. */
  schedule?: (ms: number, fn: () => void) => () => void;
  log?: (msg: string) => void;
}

const REPORT_EVERY_MS = 60_000;
const META_SUCCESS = 'last_success_at';
const META_PROMPT = 'last_prompt_at';

export class Outbox {
  private d: Required<Omit<OutboxDeps, 'deviceId' | 'makeCopies' | 'readOcr'>> & {
    deviceId: string | null;
    makeCopies?: OutboxDeps['makeCopies'];
    readOcr?: OutboxDeps['readOcr'];
  };
  private items = new Map<string, OutboxItem>();
  /** Copy-making per message (one at a time, in enqueue order); sending the message waits for its job. */
  private copyJobs = new Map<string, Promise<void>>();
  private copyChain: Promise<void> = Promise.resolve();
  /** Device OCR per file id (one at a time); its copies wait for it (OCR reads the 1600 px copy). */
  private ocrJobs = new Map<string, Promise<void>>();
  private ocrChain: Promise<void> = Promise.resolve();
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
    // the app was closed before the copies of these photos were made: make them now (originals still exist)
    for (const it of this.items.values()) if (it.state === 'queued' || it.state === 'held') this.startCopies(it);
    // and the photos whose 1600 px copy is still on the phone but was not read yet
    for (const it of this.items.values()) for (const f of it.files) this.startOcr(f);
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
        // copies (D51) are invisible: the bar shows only while a message is waiting or being sent
        sending: this.running && this.batchSize() > 0 && [...this.items.values()].some((i) => i.state === 'queued' || i.state === 'uploading') ?{ k: this.batch.sent, n: this.batchSize() } : null,
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
    this.startCopies(item);
    if (this.batch.oldest_queued_at === null) this.batch.oldest_queued_at = item.created_at;
    this.reportDirty = true;
    this.changed();
    void this.run();
    return item;
  }

  /**
   * D51: make the shrunk copies of the item's photos in the background (the operator is not kept
   * waiting). Sending the message waits for this job so the original is still in the sandbox.
   */
  private startCopies(item: OutboxItem): void {
    const make = this.d.makeCopies;
    const id = item.client_message_id;
    const photos = item.files.filter((f) => f.evidence_type === 'photo' && f.copies === undefined);
    if (!make || this.mode === 'drain' || photos.length === 0 || this.copyJobs.has(id)) return;
    const job: Promise<void> = this.copyChain
      .then(async () => {
        for (const f of photos) {
          let copies: OutboxCopy[] = [];
          try {
            copies = await make(f);
          } catch {
            copies = [];
          }
          const live = this.items.get(id);
          if (!live || !live.files.includes(f)) {
            await this.dropCopyFiles(copies); // sent-and-wiped or removed meanwhile
            continue;
          }
          f.copies = copies; // [] = done, nothing to send
          await this.save(live);
          this.startOcr(f);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.copyJobs.get(id) === job) this.copyJobs.delete(id);
      });
    this.copyChain = job;
    this.copyJobs.set(id, job);
  }

  /**
   * Gap 35: read the photo's 1600 px copy in the background once it exists. The message is not kept
   * waiting; the copies wait (the 1600 px file must stay until it is read). Best effort.
   */
  private startOcr(f: OutboxFile): void {
    const read = this.d.readOcr;
    if (!read || this.mode === 'drain' || f.ocr !== undefined || this.ocrJobs.has(f.id)) return;
    if (f.evidence_type !== 'photo' || !f.copies?.some((c) => c.width === 1600)) return;
    const job: Promise<void> = this.ocrChain
      .then(async () => {
        const at = this.findFile(f.id);
        if (!at || at.f.ocr !== undefined) return; // sent-and-wiped, removed, or read meanwhile
        let result: OutboxOcr | null = null;
        try {
          result = await read(at.f, at.it);
        } catch {
          result = null;
        }
        const live = this.findFile(f.id); // the message may have been split meanwhile
        if (!live) return;
        live.f.ocr = result;
        await this.save(live.it);
      })
      .catch(() => {})
      .finally(() => {
        if (this.ocrJobs.get(f.id) === job) this.ocrJobs.delete(f.id);
        this.changed();
        void this.run(); // its copies and the text can go now
      });
    this.ocrChain = job;
    this.ocrJobs.set(f.id, job);
  }

  private findFile(fileId: string): { it: OutboxItem; f: OutboxFile } | undefined {
    for (const it of this.items.values()) {
      const f = it.files.find((x) => x.id === fileId);
      if (f) return { it, f };
    }
    return undefined;
  }

  /** Copies or device OCR of a sent photo still to go (invisible to the operator). */
  private hasSideWork(f: OutboxFile): boolean {
    return (f.copies?.length ?? 0) > 0 || !!f.ocr || this.ocrJobs.has(f.id);
  }

  private async dropCopyFiles(copies: readonly OutboxCopy[] | undefined): Promise<void> {
    for (const c of copies ?? []) await this.d.removeFile(c.local_path).catch(() => {});
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
    await this.dropCopyFiles(f.copies);
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
        await this.dropCopyFiles(f.copies);
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

  /** Resolves once no copy job, device OCR job or sending pass is left (tests, background task). */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const jobs = [...this.copyJobs.values(), ...this.ocrJobs.values(), ...(this.running ? [this.running] : [])];
      if (jobs.length === 0) return;
      await Promise.all(jobs);
    }
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
    await this.sendCopiesPass();
    await this.maybeReport(true);
    this.checkAllSent();
    this.scheduleWake();
  }

  /** Returns true when the loop should stop (transient error, auth, drain closed). */
  private async sendItem(it: OutboxItem): Promise<boolean> {
    await this.copyJobs.get(it.client_message_id); // the copies are made from the original; keep it until then
    if (it.state !== 'queued') return false; // removed or changed while waiting
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

  // ------------------------------------------------------------------ shrunk copies (D51)

  /**
   * A stored message's photo that still has copies (or then its device OCR) to send; none in drain
   * mode. A photo whose 1600 px copy is still being read waits.
   */
  private nextCopyWork(): { it: OutboxItem; f: OutboxFile } | undefined {
    if (this.mode === 'drain') return undefined;
    const server = this.d.server;
    const copiesOk = !!server.presignDerivatives && !!server.recordDerivative;
    let best: { it: OutboxItem; f: OutboxFile } | undefined;
    for (const it of this.items.values()) {
      if (it.state !== 'stored' && it.state !== 'processed' && it.state !== 'seen') continue;
      for (const f of it.files) {
        if (this.ocrJobs.has(f.id)) continue;
        const work = (copiesOk && (f.copies?.length ?? 0) > 0) || (!!server.recordOcr && !!f.ocr);
        if (work && (!best || it.created_at < best.it.created_at)) best = { it, f };
      }
    }
    return best;
  }

  /** Originals first: copies go only while no message waits, under the same backoff as everything else. */
  private async sendCopiesPass(): Promise<void> {
    for (;;) {
      if (!this.online || this.paused) return;
      if (this.nextRetryAt !== null && this.d.now().getTime() < this.nextRetryAt) return;
      if (this.nextQueued()) return;
      const work = this.nextCopyWork();
      if (!work) return;
      const stop = (work.f.copies?.length ?? 0) > 0 ? await this.sendCopies(work.it, work.f) : await this.sendOcr(work.it, work.f);
      if (stop) return;
    }
  }

  /** Presign both copies of one photo, PUT, record. Returns true when the pass should stop. */
  private async sendCopies(it: OutboxItem, f: OutboxFile): Promise<boolean> {
    const server = this.d.server;
    const copies = f.copies ?? [];
    if (!it.task_id || !server.presignDerivatives || !server.recordDerivative) {
      await this.dropCopies(it, f, copies);
      return false;
    }
    try {
      const presigns = await server.presignDerivatives({
        case_id: it.case_id,
        task_id: it.task_id,
        original_sha256: f.sha256,
        copies: copies.map((c) => ({ width: c.width, sha256: c.sha256, size_bytes: c.size_bytes })),
      });
      for (const c of [...copies]) {
        const p = presigns.find((x) => x.width === c.width);
        if (!p || p.status === 'skipped' || p.status === 'already_stored') {
          await this.dropCopies(it, f, [c]); // not usable here, or already recorded: nothing to send
          continue;
        }
        if (!c.storage_path) {
          if (!p.url || !p.storage_path) throw new ServerError('rejected', 'bad_reply');
          await this.d.transport.put(p.url, p.headers ?? {}, c.local_path, () => {});
          c.storage_path = p.storage_path;
          await this.save(it);
        }
        await server.recordDerivative({
          case_id: it.case_id,
          original_sha256: f.sha256,
          width: c.width,
          storage_path: c.storage_path,
          sha256: c.sha256,
          size_bytes: c.size_bytes,
          pixel_width: c.pixel_width,
          pixel_height: c.pixel_height,
        });
        await this.dropCopies(it, f, [c]); // recorded (recorded:false = already there, equally done)
      }
      this.failures = 0;
      this.nextRetryAt = null;
      return false;
    } catch (e) {
      return this.onCopyError(it, f, e);
    }
  }

  /** Copies never block or hold a message: permanent trouble drops them, transient trouble backs off. */
  private async onCopyError(it: OutboxItem, f: OutboxFile, e: unknown): Promise<boolean> {
    return this.onSideError('copies', it, e, () => this.dropCopies(it, f, f.copies ?? []), async () => {
      const worn = (f.copies ?? []).filter((c) => ++c.attempts >= MAX_COPY_ATTEMPTS);
      if (worn.length > 0) await this.dropCopies(it, f, worn);
      else await this.save(it);
    });
  }

  /** Gap 35: record the photo's device OCR (after its copies). Same rules as the copies. */
  private async sendOcr(it: OutboxItem, f: OutboxFile): Promise<boolean> {
    const o = f.ocr;
    const server = this.d.server;
    if (!o || !server.recordOcr) return false;
    try {
      await server.recordOcr({
        case_id: it.case_id,
        original_sha256: f.sha256,
        source_width: o.source_width,
        engine_version: o.engine_version,
        lang: o.lang,
        text: o.text,
        blocks: o.blocks,
        mean_confidence: o.mean_confidence,
        description: o.description,
      });
      f.ocr = null; // recorded (or already there): done
      await this.save(it);
      this.failures = 0;
      this.nextRetryAt = null;
      return false;
    } catch (e) {
      const drop = async () => {
        f.ocr = null;
        await this.save(it);
      };
      return this.onSideError('ocr', it, e, drop, async () => {
        if (++o.attempts >= MAX_COPY_ATTEMPTS) await drop();
        else await this.save(it);
      });
    }
  }

  /** Shared by copies and device OCR: refused = dropped, session trouble = pause, transient = wear + backoff. */
  private async onSideError(what: string, it: OutboxItem, e: unknown, drop: () => Promise<void>, wear: () => Promise<void>): Promise<boolean> {
    const err = e instanceof ServerError ? e : new ServerError('transient', 'client', e instanceof Error ? e.message : String(e));
    this.d.log(`outbox ${what} ${it.client_message_id}: ${err.kind} ${err.code}`);
    switch (err.kind) {
      case 'window_closed':
      case 'rejected':
        await drop();
        return false;
      case 'auth':
      case 'drain_closed':
      case 'reactivated':
        this.paused = true;
        this.changed();
        this.emit({ type: err.kind === 'auth' ? 'auth_blocked' : err.kind });
        return true;
      case 'transient':
        await wear();
        this.failures += 1;
        this.nextRetryAt = this.d.now().getTime() + backoffDelay(this.failures, this.d.random);
        this.changed();
        return true;
    }
  }

  /** Remove copies from the file (and their sandbox files); persists. */
  private async dropCopies(it: OutboxItem, f: OutboxFile, which: readonly OutboxCopy[]): Promise<void> {
    if (which.length === 0) return;
    f.copies = (f.copies ?? []).filter((c) => !which.includes(c));
    await this.dropCopyFiles(which);
    await this.save(it);
  }

  private async uploadFile(it: OutboxItem, f: OutboxFile): Promise<void> {
    if (!it.task_id) throw new ServerError('window_closed', 'no_task', 'no task to upload under');
    const p = await this.d.server.presign({
      case_id: it.case_id,
      task_id: it.task_id,
      sha256: f.sha256,
      ext: f.ext,
      device_captured_at: f.device_captured_at,
      size_bytes: f.size_bytes,
      mime_type: f.mime_type,
    });
    if (!p.already_stored) {
      await this.d.transport.put(p.url, p.headers, f.local_path, (n) => {
        f.bytes_sent = n;
        this.changed();
      });
    }
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
    if (!this.online || this.paused || this.nextRetryAt === null || !(this.nextQueued() || this.nextCopyWork())) return;
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
        // a sent row stays while its shrunk copies / device OCR are still to be sent (invisible to the operator)
        if (!isPending(it) && !it.files.some((f) => this.hasSideWork(f))) {
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
      // device OCR goes separately through record_device_ocr (checked), never in p_items
    })),
  };
}
