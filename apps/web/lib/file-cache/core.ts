/**
 * Browser file cache, pure part (no IndexedDB, no fetch, no crypto: all injected; tested in Node vitest).
 *
 * Evidence files the office user opened are kept in the browser, keyed by their SHA-256, so a reload shows them without
 * any network request and the report PDF (piece 3) can be built from bytes already on the machine. The guarantee:
 *
 *   - Nothing is stored unless the SHA-256 of the exact bytes being stored equals the hash the server read from the
 *     database (`put` copies the bytes, hashes the copy, stores the copy). A mismatch stores nothing and is an error.
 *   - Every read re-hashes the stored bytes; a record whose bytes no longer match its key is deleted, never returned.
 *   - Retention: wipe on sign-out, on the login page and when another user signs in (`bindUser`); purge finished or
 *     no-longer-visible cases (`casesToPurge` + `purgeCases`); drop files idle for 7 days (`sweep`); a total size cap
 *     with least-recently-used eviction.
 */
import type { Variant } from "@/lib/evidence-view-core";

export type { Variant };

export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
/** Larger files are never fetched into the cache (a preview needs no 30 MB original). */
export const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const DEFAULT_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Case statuses whose files leave the cache (the case is done with). */
export const FINISHED_STATUSES: readonly string[] = ["submitted", "closed", "cancelled"];

const SHA = /^[0-9a-f]{64}$/;
export const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA.test(v);

/** What the cache knows about a stored file (no bytes). */
export type FileEntry = {
  sha256: string;
  mime: string;
  caseId: string;
  evidenceId: string;
  variant: Variant;
  size: number;
  lastUsed: number;
  savedAt: number;
};
export type FileRecord = FileEntry & { bytes: ArrayBuffer };

/** Storage behind the cache. The IndexedDB one (idb.ts) never throws; a failing store behaves as an empty one. */
export interface FileStore {
  getFile(sha256: string): Promise<FileRecord | null>;
  putFile(rec: FileRecord): Promise<void>;
  touch(sha256: string, lastUsed: number): Promise<void>;
  deleteFiles(sha256s: string[]): Promise<void>;
  listEntries(): Promise<FileEntry[]>;
  /** Removes every file and every meta value. */
  clear(): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** Lower-case hex SHA-256 of the bytes (crypto.subtle in the browser, node:crypto in tests). */
export type Sha256Fn = (bytes: ArrayBuffer) => Promise<string>;

export type FileErrorKind = "integrity" | "link" | "network" | "too_large";
export const FILE_ERROR_MESSAGES: Record<FileErrorKind, string> = {
  integrity: "This file failed its integrity check and is not shown. Reload the page; if it happens again, tell an admin.",
  link: "The file could not be opened. Try again.",
  network: "The file could not be downloaded. Check the connection and try again.",
  too_large: "This file is too large to preview here. Open the original instead.",
};

/** A file that could not be shown. `kind: "integrity"` means bytes did not match the database's SHA-256. */
export class FileFetchError extends Error {
  readonly kind: FileErrorKind;
  constructor(kind: FileErrorKind, message?: string) {
    super(message ?? FILE_ERROR_MESSAGES[kind]);
    this.name = "FileFetchError";
    this.kind = kind;
  }
}

/** A short-lived link as the server action returns it (from evidence-view: hash and type read from the database). */
export type LinkInfo =
  | { ok: true; url: string; sha256: string | null; mime: string; variant: Variant; size: number | null; width: number | null }
  | { ok: false; error: string };

export type FetchRequest = {
  evidenceId: string;
  caseId: string;
  variant: Variant;
  /** Hash of the requested variant as the page read it from the database (RLS); a hit needs no network at all. */
  expectedSha256?: string | null;
  getLink: () => Promise<LinkInfo>;
  fetchBytes: (url: string) => Promise<ArrayBuffer>;
};
export type FetchResult = { bytes: ArrayBuffer; mime: string; sha256: string; variant: Variant; fromCache: boolean };

export type FileCache = ReturnType<typeof createFileCache>;

export function createFileCache(deps: {
  store: FileStore;
  sha256: Sha256Fn;
  now?: () => number;
  maxBytes?: number;
  maxFileBytes?: number;
  /** When true, reads and writes wait until `bindUser` has run (so a previous user's files are wiped first). */
  gated?: boolean;
}) {
  const { store, sha256 } = deps;
  const now = deps.now ?? (() => Date.now());
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  let open!: () => void;
  const gate: Promise<void> = deps.gated ? new Promise<void>((r) => (open = r)) : Promise.resolve();

  async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /** A stored file whose bytes still hash to `sha` (re-hashed on every read), or null. Updates lastUsed. */
  async function get(sha: string): Promise<FileRecord | null> {
    await gate;
    if (!isSha256(sha)) return null;
    const rec = await safe(() => store.getFile(sha), null);
    if (!rec) return null;
    const actual = rec.bytes instanceof ArrayBuffer ? await safe(() => sha256(rec.bytes), "") : "";
    if (rec.sha256 !== sha || actual !== sha) {
      await safe(() => store.deleteFiles([sha]), undefined);
      return null;
    }
    const t = now();
    await safe(() => store.touch(sha, t), undefined);
    return { ...rec, lastUsed: t };
  }

  async function evict(): Promise<void> {
    const entries = await safe(() => store.listEntries(), [] as FileEntry[]);
    let total = entries.reduce((s, e) => s + (e.size || 0), 0);
    if (total <= maxBytes) return;
    const drop: string[] = [];
    for (const e of [...entries].sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= maxBytes) break;
      drop.push(e.sha256);
      total -= e.size || 0;
    }
    if (drop.length) await safe(() => store.deleteFiles(drop), undefined);
  }

