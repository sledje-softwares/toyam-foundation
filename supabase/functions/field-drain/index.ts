// Supabase Edge Function `field-drain` (D43): lets the phone of a deactivated field operator send
// files captured before deactivation, then wipe. Contract: docs/11-field-app.md "Remote sign-out".
//
//   POST /functions/v1/field-drain   (no user JWT: the operator is banned; verify_jwt = false)
//   body { action: 'status' | 'presign' | 'post' | 'outbox' | 'finish', device_id, secret, ... }
//
// The device secret (registered while active with register_field_device(), hash only) is checked by
// the drain_* SQL functions, which also enforce the deactivation and upload windows and audit every
// item. The service-role key is read from the platform env and never returned or logged; the
// device secret is never logged.
// Secrets: R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (presign only).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleFieldDrain } from '../_shared/field-drain/handler.ts';
import { readR2Config } from '../_shared/field-drain/logic.ts';

const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const r2 = readR2Config((k) => Deno.env.get(k));

const gateway: Gateway = {
  async rpc(fn, args) {
    const { data, error } = await service.rpc(fn, args);
    return { data, error };
  },
  logError(msg) {
    console.error(`field-drain: ${msg}`);
  },
};

Deno.serve(async (req) => {
  let reply;
  try {
    const body = req.method === 'POST' ? await req.text() : '';
    reply = await handleFieldDrain(req.method, body, gateway, r2);
  } catch (e) {
    console.error(`field-drain: unexpected ${(e as Error).name}`);
    reply = { status: 500, body: { ok: false, error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
