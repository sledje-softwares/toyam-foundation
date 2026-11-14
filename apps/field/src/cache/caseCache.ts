import type { CaseRow } from '../lib/cases';
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
}

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
  tasks: 'known_tasks',
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