  /**
   * Stores bytes only after their SHA-256 equals `expectedSha256` (the database's value). Throws
   * FileFetchError("integrity") and stores nothing otherwise. Returns the verified copy that was (or, when larger
   * than the cache, would have been) stored.
   */
  async function put(input: {
    bytes: ArrayBuffer;
    expectedSha256: string;
    mime: string;
    caseId: string;
    evidenceId: string;
    variant: Variant;
  }): Promise<FileRecord> {
    await gate;
    if (!isSha256(input.expectedSha256)) throw new FileFetchError("integrity");
    const bytes = input.bytes.slice(0); // our own copy: what is hashed is exactly what is stored
    const actual = await sha256(bytes);
    if (actual !== input.expectedSha256) throw new FileFetchError("integrity");
    const t = now();
    const rec: FileRecord = {
      sha256: actual,
      mime: input.mime,
      caseId: input.caseId,
      evidenceId: input.evidenceId,
      variant: input.variant,
      size: bytes.byteLength,
      lastUsed: t,
      savedAt: t,
      bytes,
    };
    if (bytes.byteLength <= maxBytes) {
      await safe(() => store.putFile(rec), undefined);
      await evict();
    }
    return rec;
  }

  /** Cache hit, or link → fetch → verify → store. Never returns bytes that failed verification. */
  async function fetchVerified(req: FetchRequest): Promise<FetchResult> {
    const expected = isSha256(req.expectedSha256) ? req.expectedSha256 : null;
    if (expected) {
      const hit = await get(expected);
      if (hit) return { bytes: hit.bytes, mime: hit.mime, sha256: hit.sha256, variant: hit.variant, fromCache: true };
    }
    let link: LinkInfo;
    try {
      link = await req.getLink();
    } catch {
      throw new FileFetchError("link");
    }
    if (!link.ok) throw new FileFetchError("link", link.error || undefined);
    if (!isSha256(link.sha256)) throw new FileFetchError("integrity"); // nothing to verify against: not shown
    // Same variant served but another hash than the page read: something is wrong, do not show either.
    if (expected && link.variant === req.variant && link.sha256 !== expected) throw new FileFetchError("integrity");
    if (link.sha256 !== expected) {
      const hit = await get(link.sha256); // e.g. no copy, the original is already cached
      if (hit) return { bytes: hit.bytes, mime: hit.mime, sha256: hit.sha256, variant: hit.variant, fromCache: true };
    }
    if (link.size !== null && link.size > maxFileBytes) throw new FileFetchError("too_large");
    let bytes: ArrayBuffer;
    try {
      bytes = await req.fetchBytes(link.url);
    } catch (e) {
      if (e instanceof FileFetchError) throw e;
      throw new FileFetchError("network");
    }
    if (bytes.byteLength > maxFileBytes) throw new FileFetchError("too_large");
    const rec = await put({ bytes, expectedSha256: link.sha256, mime: link.mime, caseId: req.caseId, evidenceId: req.evidenceId, variant: link.variant });
    return { bytes: rec.bytes, mime: rec.mime, sha256: rec.sha256, variant: rec.variant, fromCache: false };
  }

  /** Removes every file and the bound user. Does not wait for the gate (used on sign-out). */
  async function wipeAll(): Promise<void> {
    await safe(() => store.clear(), undefined);
  }

