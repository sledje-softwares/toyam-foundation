// Test fakes for the outbox (not a test file itself).
import { Outbox } from './outbox';
import { type OutboxReport, type PostMessage, type Presigned, type PresignRequest, type Server, ServerError, type Transport } from './server';
import { MemoryStore } from './store';
import type { NewItem } from './types';

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

export function setup(opts: { store?: MemoryStore; server?: FakeServer; clock?: Clock; deviceId?: string | null } = {}) {
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
