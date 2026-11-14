// Supabase Edge Function `evidence-view`: short-lived view / download links for evidence files and
// insurer attachments. Contract: ./README.md.
//
//   POST /functions/v1/evidence-view   Authorization: Bearer <signed-in user's access token>
//   body { evidence_ids?: uuid[], attachment_ids?: uuid[], disposition?: 'inline' | 'attachment' }
//
// Rows are read and Storage links signed with the caller's own JWT (RLS and storage.objects policies
// decide); no service-role key is used. The R2 secret signs GET URLs only and is never returned or
// logged. Secrets: R2_ACCOUNT_ID, R2_BUCKET and R2_READ_ACCESS_KEY_ID / R2_READ_SECRET_ACCESS_KEY
// (or the shared R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY when that token can also read).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleEvidenceView, type Reply } from '../_shared/evidence-view/handler.ts';
import { createRateLimit, DEFAULT_LIMITS, publicStorageUrl, readViewR2Config } from '../_shared/evidence-view/logic.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const PUBLIC_URL = Deno.env.get('PUBLIC_SUPABASE_URL') || undefined;
const r2 = readViewR2Config((k) => Deno.env.get(k));
const limit = createRateLimit(DEFAULT_LIMITS);
const noSession = { persistSession: false, autoRefreshToken: false };

function gateway(authHeader: string): Gateway {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const caller = createClient(SUPABASE_URL, ANON_KEY, { auth: noSession, global: { headers: { Authorization: authHeader } } });
  return {
    async verifyCaller() {
      const { data, error } = await caller.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async selectEvidence(ids) {
      const { data, error } = await caller
        .from('evidence')
        .select('id, evidence_type, storage_backend, storage_path, mime_type, original_filename, cloud_purged_at')
        .in('id', ids);
      return { data, error };
    },
    async selectAttachments(ids) {
      const { data, error } = await caller.from('email_attachments').select('id, filename, mime_type, storage_path').in('id', ids);
      return { data, error };
    },
    async signStorage(bucket, path, seconds, downloadName) {
      const { data, error } = await caller.storage
        .from(bucket)
        .createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
      return error || !data?.signedUrl ? null : publicStorageUrl(data.signedUrl, PUBLIC_URL);
    },
    logError(msg) {
      console.error(`evidence-view: ${msg}`);
    },
  };
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  const hasAuth = /^Bearer\s+\S+/i.test(auth);
  let reply: Reply;
  try {
    const body = req.method === 'POST' ? await req.text() : '';
    reply = await handleEvidenceView(req.method, hasAuth, body, gateway(auth), r2, limit);
  } catch (e) {
    console.error(`evidence-view: unexpected ${(e as Error).name}`);
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
