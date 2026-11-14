// Supabase Edge Function `admin-users` (M2 T5, docs/08 §2.1.5, K2/K4/K5). Contract: ./README.md.
//
//   POST /functions/v1/admin-users   Authorization: Bearer <signed-in user's access token>
//   body { action: 'create' | 'update_login' | 'reset_password' | 'set_active', ... }
//
// The caller's JWT is verified (gateway verify_jwt + auth.getUser) and the caller must be an active
// admin (rpc is_admin with the caller's own client) before the service client is touched. The service
// client is used only for the auth admin API and audit_log. The service-role key is read from the
// platform env and never returned or logged; temporary passwords are returned once and never logged.
// Secrets: FIELD_SIGN_IN (mobile_password | mobile_otp | email_password; default mobile_password).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleAdminUsers } from '../_shared/admin-users/handler.ts';
import { parseFieldSignIn } from '../_shared/admin-users/logic.ts';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const FIELD_SIGN_IN = parseFieldSignIn(Deno.env.get('FIELD_SIGN_IN'));
const noSession = { persistSession: false, autoRefreshToken: false };

// Created lazily, only after the caller is authorised.
let serviceClient: ReturnType<typeof createClient> | null = null;
function service() {
  serviceClient ??= createClient(URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: noSession });
  return serviceClient;
}

function gateway(authHeader: string): Gateway {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const caller = createClient(URL, ANON_KEY, { auth: noSession, global: { headers: { Authorization: authHeader } } });
  return {
    async verifyCaller() {
      const { data, error } = await caller.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },
    async callerIsActiveAdmin() {
      const { data, error } = await caller.rpc('is_admin');
      return !error && data === true;
    },
    async getProfile(id) {
      const { data } = await caller.from('profiles').select('id, full_name, role, is_active').eq('id', id).maybeSingle();
      return data ?? null;
    },
    async findPhoneOwner(variants) {
      const { data } = await caller.from('profiles').select('full_name').in('phone', variants).limit(1);
      return data?.[0]?.full_name ?? null;
    },
    async setProfileActive(id, active) {
      const { data, error } = await caller.from('profiles').update({ is_active: active }).eq('id', id).select('id');
      return { rows: data?.length ?? 0, error };
    },
    async createAuthUser(attrs) {
      const { data, error } = await service().auth.admin.createUser(attrs);
      return { id: data?.user?.id ?? null, error };
    },
    async updateAuthUser(id, attrs) {
      const { error } = await service().auth.admin.updateUserById(id, attrs);
      return { error };
    },
    async getAuthUser(id) {
      const { data } = await service().auth.admin.getUserById(id);
      return data?.user ? { email: data.user.email ?? null, phone: data.user.phone ?? null } : null;
    },
    async writeAudit(row) {
      const { error } = await service().from('audit_log').insert(row);
      return { error };
    },
    logError(msg) {
      console.error(`admin-users: ${msg}`);
    },
  };
}

Deno.serve(async (req) => {
  let reply;
  try {
    const auth = req.headers.get('Authorization') ?? '';
    const body = req.method === 'POST' ? await req.text() : '';
    reply = await handleAdminUsers(req.method, /^Bearer\s+\S+/i.test(auth), body, gateway(auth), FIELD_SIGN_IN);
  } catch (e) {
    console.error(`admin-users: unexpected ${(e as Error).name}`);
    reply = { status: 500, body: { ok: false, error: { code: 'internal', message: 'Something went wrong. Nothing may have been saved. Try again.' } } };
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
