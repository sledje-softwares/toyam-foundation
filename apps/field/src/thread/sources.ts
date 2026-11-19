// Where a thread image is shown from (pure). Order: the on-phone file cache (keyed by the file's SHA-256,
// filled from the phone's own copies and from downloads), then the phone's local copies while the message is
// being sent, then a download through `evidence-view` (caller's JWT; RLS decides, rule 4).
// Thumbnails never load a full-size file from the server; the viewer prefers the 1600 px copy.
import type { ThreadFile } from './model';

export type Variant = 'w384' | 'w1600' | 'original';
export type Use = 'thumb' | 'full';

export type Source =
  | { type: 'cache'; key: string }
  | { type: 'local'; uri: string }
  | { type: 'remote'; evidenceId: string; variant: Variant; key: string };

/** Largest original the grid downloads when the server has no 384 px copy (e.g. a small office photo). */
export const THUMB_ORIGINAL_MAX_BYTES = 1_500_000;
/** Largest original the viewer downloads when there is no 1600 px copy. */
export const FULL_ORIGINAL_MAX_BYTES = 15_000_000;

/** Cache file name: `<sha256>-<variant>` (+ ".jpg"). The variant is what was asked for. */
export function cacheKey(id: string, variant: Variant): string {
  return `${id}-${variant}`;
}

const SAFE = /^[0-9a-zA-Z-]+$/;
/** Cache file for a key; null for anything that is not a plain key (never a path from the server). */
export function cacheFileName(key: string): string | null {
  return SAFE.test(key) ? `${key}.img` : null;
}

/** Ordered candidates for one image. The UI takes the first that exists / loads. */
export function sourcePlan(f: Pick<ThreadFile, 'sha256' | 'evidenceId' | 'local' | 'copies' | 'sizeBytes' | 'key'>, use: Use): Source[] {
  const id = f.sha256 ?? f.evidenceId ?? f.key;
  const out: Source[] = [];
  if (use === 'thumb') {
    out.push({ type: 'cache', key: cacheKey(id, 'w384') });
    if (f.local?.w384) out.push({ type: 'local', uri: f.local.w384 });
    if (f.local?.original) out.push({ type: 'local', uri: f.local.original });
    if (f.local?.w1600) out.push({ type: 'local', uri: f.local.w1600 });
    if (f.evidenceId) {
      if (f.copies.includes(384)) out.push({ type: 'remote', evidenceId: f.evidenceId, variant: 'w384', key: cacheKey(id, 'w384') });
      else if ((f.sizeBytes ?? Infinity) <= THUMB_ORIGINAL_MAX_BYTES) {
        // the server answers w384 with the original when it has no copy: small enough for a tile
        out.push({ type: 'remote', evidenceId: f.evidenceId, variant: 'w384', key: cacheKey(id, 'w384') });
      }
    }
    return out;
  }
  out.push({ type: 'cache', key: cacheKey(id, 'w1600') });
  if (f.local?.w1600) out.push({ type: 'local', uri: f.local.w1600 });
  if (f.local?.original) out.push({ type: 'local', uri: f.local.original });
  if (f.evidenceId) {
    if (f.copies.includes(1600)) out.push({ type: 'remote', evidenceId: f.evidenceId, variant: 'w1600', key: cacheKey(id, 'w1600') });
    else if ((f.sizeBytes ?? Infinity) <= FULL_ORIGINAL_MAX_BYTES) {
      out.push({ type: 'remote', evidenceId: f.evidenceId, variant: 'original', key: cacheKey(id, 'original') });
    }
  }
  // the thumbnail is better than nothing (offline, or a big original)
  out.push({ type: 'cache', key: cacheKey(id, 'w384') });
  if (f.local?.w384) out.push({ type: 'local', uri: f.local.w384 });
  if (f.evidenceId && f.copies.includes(384)) out.push({ type: 'remote', evidenceId: f.evidenceId, variant: 'w384', key: cacheKey(id, 'w384') });
  return out;
}

/** What to show now (`show`: a cached or local file) or the download to start (`fetch`); `from` = the plan entry. */
export type Choice =
  | { show: { type: 'cache'; key: string } | { type: 'local'; uri: string }; fetch: null; from: Source }
  | { show: null; fetch: Extract<Source, { type: 'remote' }>; from: Source };

/**
 * First candidate to try: a cached file, a local file (the image's onError moves on if it is gone), a remote
 * entry whose file is already cached, or a download when online. null = nothing to show (placeholder tile).
 */
export function firstAvailable(plan: readonly Source[], has: (key: string) => boolean, online: boolean): Choice | null {
  for (const s of plan) {
    if (s.type === 'cache' && has(s.key)) return { show: s, fetch: null, from: s };
    if (s.type === 'local') return { show: s, fetch: null, from: s };
    if (s.type === 'remote' && has(s.key)) return { show: { type: 'cache', key: s.key }, fetch: null, from: s };
    if (s.type === 'remote' && online) return { show: null, fetch: s, from: s };
  }
  return null;
}

/** The plan without the entries that failed (a local file that is gone, a download that failed, a bad file). */
export function withoutFailed(plan: readonly Source[], failed: readonly Source[]): Source[] {
  return plan.filter((s) => !failed.some((f) => sameSource(f, s)));
}

export function sameSource(a: Source, b: Source): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'local' && b.type === 'local') return a.uri === b.uri;
  if (a.type === 'cache' && b.type === 'cache') return a.key === b.key;
  if (a.type === 'remote' && b.type === 'remote') return a.evidenceId === b.evidenceId && a.variant === b.variant;
  return false;
}

// ------------------------------------------------------------------ cache size

export interface CacheEntry { name: string; size: number; mtime: number }

/** The cache keeps at most `capBytes`; the oldest files go first. Returns the names to delete. */
export function prunePlan(entries: readonly CacheEntry[], capBytes: number): string[] {
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= capBytes) return [];
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= capBytes) break;
    out.push(e.name);
    total -= e.size;
  }
  return out;
}

/** evidence-view takes at most 50 ids per call. */
export function batches<T>(ids: readonly T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
