// On-phone cache of thread images (thin native adapter; the rules are in ./sources.ts).
//
// Files live in the app's cache folder under `thread-files/<sha256>-<variant>.img`. They come from the
// phone's own shrunk copies (seeded when the copies are made, before the outbox deletes them) and from
// downloads through evidence-view whose bytes match the SHA-256 the server reported. Small files only:
// 384 px thumbnails, 1600 px viewer copies, and small originals. Capped at CACHE_CAP_BYTES (oldest first),
// cleared on sign-out. The OS may also clear it: everything here can be fetched again.
import { File } from 'expo-file-system';
import * as FS from 'expo-file-system/legacy';
import { sha256OfFile } from '../capture/hash';
import { cacheFileName, prunePlan, type CacheEntry } from './sources';

export const CACHE_CAP_BYTES = 200 * 1024 * 1024;
const DIR = `${FS.cacheDirectory ?? ''}thread-files/`;

let present = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
let ready: Promise<void> | null = null;

function changed() {
  version++;
  for (const l of listeners) l();
}

export const fileStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: () => version,
  has: (key: string): boolean => present.has(key),
  uri(key: string): string | null {
    const n = cacheFileName(key);
    return n && present.has(key) ? DIR + n : null;
  },
};

/** Reads the folder once (and trims it to the cap). Safe to call often. */
export function initFileStore(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        await FS.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
        const names = await FS.readDirectoryAsync(DIR);
        const entries: CacheEntry[] = [];
        for (const name of names) {
          const info = await FS.getInfoAsync(DIR + name);
          if (info.exists && !info.isDirectory) entries.push({ name, size: info.size ?? 0, mtime: info.modificationTime ?? 0 });
        }
        const drop = new Set(prunePlan(entries, CACHE_CAP_BYTES));
        for (const n of drop) await FS.deleteAsync(DIR + n, { idempotent: true }).catch(() => {});
        present = new Set(entries.filter((e) => !drop.has(e.name) && e.name.endsWith('.img')).map((e) => e.name.slice(0, -4)));
        changed();
      } catch {
        present = new Set();
      }
    })();
  }
  return ready;
}

/** Keep a copy of a file the phone already has (the outbox's shrunk copies). Never throws. */
export async function seedFile(key: string, fromUri: string): Promise<void> {
  const n = cacheFileName(key);
  if (!n) return;
  try {
    await initFileStore();
    if (present.has(key)) return;
    await FS.copyAsync({ from: fromUri, to: DIR + n });
    present.add(key);
    changed();
  } catch {
    // a nicety: the thread downloads it later if needed
  }
}

/** Download `url` into the cache; kept only when the bytes match `sha256` (when the server gave one). */
export async function downloadFile(key: string, url: string, sha256: string | null): Promise<boolean> {
  const n = cacheFileName(key);
  if (!n) return false;
  await initFileStore();
  const tmp = `${DIR}${n}.part`;
  try {
    const res = await FS.downloadAsync(url, tmp);
    if (res.status < 200 || res.status >= 300) throw new Error(`http_${res.status}`);
    if (sha256) {
      const got = await sha256OfFile(tmp, (u) => new File(u).digest('SHA-256'));
      if (got !== sha256.toLowerCase()) throw new Error('sha256_mismatch');
    }
    await FS.moveAsync({ from: tmp, to: DIR + n });
    present.add(key);
    changed();
    return true;
  } catch {
    await FS.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    return false;
  }
}

/** A cached file that would not decode: drop it so it is fetched again. */
export async function forgetFile(key: string): Promise<void> {
  const n = cacheFileName(key);
  if (!n || !present.has(key)) return;
  present.delete(key);
  changed();
  await FS.deleteAsync(DIR + n, { idempotent: true }).catch(() => {});
}

/** Sign-out / drain wipe: another operator may use the phone next. */
export async function clearFileStore(): Promise<void> {
  present = new Set();
  ready = null;
  changed();
  await FS.deleteAsync(DIR, { idempotent: true }).catch(() => {});
}
