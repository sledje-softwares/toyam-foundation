/**
 * Browser wiring of the file cache: one gated cache per page load over IndexedDB, SHA-256 with crypto.subtle, and the
 * fetch of a presigned link (R2 / Storage allow GET from this origin; no cookies or referrer are sent). Import only from
 * client components.
 */
import { createFileCache, createLinkBatcher, createPool, DEFAULT_MAX_FILE_BYTES, FileFetchError, type FileCache, type LinkInfo, type Variant } from "./core";
import { idbStore } from "./idb";

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** GET a short-lived link; refuses bodies over the cap before reading them when the size is announced. */
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new FileFetchError("network");
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > DEFAULT_MAX_FILE_BYTES) throw new FileFetchError("too_large");
  return res.arrayBuffer();
}

let cache: FileCache | null = null;
/** The page's cache. Gated: nothing is read or stored until FileCacheProvider has bound the signed-in user. */
export function browserFileCache(): FileCache {
  cache ??= createFileCache({ store: idbStore, sha256: sha256Hex, gated: true });
  return cache;
}

/** Wipes every cached file (sign-out, login page). Never throws and never takes longer than `timeoutMs`. */
export async function wipeBrowserFileCache(timeoutMs = 2000): Promise<void> {
  const wipe = createFileCache({ store: idbStore, sha256: sha256Hex }).wipeAll();
  await Promise.race([wipe.catch(() => {}), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

type LinkAction = (ids: string[], variant: Variant) => Promise<Record<string, LinkInfo>>;
let batcher: ReturnType<typeof createLinkBatcher> | null = null;
/** One batcher per page load, so all thumbnails on a page share evidence-view calls (50 ids each). */
export function browserLinkBatcher(action: LinkAction) {
  batcher ??= createLinkBatcher(action);
  return batcher;
}

/** At most 4 downloads at a time across the page. */
export const downloadPool = createPool(4);
