// Test fakes for the outbox (not a test file itself).
import { Outbox } from './outbox';
import {
  type DerivativePresign, type DerivativePresignRequest, type DerivativeRecord, type OcrRecord, type OutboxReport, type PostMessage, type Presigned, type PresignRequest,
  type Server, ServerError, type Transport,
} from './server';
import { MemoryStore } from './store';
import type { NewItem, OutboxCopy, OutboxFile, OutboxItem, OutboxOcr } from './types';

export class FakeServer implements Server {
  /** Server-side messages by client_message_id (what the database would hold). */
  messages = new Map<string, PostMessage>();
  postCalls: PostMessage[] = [];
  presignCalls: PresignRequest[] = [];
  reports: OutboxReport[] = [];
  /** Queue of errors to throw from the next calls (undefined = succeed). */
  presignErrors: (ServerError | undefined)[] = [];
  postErrors: (ServerError | undefined)[] = [];
  /** Refuse posts containing any of these sha256 with upload_window_closed. */
  refuseSha = new Set<string>();
  /** Files the case already stores: presign answers already_stored. */
  storedSha = new Set<string>();
  /** Store the message but throw afterwards (reply lost). */
  loseNextReply = false;

  async presign(req: PresignRequest): Promise<Presigned> {
    this.presignCalls.push(req);
    const e = this.presignErrors.shift();
    if (e) throw e;
    if (this.storedSha.has(req.sha256)) {
      return { storage_path: `cases/${req.case_id}/tasks/${req.task_id}/${req.sha256}.${req.ext}`, url: '', headers: {}, already_stored: true };
    }
    return {
      storage_path: `cases/${req.case_id}/tasks/${req.task_id}/${req.sha256}.${req.ext}`,
      url: `https://r2.example/${req.sha256}`,
      headers: { 'x-amz-content-sha256': req.sha256 },
    };
  }

  async postMessage(m: PostMessage): Promise<string> {
    this.postCalls.push(m);
    const existing = this.messages.get(m.client_message_id);
    if (existing) return `msg-${m.client_message_id}`; // idempotent like post_thread_message
    const e = this.postErrors.shift();
    if (e) throw e;
    if (m.items.some((i) => this.refuseSha.has(i.sha256))) {
      throw new ServerError('window_closed', 'upload_window_closed');
    }
    this.messages.set(m.client_message_id, m);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new ServerError('transient', 'network');
    }
    return `msg-${m.client_message_id}`;
  }

  async reportOutbox(r: OutboxReport): Promise<void> {
    this.reports.push(r);
  }
}

/** A signed-in server that also takes shrunk copies (D51). */
export class FakeDerivServer extends FakeServer {
  derivPresigns: DerivativePresignRequest[] = [];
  recorded: DerivativeRecord[] = [];
  /** Errors for the next presign / record calls (undefined = succeed). */
  derivPresignErrors: (ServerError | undefined)[] = [];
  recordErrors: (ServerError | undefined)[] = [];
  /** Per width: answer this status instead of upload. */
  statusByWidth: Partial<Record<number, 'already_stored' | 'skipped'>> = {};

  async presignDerivatives(req: DerivativePresignRequest): Promise<DerivativePresign[]> {
    this.derivPresigns.push(req);
    const e = this.derivPresignErrors.shift();
    if (e) throw e;
    return req.copies.map((c) => {
      const storage_path = `derived/${req.case_id}/${req.original_sha256}/w${c.width}-${c.sha256}.jpg`;
      const s = this.statusByWidth[c.width];
      if (s === 'skipped') return { width: c.width, status: 'skipped' as const };
      if (s === 'already_stored') return { width: c.width, status: 'already_stored' as const, storage_path };
      return { width: c.width, status: 'upload' as const, storage_path, url: `https://r2.example/${storage_path}`, headers: { 'x-amz-content-sha256': c.sha256 } };
    });
  }

  async recordDerivative(rec: DerivativeRecord): Promise<void> {
    const e = this.recordErrors.shift();
    if (e) throw e;
    this.recorded.push(rec);
  }
}

