// expo-sqlite CacheStore (thin adapter, untested). Own database file, separate from the outbox.
import type { SQLiteDatabase } from 'expo-sqlite';
import type { CacheStore } from './store';

export async function openSqliteCacheStore(open: () => Promise<SQLiteDatabase>): Promise<CacheStore> {
  const db = await open();
  await db.execAsync(`
    pragma journal_mode = wal;
    create table if not exists cache_blocks (
      key text primary key not null,
      data text not null,
      synced_at text not null
    );
  `);
  return {
    async get(key) {
      return (await db.getFirstAsync<{ data: string; synced_at: string }>('select data, synced_at from cache_blocks where key = ?', [key])) ?? null;
    },
    async put(key, data, syncedAt) {
      await db.runAsync('insert or replace into cache_blocks (key, data, synced_at) values (?, ?, ?)', [key, data, syncedAt]);
    },
    async syncedMap() {
      const rows = await db.getAllAsync<{ key: string; synced_at: string }>('select key, synced_at from cache_blocks');
      return Object.fromEntries(rows.map((r) => [r.key, r.synced_at]));
    },
    async clear() {
      await db.execAsync('delete from cache_blocks;');
    },
  };
}
