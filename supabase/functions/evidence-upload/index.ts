// Supabase Edge Function `evidence-upload` (build plan 1.4): presigned R2 PUTs for a signed-in
// user's evidence files. Contract: ./README.md.
//
//   POST /functions/v1/evidence-upload   Authorization: Bearer <signed-in user's access token>
//   body { task_id, case_id, files: [{ sha256, size, mime, device_captured_at }] }
//
// Every check runs with the caller's own JWT (can_upload_evidence_at, evidence_upload_target); no
// service-role key is used. The R2 secret signs URLs only and is never returned or logged.
// Secrets: R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (as field-drain).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleEvidenceUpload } from '../_shared/evidence-upload/handler.ts';
import { readR2Config } from '../_shared/r2/presign.ts';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const r2 = readR2Config((k) => Deno.env.get(k));
const noSession = { persistSession: false, autoRefreshToken: false };

function gateway(authHeader: string): Gateway {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const caller = createClient(URL, ANON_KEY, { auth: noSession, global: { headers: { Authorization: authHeader } } });
  return {
    async verifyCaller() {
      const { data, error } = await caller.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async rpc(fn, args) {
      const { data, error } = await caller.rpc(fn, args);
      return { data, error };
    },
    logError(msg) {
      console.error(`evidence-upload: ${msg}`);
    },
  };
}

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  const hasAuth = /^Bearer\s+\S+/i.test(auth);
  let reply;
  try {
    const body = req.method === 'POST' ? await req.text() : '';
    reply = await handleEvidenceUpload(req.method, hasAuth, body, gateway(auth), r2);
  } catch (e) {
    console.error(`evidence-upload: unexpected ${(e as Error).name}`);
    reply = { status: 500, body: { ok: false, error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
