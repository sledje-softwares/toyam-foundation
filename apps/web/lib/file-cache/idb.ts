/**
 * IndexedDB store for the browser file cache (core.ts). Database `toyam-files`:
 *   files    sha256 → { sha256, bytes }          the bytes
 *   entries  sha256 → FileEntry                  what the cache knows about them (listed without loading bytes)
 *   meta     key    → value                      e.g. "user" (the signed-in user the files belong to)
 * Every call is wrapped: no IndexedDB (private window, blocked site data, SSR), a quota error or a broken database
 * degrade to "no cache" — reads return nothing, writes do nothing — and the page keeps working.
 */
import type { FileEntry, FileRecord, FileStore } from "./core";

export const DB_NAME = "toyam-files";
const DB_VERSION = 1;
const FILES = "files";
const ENTRIES = "entries";
const META = "meta";

let dbPromise: Promise<IDBDatabase | null> | null = null;
let persistAsked = false;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "sha256" });
        if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: "sha256" });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading or deleting the database: let go, the next call reopens.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  void dbPromise.then((db) => {
    if (!db) dbPromise = null; // try again on a later call
    else askPersist();
  });
  return dbPromise;
}

/** Best effort, once: ask the browser not to evict this origin's storage under pressure. */
function askPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // not available
  }
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    const db = await openDb();
    if (!db) return fallback;
    return await fn(db);
  } catch {
    return fallback;
  }
}

export const idbStore: FileStore = {
  getFile: (sha256) =>
    withDb<FileRecord | null>(null, async (db) => {
      const tx = db.transaction([FILES, ENTRIES], "readonly");
      const [f, e] = await Promise.all([
        result(tx.objectStore(FILES).get(sha256)) as Promise<{ sha256: string; bytes: ArrayBuffer } | undefined>,
        result(tx.objectStore(ENTRIES).get(sha256)) as Promise<FileEntry | undefined>,
      ]);
      if (!f || !e) return null;
      return { ...e, sha256: f.sha256, bytes: f.bytes };
    }),
  putFile: (rec) =>
    withDb(undefined, async (db) => {
      const tx = db.transaction([FILES, ENTRIES], "readwrite");
      const { bytes, ...entry } = rec;
      tx.objectStore(FILES).put({ sha256: rec.sha256, bytes });
      tx.objectStore(ENTRIES).put(entry);
      await done(tx);
    }),
  touch: (sha256, lastUsed) =>
    withDb(undefined, async (db) => {
      const tx = db.transaction(ENTRIES, "readwrite");
      const s = tx.objectStore(ENTRIES);
      const e = (await result(s.get(sha256))) as FileEntry | undefined;
      if (e) s.put({ ...e, lastUsed });
      await done(tx);
    }),
  deleteFiles: (shas) =>
    withDb(undefined, async (db) => {
      if (!shas.length) return;
      const tx = db.transaction([FILES, ENTRIES], "readwrite");
      for (const sha of shas) {
        tx.objectStore(FILES).delete(sha);
        tx.objectStore(ENTRIES).delete(sha);
      }
      await done(tx);
    }),
  listEntries: () =>
    withDb<FileEntry[]>([], async (db) => {
      const tx = db.transaction(ENTRIES, "readonly");
      return ((await result(tx.objectStore(ENTRIES).getAll())) as FileEntry[]) ?? [];
    }),
  clear: () =>
    withDb(undefined, async (db) => {
      const tx = db.transaction([FILES, ENTRIES, META], "readwrite");
      tx.objectStore(FILES).clear();
      tx.objectStore(ENTRIES).clear();
      tx.objectStore(META).clear();
      await done(tx);
    }),
  getMeta: (key) =>
    withDb<string | null>(null, async (db) => {
      const tx = db.transaction(META, "readonly");
      const v = await result(tx.objectStore(META).get(key));
      return typeof v === "string" ? v : null;
    }),
  setMeta: (key, value) =>
    withDb(undefined, async (db) => {
      const tx = db.transaction(META, "readwrite");
      tx.objectStore(META).put(value, key);
      await done(tx);
    }),
};
