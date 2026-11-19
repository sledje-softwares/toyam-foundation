// Reading evidence bytes: Cloudflare R2 (field files and their 384 / 1600 px copies, presigned GET with the
// read-only token) and Supabase Storage (insurer attachments, bucket email-raw). Every read is size-capped
// and, where the database knows the hash, checked against it (evidence is immutable, D13).
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { presignUrl } from '../../../supabase/functions/_shared/r2/presign.ts';
import type { R2Config } from '../../../supabase/functions/_shared/r2/presign.ts';

/** Supabase Storage bucket of evidence rows with storage_backend = 'supabase' (same as evidence-view). */
export const SUPABASE_EVIDENCE_BUCKET = 'email-raw';

export interface ObjectStore {
  get(backend: string, path: string, opts: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
}

export class StoreError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read and verify: refuses bytes whose SHA-256 differs from the recorded one. */
export async function getVerified(store: ObjectStore, backend: string, path: string, sha256: string,
                                  opts: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
  const bytes = await store.get(backend, path, opts);
  const got = sha256Hex(bytes);
  if (got !== sha256.toLowerCase()) throw new StoreError('stored bytes do not match the recorded SHA-256', false);
  return bytes;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<Response>;

/** Read a response body with a byte cap (the Content-Length header is checked first when present). */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new StoreError(`object is larger than ${maxBytes} bytes`, false);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new StoreError(`object is larger than ${maxBytes} bytes`, false);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function createObjectStore(deps: {
  r2: R2Config | null;
  supabase: SupabaseClient | null;
  fetch?: FetchFn;
  now?: () => Date;
}): ObjectStore {
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => new Date());
  return {
    async get(backend, path, opts) {
      if (backend === 'r2') {
        if (!deps.r2) throw new StoreError('R2 is not configured (R2_ACCOUNT_ID, R2_BUCKET, R2_READ_ACCESS_KEY_ID, R2_READ_SECRET_ACCESS_KEY)', false);
        const url = await presignUrl({
          method: 'GET',
          host: `${deps.r2.accountId}.r2.cloudflarestorage.com`,
          path: `/${deps.r2.bucket}/${path}`,
          region: 'auto',
          service: 's3',
          accessKeyId: deps.r2.accessKeyId,
          secretAccessKey: deps.r2.secretAccessKey,
          date: now(),
          expiresSeconds: 120,
        });
        const res = await fetchFn(url, { signal: opts.signal });
        if (!res.ok) {
          await res.body?.cancel();
          throw new StoreError(`R2 GET failed: HTTP ${res.status}`, res.status === 429 || res.status >= 500);
        }
        return readCapped(res, opts.maxBytes);
      }
      if (backend === 'supabase') {
        if (!deps.supabase) throw new StoreError('Supabase Storage is not configured', false);
        const { data, error } = await deps.supabase.storage.from(SUPABASE_EVIDENCE_BUCKET).download(path);
        if (error || !data) throw new StoreError(`Storage download failed: ${error?.message ?? 'no data'}`, true);
        if (data.size > opts.maxBytes) throw new StoreError(`object is larger than ${opts.maxBytes} bytes`, false);
        return new Uint8Array(await data.arrayBuffer());
      }
      throw new StoreError(`unknown storage backend "${backend}"`, false);
    },
  };
}
