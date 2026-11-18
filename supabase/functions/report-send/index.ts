// Supabase Edge Function `report-send` (build plan 8.2, D50): sends a queued report email as a reply on
// the insurer's thread through Gmail SMTP (smtp.gmail.com:465, implicit TLS, app password).
// Contract: ./README.md. Flow and no-duplicate rules: ../_shared/report-send/handler.ts.
//
//   POST /functions/v1/report-send   { action: 'send', id }   Authorization: Bearer <staff access token>
//   POST /functions/v1/report-send   { action: 'mode' }       Authorization: Bearer <staff access token>
//   POST /functions/v1/report-send   { action: 'sweep' }      x-send-secret: <SEND_SECRET>  (intake Worker cron)
//
// verify_jwt = false because the sweep caller has no user JWT; the send / mode actions check the caller's
// token themselves (auth.getUser + an RLS read with that token). The service-role key is read from the
// platform env, used only here for the sender's own functions (claim / complete / fail), the queue and
// the `reports` bucket, and never returned or logged (rule 4). Mail content and secrets are never logged.
//
// Secrets: SMTP_USER, SMTP_PASSWORD (Gmail address + app password), SEND_MODE (test | live; absent = test),
// SEND_TEST_TO (required in test mode, forbidden in live mode), SEND_SECRET (sweep), optional
// SEND_FROM_NAME, SEND_SWEEP_BATCH (default 3).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type Gateway, handleReportSend, type Mailer, type Reply } from '../_shared/report-send/handler.ts';
import { readSendConfig } from '../_shared/report-send/logic.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const noSession = { persistSession: false, autoRefreshToken: false };
const service = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: noSession });
const config = readSendConfig((k) => Deno.env.get(k));
if (!config.ok) console.error(`report-send: not configured: ${config.problem}`);

function userClient(jwt: string) {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: noSession, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

async function validUser(jwt: string): Promise<boolean | 'error'> {
  try {
    const { data, error } = await service.auth.getUser(jwt);
    if (error) return (error.status ?? 500) >= 500 ? 'error' : false;
    return !!data.user;
  } catch {
    return 'error';
  }
}

async function readCapped(blob: Blob, maxBytes: number): Promise<Uint8Array | null> {
  if (blob.size > maxBytes) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

const gateway: Gateway = {
  async visibleSend(jwt, id) {
    const user = await validUser(jwt);
    if (user !== true) return user === 'error' ? 'error' : 'unauthorized';
    const { data, error } = await userClient(jwt).from('report_sends').select('id, status').eq('id', id).maybeSingle();
    if (error) return 'error';
    return data ? { status: data.status as string } : null;
  },
  async isStaff(jwt) {
    const user = await validUser(jwt);
    if (user !== true) return user === 'error' ? 'error' : 'unauthorized';
    const { data, error } = await userClient(jwt).rpc('is_staff');
    if (error) return 'error';
    return data === true;
  },
  async pendingSends(limit) {
    const { data, error } = await service.from('report_sends').select('id, status, claimed_at')
      .in('status', ['queued', 'sending']).order('requested_at', { ascending: true }).limit(limit);
    return error ? null : (data as { id: string; status: string; claimed_at: string | null }[]);
  },
  async setting(key) {
    const { data, error } = await service.from('app_settings').select('value').eq('key', key).maybeSingle();
    if (error || !data) return null;
    return typeof data.value === 'string' ? data.value : JSON.stringify(data.value);
  },
  async claim(id, messageId, testRecipient) {
    const { data, error } = await service.rpc('claim_report_send', { p_id: id, p_message_id: messageId, p_test_recipient: testRecipient });
    return { data, error };
  },
  async reportFiles(reportId) {
    const { data, error } = await service.from('report_files').select('format, storage_path, sha256, size_bytes').eq('report_id', reportId);
    return error ? null : (data as { format: string; storage_path: string; sha256: string | null; size_bytes: number | null }[]);
  },
  async download(path, maxBytes) {
    const { data, error } = await service.storage.from('reports').download(path);
    if (error || !data) return null;
    return readCapped(data, maxBytes);
  },
  async complete(id, delivery) {
    const { error } = await service.rpc('complete_report_send', { p_id: id, p_delivery: delivery, p_link_expires: null, p_pack_path: null });
    return { error };
  },
  async fail(id, message, ambiguous) {
    const { error } = await service.rpc('fail_report_send', { p_id: id, p_error: message, p_ambiguous: ambiguous });
    return { error };
  },
  log(msg) {
    console.log(`report-send: ${msg}`);
  },
};

const CONNECT_TIMEOUT_MS = 20_000;

const mailer: Mailer = {
  async open() {
    let timer: number | undefined;
    const conn = await Promise.race([
      Deno.connectTls({ hostname: 'smtp.gmail.com', port: 465 }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('connect timeout')), CONNECT_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return {
      readable: conn.readable,
      writable: conn.writable,
      close: () => {
        try { conn.close(); } catch { /* already closed */ }
      },
    };
  },
};

function defer(p: Promise<unknown>) {
  // Keep the delivery alive after the 202 reply; without EdgeRuntime (plain Deno) it simply runs on.
  const guarded = p.catch((e) => console.error(`report-send: background ${(e as Error).name}`));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(guarded);
}

Deno.serve(async (req) => {
  let reply: Reply;
  try {
    reply = await handleReportSend({
      method: req.method,
      authorization: req.headers.get('authorization'),
      sendSecret: req.headers.get('x-send-secret'),
      body: req.method === 'POST' ? await req.text() : '',
    }, config, { gw: gateway, mailer }, defer);
  } catch (e) {
    console.error(`report-send: unexpected ${(e as Error).name}`);
    reply = { status: 500, body: { ok: false, error: { code: 'internal', message: 'Something went wrong. Try again later.' } } };
  }
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
