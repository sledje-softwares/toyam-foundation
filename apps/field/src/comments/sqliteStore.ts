// expo-sqlite CommentStore (thin adapter, untested). Own database file (comments.db) and connection, so the
// outbox's transactions on outbox.db are never shared with or blocked by comment writes.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { CommentStore } from './store';
import type { PendingComment } from './types';

export async function openSqliteCommentStore(open: () => Promise<SQLiteDatabase>): Promise<CommentStore> {
  const db = await open();
  await db.execAsync(`
    pragma journal_mode = wal;
    create table if not exists outbox_comments (
      client_comment_id text primary key not null,
      case_id text not null,
      evidence_id text not null,
      state text not null,
      created_at text not null,
      data text not null
    );
  `);
  return {
    async load() {
      const rows = await db.getAllAsync<{ data: string }>('select data from outbox_comments order by created_at');
      return rows.map((r) => JSON.parse(r.data) as PendingComment);
    },
    async put(c) {
      await db.runAsync(
        'insert or replace into outbox_comments (client_comment_id, case_id, evidence_id, state, created_at, data) values (?, ?, ?, ?, ?, ?)',
        [c.client_comment_id, c.case_id, c.evidence_id, c.state, c.created_at, JSON.stringify(c)],
      );
    },
    async remove(id) {
      await db.runAsync('delete from outbox_comments where client_comment_id = ?', [id]);
    },
    async clear() {
      await db.execAsync('delete from outbox_comments;');
    },
  };
}
