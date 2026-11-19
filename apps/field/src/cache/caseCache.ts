import type { CaseRow } from '../lib/cases';
import type { OutboxItem } from '../outbox/types';
import type { ServerFile } from '../thread/model';
import type { ChecklistRow } from '../ui-logic/offline';
import { trimMessages } from './logic';
import type { CacheStore } from './store';

export interface Msg {
  id: string;
  kind: 'text' | 'media' | 'voice' | 'system' | 'request';
  body: string | null;
  sender_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
  /** The phone's idempotency key for own messages (rule 6); absent in caches written before 2026-11-19. */
  client_message_id?: string | null;
}

/** Files of the cached thread messages plus the office's last read time (for blue ✓✓). */
export interface ThreadFiles { files: ServerFile[]; staff_last_read_at: string | null }

/** What a field user may read under RLS: cases, parties and intake-sourced case_field_values (labels are staff-only). */
export interface CaseHeader {
  case_ref: string;
  title: string | null;
  insurer_name: string;
  policy_no: string | null;
  incident_date: string | null;
  suspicion_summary: string | null;
  parties: { role: string; name: string; phone: string | null; address: string | null }[];
  intake_values: { field_id: string; value: string | null }[];
}

export interface Cached<T> { data: T; synced_at: string }

const key = {
  list: 'list',
  header: (id: string) => `header:${id}`,
  checklist: (id: string) => `checklist:${id}`,
  messages: (id: string) => `messages:${id}`,
  files: (id: string) => `files:${id}`,
  tasks: 'known_tasks',
  reads: 'local_reads',
  delivered: 'delivered_items',
};

/** Typed access to the read cache. Every put stores a synced_at; every get returns it. */
export class CaseCache {
  private store: CacheStore;
  private clock: () => string;
  constructor(store: CacheStore, clock: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  private async read<T>(k: string): Promise<Cached<T> | null> {
    const r = await this.store.get(k);
    if (!r) return null;
    try { return { data: JSON.parse(r.data) as T, synced_at: r.synced_at }; } catch { return null; }
  }
  private async write(k: string, v: unknown): Promise<string> {
    const at = this.clock();
    await this.store.put(k, JSON.stringify(v), at);
    return at;
  }

  getList() { return this.read<CaseRow[]>(key.list); }
  putList(rows: CaseRow[]) { return this.write(key.list, rows); }
  getHeader(id: string) { return this.read<CaseHeader>(key.header(id)); }
  putHeader(id: string, h: CaseHeader) { return this.write(key.header(id), h); }
  getChecklist(id: string) { return this.read<ChecklistRow[]>(key.checklist(id)); }
  putChecklist(id: string, rows: ChecklistRow[]) { return this.write(key.checklist(id), rows); }
  getMessages(id: string) { return this.read<Msg[]>(key.messages(id)); }
  putMessages(id: string, msgs: Msg[]) { return this.write(key.messages(id), trimMessages(msgs)); }
  getFiles(id: string) { return this.read<ThreadFiles>(key.files(id)); }
  /** Only the files of the cached messages are kept. */
  putFiles(id: string, f: ThreadFiles, msgs: readonly Pick<Msg, 'id'>[]) {
    const ids = new Set(msgs.map((m) => m.id));
    return this.write(key.files(id), { ...f, files: f.files.filter((x) => ids.has(x.message_id)) });
  }

  /** Stored items the outbox already dropped whose server copy no thread has fetched yet (gap 6). */
  async getDelivered(): Promise<OutboxItem[]> {
    return (await this.read<OutboxItem[]>(key.delivered))?.data ?? [];
  }
  putDelivered(items: readonly OutboxItem[]) { return this.write(key.delivered, items); }

  /** Newest message time shown per thread (gap 9: the badge of a cached list row clears offline too). */
  async getReads(): Promise<Record<string, string>> {
    return (await this.read<Record<string, string>>(key.reads))?.data ?? {};
  }
  async markRead(caseId: string, at: string): Promise<void> {
    const all = await this.getReads();
    const cur = all[caseId];
    if (cur && Date.parse(cur) >= Date.parse(at)) return;
    await this.write(key.reads, { ...all, [caseId]: at });
  }

  /** Task ids already seen as open (for once-per-new-task retryHeld). */
  async getKnownTasks(): Promise<Set<string> | null> {
    const r = await this.read<string[]>(key.tasks);
    return r ? new Set(r.data) : null;
  }
  putKnownTasks(ids: Iterable<string>) { return this.write(key.tasks, [...ids]); }

  /** Keys used by the freshness labels: `<caseId>` (header / thread) and `checklist:<caseId>`. */
  async syncedAt(): Promise<Record<string, string>> {
    const all = await this.store.syncedMap();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('header:')) out[k.slice(7)] = v;
      else if (k.startsWith('checklist:')) out[k] = v;
    }
    return out;
  }

  clear() { return this.store.clear(); }
}