  /** Remembers the signed-in user; a different (or unknown) previous owner means every stored file is wiped first. */
  async function bindUser(userId: string): Promise<void> {
    try {
      const prev = await safe(() => store.getMeta("user"), null);
      if (prev !== userId) {
        await safe(() => store.clear(), undefined);
        await safe(() => store.setMeta("user", userId), undefined);
      }
    } finally {
      open?.();
    }
  }

  async function caseIds(): Promise<string[]> {
    await gate;
    const entries = await safe(() => store.listEntries(), [] as FileEntry[]);
    return [...new Set(entries.map((e) => e.caseId))];
  }

  async function purgeCases(ids: string[]): Promise<number> {
    await gate;
    if (!ids.length) return 0;
    const drop = new Set(ids.map((i) => i.toLowerCase()));
    const entries = await safe(() => store.listEntries(), [] as FileEntry[]);
    const shas = entries.filter((e) => drop.has(e.caseId.toLowerCase())).map((e) => e.sha256);
    if (shas.length) await safe(() => store.deleteFiles(shas), undefined);
    return shas.length;
  }

  async function sweep(nowMs: number, idleMs: number = DEFAULT_IDLE_MS): Promise<number> {
    await gate;
    const entries = await safe(() => store.listEntries(), [] as FileEntry[]);
    const shas = entries.filter((e) => e.lastUsed < nowMs - idleMs).map((e) => e.sha256);
    if (shas.length) await safe(() => store.deleteFiles(shas), undefined);
    return shas.length;
  }

  return { get, put, fetchVerified, wipeAll, bindUser, caseIds, purgeCases, sweep };
}

/**
 * Cached case ids to drop: every case the server no longer shows the user (RLS: reassigned away, D44) and every case
 * whose status is finished. `visible` is the server's answer for exactly `cached`.
 */
export function casesToPurge(cached: string[], visible: { id: string; status: string }[]): string[] {
  const seen = new Map(visible.map((c) => [c.id.toLowerCase(), c.status]));
  return cached.filter((id) => {
    const s = seen.get(id.toLowerCase());
    return s === undefined || FINISHED_STATUSES.includes(s);
  });
}

// ---------------------------------------------------------------------------------------------
// Link batching and a small concurrency pool (so a page of thumbnails makes few function calls)
// ---------------------------------------------------------------------------------------------
/** Ids per evidence-view call (the function's limit). */
export const LINK_BATCH = 50;

/**
 * Collects `get(id, variant)` calls for a moment and asks for their links in batches of up to 50 ids per variant,
 * one server action call each (evidence-view counts calls per minute). A missing answer is an error.
 */
export function createLinkBatcher(
  fetchLinks: (ids: string[], variant: Variant) => Promise<Record<string, LinkInfo>>,
  opts: { delayMs?: number; maxIds?: number; schedule?: (fn: () => void, ms: number) => void } = {},
) {
  const delayMs = opts.delayMs ?? 15;
  const maxIds = opts.maxIds ?? LINK_BATCH;
  const schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  type Waiter = { resolve: (l: LinkInfo) => void };
  const queues = new Map<Variant, Map<string, Waiter[]>>();
  const timers = new Set<Variant>();

  async function flush(variant: Variant): Promise<void> {
    timers.delete(variant);
    const q = queues.get(variant);
    if (!q || q.size === 0) return;
    queues.delete(variant);
    const entries = [...q.entries()];
    for (let i = 0; i < entries.length; i += maxIds) {
      const part = entries.slice(i, i + maxIds);
      let res: Record<string, LinkInfo> = {};
      let failed: string | null = null;
      try {
        res = await fetchLinks(part.map(([id]) => id), variant);
      } catch {
        failed = FILE_ERROR_MESSAGES.link;
      }
      for (const [id, waiters] of part) {
        const l: LinkInfo = failed ? { ok: false, error: failed } : (res[id] ?? { ok: false, error: FILE_ERROR_MESSAGES.link });
        for (const w of waiters) w.resolve(l);
      }
    }
  }

  function get(id: string, variant: Variant): Promise<LinkInfo> {
    const key = id.toLowerCase();
    return new Promise<LinkInfo>((resolve) => {
      let q = queues.get(variant);
      if (!q) queues.set(variant, (q = new Map()));
      const list = q.get(key) ?? [];
      list.push({ resolve });
      q.set(key, list);
      if (q.size >= maxIds) void flush(variant);
      else if (!timers.has(variant)) {
        timers.add(variant);
        schedule(() => void flush(variant), delayMs);
      }
    });
  }
  return { get };
}

/** At most `n` tasks at once; the rest wait in order. */
export function createPool(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((r) => waiting.push(r)); // the finishing task hands its slot over
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
