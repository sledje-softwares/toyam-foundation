// App-wide cache instance (thin wiring, untested).
import { openDatabaseAsync } from 'expo-sqlite';
import { CaseCache } from './caseCache';
import { openSqliteCacheStore } from './sqliteCacheStore';

let instance: Promise<CaseCache> | null = null;

export function getCache(): Promise<CaseCache> {
  if (!instance) instance = openSqliteCacheStore(() => openDatabaseAsync('case-cache.db')).then((s) => new CaseCache(s));
  return instance;
}
