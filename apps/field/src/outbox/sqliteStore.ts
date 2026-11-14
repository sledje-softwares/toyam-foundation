// expo-sqlite Store (thin adapter, untested). One row per message, the item as JSON; survives restarts.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { Store } from './store';
import type { OutboxItem } from './types';

export async function openSqliteStore(open: () => Promise<SQLiteDatabase>): Promise<Store> {
  const db = await open();
  await db.execAsync(`
    pragma journal_mode = wal;
    create table if not exists outbox_items (
      client_message_id text primary key not null,
      case_id text not null,
      state text not null,
      created_at text not null,
      data text not null
    );
    create table if not exists outbox_meta (key text primary key not null, value text not null);
  `);
  const put = (i: OutboxItem) =>
    db.runAsync(
      'insert or replace into outbox_items (client_message_id, case_id, state, created_at, data) values (?, ?, ?, ?, ?)',
      [i.client_message_id, i.case_id, i.state, i.created_at, JSON.stringify(i)],
    );
  return {
    async load() {
      const rows = await db.getAllAsync<{ data: string }>('select data from outbox_items order by created_at');
      return rows.map((r) => JSON.parse(r.data) as OutboxItem);
    },
    async put(i) {
      await put(i);
    },
    async replace(removeId, add) {
      await db.withTransactionAsync(async () => {
        await db.runAsync('delete from outbox_items where client_message_id = ?', [removeId]);
        for (const i of add) await put(i);
      });
    },
    async remove(id) {
      await db.runAsync('delete from outbox_items where client_message_id = ?', [id]);
    },
    async clear() {
      await db.execAsync('delete from outbox_items; delete from outbox_meta;');
    },
    async getMeta(key) {
      const r = await db.getFirstAsync<{ value: string }>('select value from outbox_meta where key = ?', [key]);
      return r?.value ?? null;
    },
    async setMeta(key, value) {
      if (value === null) await db.runAsync('delete from outbox_meta where key = ?', [key]);
      else await db.runAsync('insert or replace into outbox_meta (key, value) values (?, ?)', [key, value]);
    },
  };
}
