/** Persistence for the read cache (separate from the outbox store). One row per block, with the fetch time. */
export interface CacheRow { data: string; synced_at: string }

export interface CacheStore {
  get(key: string): Promise<CacheRow | null>;
  put(key: string, data: string, syncedAt: string): Promise<void>;
  /** key -> synced_at for every stored block. */
  syncedMap(): Promise<Record<string, string>>;
  clear(): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  rows = new Map<string, CacheRow>();
  async get(key: string) { return this.rows.get(key) ?? null; }
  async put(key: string, data: string, syncedAt: string) { this.rows.set(key, { data, synced_at: syncedAt }); }
  async syncedMap() { return Object.fromEntries([...this.rows].map(([k, v]) => [k, v.synced_at])); }
  async clear() { this.rows.clear(); }
}
