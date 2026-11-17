// Supabase Edge Function `report-generate` (build plan 7.7, D51): generates a report version as PDF
// (Cloudflare Browser Rendering) and/or Word, or returns an HTML preview. Contract: ./README.md.
//
//   POST /functions/v1/report-generate   Authorization: Bearer <signed-in staff user's access token>
//   body { case_id: uuid, mode?: 'generate' | 'preview', notes?: string }
//
// Every database and Storage call uses the caller's own JWT (RLS, storage policies and the checks of
// prepare_report_version / create_report_version decide); no service-role key is used (rule 4).
// R2 images are read with the read-only R2 token, only for keys prepare_report_version returned.
// Secrets: R2_ACCOUNT_ID, R2_BUCKET, R2_READ_ACCESS_KEY_ID / R2_READ_SECRET_ACCESS_KEY,
// CF_ACCOUNT_ID, CF_BROWSER_RENDERING_TOKEN, optional CF_BROWSER_MIN_INTERVAL_S (default 10).
// Tokens and signed URLs are never logged.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleReportGenerate, type Reply } from '../_shared/report-generate/handler.ts';
import {
  createRateLimit, GENERATE_LIMITS, type ImageSource, parseRetryAfter, PDF_TIMEOUT_MS, pdfRequest, PREVIEW_LIMITS,
} from '../_shared/report-generate/logic.ts';
import { readViewR2Config, SUPABASE_EVIDENCE_BUCKET } from '../_shared/evidence-view/logic.ts';
import { presignUrl, type R2Config } from '../_shared/r2/presign.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const r2 = readViewR2Config((k) => Deno.env.get(k));
const CF_ACCOUNT_ID = Deno.env.get('CF_ACCOUNT_ID') ?? '';
const CF_TOKEN = Deno.env.get('CF_BROWSER_RENDERING_TOKEN') ?? '';
const minInterval = Number(Deno.env.get('CF_BROWSER_MIN_INTERVAL_S') ?? '10');
const generateLimit = createRateLimit(GENERATE_LIMITS);
const previewLimit = createRateLimit(PREVIEW_LIMITS);
const limit = { take: (key: string, at: number) => (key.startsWith('preview:') ? previewLimit : generateLimit).take(key, at) };
const pdfLimit = Number.isFinite(minInterval) && minInterval > 0 ? createRateLimit([{ windowMs: minInterval * 1000, max: 1 }]) : null;
const noSession = { persistSession: false, autoRefreshToken: false };

/** Reads a response body, giving up (null) past maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function r2Get(cfg: R2Config, key: string, maxBytes: number): Promise<Uint8Array | null> {
  const url = await presignUrl({
    method: 'GET', host: `${cfg.accountId}.r2.cloudflarestorage.com`, path: `/${cfg.bucket}/${key}`, region: 'auto',
    service: 's3', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, date: new Date(), expiresSeconds: 60,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  return readCapped(res, maxBytes);
}

function gateway(authHeader: string): Gateway {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const caller = createClient(SUPABASE_URL, ANON_KEY, { auth: noSession, global: { headers: { Authorization: authHeader } } });
  return {
    async verifyCaller() {
      const { data, error } = await caller.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async prepare(caseId) {
      const { data, error } = await caller.rpc('prepare_report_version', { p_case_id: caseId });
      return { data, error };
    },
    async fetchImage(src: ImageSource, maxBytes) {
      try {
        if (src.store === 'r2') return r2 ? await r2Get(r2, src.path, maxBytes) : null;
        const { data, error } = await caller.storage.from(SUPABASE_EVIDENCE_BUCKET).download(src.path);
        if (error || !data || data.size > maxBytes) return null;
        return new Uint8Array(await data.arrayBuffer());
      } catch (e) {
        console.error(`report-generate: image fetch ${src.store} failed: ${(e as Error).name}`);
        return null;
      }
    },
    async renderPdf(html, pdfOptions) {
      const req = pdfRequest(CF_ACCOUNT_ID, html, pdfOptions);
      let res: Response;
      try {
        res = await fetch(req.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
          body: req.body,
          signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
        });
      } catch (e) {
        return { ok: false, status: 0, retryAfter: null, message: (e as Error).name };
      }
      if (!res.ok) {
        let message: string | null = null;
        try {
          const j = await res.json() as { errors?: { message?: string }[] };
          message = j.errors?.map((x) => x.message ?? '').join('; ') || null;
        } catch { /* not JSON */ }
        return { ok: false, status: res.status, retryAfter: parseRetryAfter(res.headers.get('retry-after'), Date.now()), message };
      }
      return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
    },
    async upload(path, bytes, contentType) {
      const { error } = await caller.storage.from('reports').upload(path, bytes, { contentType, upsert: false });
      return { error: error as { statusCode?: string; message?: string } | null };
    },
    async createVersion(args) {
      const { data, error } = await caller.rpc('create_report_version', args);
      return { data, error };
    },
    logError(msg) {
      console.error(`report-generate: ${msg}`);
    },
  };
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  const hasAuth = /^Bearer\s+\S+/i.test(auth);
  let reply: Reply;
  try {
    const body = req.method === 'POST' ? await req.text() : '';
    reply = await handleReportGenerate(req.method, hasAuth, body, gateway(auth), {
      r2Configured: r2 !== null,
      pdfConfigured: CF_ACCOUNT_ID !== '' && CF_TOKEN !== '',
      limit,
      pdfLimit,
    });
  } catch (e) {
    console.error(`report-generate: unexpected ${(e as Error).name}`);
    reply = { status: 500, body: { ok: false, error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(reply.retryAfter ? { 'Retry-After': String(reply.retryAfter) } : {}),
    },
  });
});
