// Fetches thread images through `evidence-view` (pure core with injected calls, tested with fakes).
// Requests of one variant made within a few milliseconds go out as one call (≤ 50 ids, the function's
// limit), each image is downloaded once at a time per key, at most 3 downloads run together, and a key
// that failed is not asked for again for a while (no hammering on a bad connection or a missing file).
import { batches, type Variant } from './sources';

export interface ViewLink { id: string; url?: string; sha256?: string | null; error?: string }

export interface LoaderDeps {
  /** evidence-view with the caller's JWT: `{evidence_ids, variant, disposition: 'inline'}` → files. Throws on failure. */
  links(ids: string[], variant: Variant): Promise<ViewLink[]>;
  /** Download into the file cache under `key`, verified against `sha256`; false on failure. */
  download(key: string, url: string, sha256: string | null): Promise<boolean>;
  now?: () => number;
  /** Wait before a batch goes out (ms). */
  schedule?: (fn: () => void) => void;
}

export const RETRY_AFTER_MS = 2 * 60_000;
const MAX_DOWNLOADS = 3;

interface Want { id: string; key: string; resolve: (ok: boolean) => void }

export function createLoader(d: LoaderDeps) {
  const now = d.now ?? Date.now;
  const schedule = d.schedule ?? ((fn: () => void) => setTimeout(fn, 60));
  const inFlight = new Map<string, Promise<boolean>>();
  const failedAt = new Map<string, number>();
  const queue = new Map<Variant, Want[]>();
  let scheduled = false;
  let running = 0;
  const waiting: (() => void)[] = [];

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= MAX_DOWNLOADS) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  async function flush() {
    scheduled = false;
    const all = [...queue.entries()];
    queue.clear();
    for (const [variant, wants] of all) {
      for (const group of batches(wants)) {
        let links: ViewLink[] = [];
        try {
          links = await d.links([...new Set(group.map((w) => w.id))], variant);
        } catch {
          links = [];
        }
        const byId = new Map(links.map((l) => [l.id, l] as const));
        for (const w of group) {
          const l = byId.get(w.id);
          if (!l || !l.url || l.error) {
            w.resolve(false);
            continue;
          }
          const url = l.url;
          void slot(() => d.download(w.key, url, l.sha256 ?? null)).then(w.resolve, () => w.resolve(false));
        }
      }
    }
  }

  return {
    /** Resolves true once `key` is in the cache. Repeated calls share one request. */
    fetch(id: string, variant: Variant, key: string): Promise<boolean> {
      const cur = inFlight.get(key);
      if (cur) return cur;
      const failed = failedAt.get(key);
      if (failed !== undefined && now() - failed < RETRY_AFTER_MS) return Promise.resolve(false);
      const p = new Promise<boolean>((resolve) => {
        const list = queue.get(variant) ?? [];
        list.push({ id, key, resolve });
        queue.set(variant, list);
        if (!scheduled) {
          scheduled = true;
          schedule(() => void flush());
        }
      }).then((ok) => {
        inFlight.delete(key);
        if (ok) failedAt.delete(key);
        else failedAt.set(key, now());
        return ok;
      });
      inFlight.set(key, p);
      return p;
    },
    /** Forget failures (e.g. back online). */
    reset() {
      failedAt.clear();
    },
  };
}

export type Loader = ReturnType<typeof createLoader>;
