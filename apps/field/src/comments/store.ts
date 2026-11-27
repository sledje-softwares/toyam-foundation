import type { PendingComment } from './types';

/** Persistence for the comment queue. The queue keeps an in-memory copy and writes through. */
export interface CommentStore {
  load(): Promise<PendingComment[]>;
  /** Insert or replace by client_comment_id. */
  put(c: PendingComment): Promise<void>;
  remove(clientCommentId: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory store for tests; values are copied so tests see only what was persisted. */
export class MemoryCommentStore implements CommentStore {
  rows = new Map<string, string>();
  async load(): Promise<PendingComment[]> {
    return [...this.rows.values()].map((s) => JSON.parse(s) as PendingComment);
  }
  async put(c: PendingComment): Promise<void> {
    this.rows.set(c.client_comment_id, JSON.stringify(c));
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
}
