import type { OutboxItem } from './types';

/** Persistence for the outbox. The engine keeps an in-memory copy and writes through. */
export interface Store {
  load(): Promise<OutboxItem[]>;
  /** Insert or replace by client_message_id. */
  put(item: OutboxItem): Promise<void>;
  /** Atomically remove one item and add others (late-upload split). */
  replace(removeId: string, add: OutboxItem[]): Promise<void>;
  remove(clientMessageId: string): Promise<void>;
  clear(): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
}

/** In-memory store for tests; values are copied so tests see only what was persisted. */
export class MemoryStore implements Store {
  items = new Map<string, string>();
  meta = new Map<string, string>();

  async load(): Promise<OutboxItem[]> {
    return [...this.items.values()].map((s) => JSON.parse(s) as OutboxItem);
  }
  async put(item: OutboxItem): Promise<void> {
    this.items.set(item.client_message_id, JSON.stringify(item));
  }
  async replace(removeId: string, add: OutboxItem[]): Promise<void> {
    this.items.delete(removeId);
    for (const i of add) this.items.set(i.client_message_id, JSON.stringify(i));
  }
  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
  async clear(): Promise<void> {
    this.items.clear();
    this.meta.clear();
  }
  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
}