/** A signed-in server that also records device OCR (gap 35). */
export class FakeOcrServer extends FakeDerivServer {
  ocrs: OcrRecord[] = [];
  ocrErrors: (ServerError | undefined)[] = [];
  async recordOcr(rec: OcrRecord): Promise<void> {
    const e = this.ocrErrors.shift();
    if (e) throw e;
    this.ocrs.push(rec);
  }
}

/** A device OCR result like src/ocr/read.ts makes it. */
export const fakeOcr = (text = 'MH 12 AB 3456'): OutboxOcr => ({
  engine_version: 'mlkit-test', lang: 'latin', text,
  blocks: [{ text, bbox: [1, 2, 3, 4], conf: 0.9, line: 0 }], mean_confidence: 0.9,
  description: `Photo; text read from the 1600 px copy: ${text}`, source_width: 1600, attempts: 0,
});

export class FakeTransport implements Transport {
  puts: string[] = [];
  errors: (Error | undefined)[] = [];
  async put(url: string, _h: Record<string, string>, _p: string, onProgress: (n: number) => void): Promise<void> {
    const e = this.errors.shift();
    if (e) throw e;
    onProgress(50);
    this.puts.push(url);
  }
}

export class Clock {
  t: number;
  constructor(iso = '2026-11-14T10:00:00.000Z') {
    this.t = new Date(iso).getTime();
  }
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Two copies of a file like capture/copies.ts makes them; the local paths are recorded in `made`. */
export function fakeMakeCopies(made: string[] = [], fail = false) {
  return async (f: OutboxFile): Promise<OutboxCopy[]> => {
    if (fail) return [];
    return ([1600, 384] as const).map((width) => {
      const local_path = `file:///data/outbox/copy-${f.id}-w${width}.jpg`;
      made.push(local_path);
      return {
        width, local_path, sha256: (f.sha256.slice(0, 2) + width.toString(16)).padEnd(64, 'e').slice(0, 64), size_bytes: width * 100,
        pixel_width: width, pixel_height: Math.round(width * 0.75), storage_path: null, attempts: 0,
      };
    });
  };
}

export function setup(opts: {
  store?: MemoryStore; server?: FakeServer; clock?: Clock; deviceId?: string | null;
  makeCopies?: (f: OutboxFile) => Promise<OutboxCopy[]>;
  readOcr?: (f: OutboxFile, it: OutboxItem) => Promise<OutboxOcr | null>;
} = {}) {
  const store = opts.store ?? new MemoryStore();
  const server = opts.server ?? new FakeServer();
  const transport = new FakeTransport();
  const clock = opts.clock ?? new Clock();
  let n = 0;
  const timers: { ms: number; fn: () => void }[] = [];
  const removed: string[] = [];
  const outbox = new Outbox({
    store,
    server,
    transport,
    deviceId: opts.deviceId === undefined ? 'dev-1' : opts.deviceId,
    makeCopies: opts.makeCopies,
    readOcr: opts.readOcr,
    now: clock.now,
    random: () => 0.5,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    removeFile: async (p) => {
      removed.push(p);
    },
    schedule: (ms, fn) => {
      const t = { ms, fn };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  return { outbox, store, server, transport, clock, timers, removed };
}

let fileNo = 0;
export function newFile(over: Partial<NewItem['files'][number]> = {}): NewItem['files'][number] {
  fileNo++;
  return {
    local_path: `file:///data/outbox/f${fileNo}.jpg`,
    sha256: fileNo.toString(16).padStart(64, 'a'),
    size_bytes: 1000,
    mime_type: 'image/jpeg',
    ext: 'jpg',
    evidence_type: 'photo',
    device_captured_at: '2026-11-14T09:00:00.000Z',
    gps: { latitude: 19.07, longitude: 72.87, accuracy_m: 5 },
    capture_source: 'camera',
    original_filename: null,
    checklist_item_id: null,
    ...over,
  };
}

export const item = (files: NewItem['files'], over: Partial<NewItem> = {}): NewItem => ({
  case_id: 'case-1',
  task_id: 'task-1',
  files,
  ...over,
});
