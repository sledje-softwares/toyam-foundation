// Supabase Edge Function `intake` (M3). Called by the Gmail relay Worker with one raw message.
//
//   POST /functions/v1/intake                 body: raw RFC 822 message (message/rfc822)
//     headers: x-intake-secret (required), x-gmail-thread-id, x-gmail-msgid (optional, from IMAP)
//     senders: the Worker's email() handler (push, D33) and its hourly IMAP safety net
//   POST /functions/v1/intake?reprocess=<path>  re-reads a stored raw message (after intake_retry)
//
// Steps: store raw + attachments in `email-raw` → decode → rule-based parser
// (../_shared/intake) against intake_config() → intake_ingest(decision) in one transaction.
// Idempotent: the same message can be posted any number of times.
// Secrets: INTAKE_SECRET (shared with the Worker). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import PostalMime from 'npm:postal-mime@4.2.1';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { processEmail } from '../_shared/intake/index.ts';
import { bytesOf, fromPostalMime, sha256Hex } from '../_shared/intake/mime.ts';
import type { IntakeConfig } from '../_shared/intake/types.ts';

const BUCKET = 'email-raw';
const MAX_BYTES = 45 * 1024 * 1024;
const CONFIG_TTL_MS = 5 * 60 * 1000;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SECRET = Deno.env.get('INTAKE_SECRET') ?? '';

let cache: { at: number; cfg: IntakeConfig } | null = null;
async function intakeConfig(): Promise<IntakeConfig> {
  if (cache && Date.now() - cache.at < CONFIG_TTL_MS) return cache.cfg;
  const { data, error } = await db.rpc('intake_config');
  if (error) throw new Error(`intake_config: ${error.message}`);
  cache = { at: Date.now(), cfg: data as IntakeConfig };
  return cache.cfg;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function extension(filename: string, mime: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename);
  if (m) return '.' + m[1].toLowerCase();
  const sub = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  return sub ? '.' + sub.toLowerCase() : '';
}

async function put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  // Already stored by an earlier (retried) delivery: content-addressed, so it is the same file.
  if (error && !/exists|duplicate|409/i.test(`${error.message} ${(error as { statusCode?: string }).statusCode ?? ''}`)) {
    throw new Error(`upload ${path}: ${error.message}`);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!safeEqual(req.headers.get('x-intake-secret') ?? '', SECRET)) return json(401, { error: 'unauthorised' });

  const url = new URL(req.url);
  const reprocess = url.searchParams.get('reprocess');
  let raw: Uint8Array;
  let rawPath: string | null = null;
  if (reprocess) {
    const { data, error } = await db.storage.from(BUCKET).download(reprocess);
    if (error || !data) return json(404, { error: `raw message not found: ${reprocess}` });
    raw = new Uint8Array(await data.arrayBuffer());
    rawPath = reprocess;
  } else {
    raw = new Uint8Array(await req.arrayBuffer());
  }
  if (raw.byteLength === 0) return json(400, { error: 'empty message' });
  if (raw.byteLength > MAX_BYTES) return json(413, { error: 'message too large' });

  const rawSha = await sha256Hex(raw);
  const now = new Date();
  const prefix = `emails/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${rawSha}`;
  rawPath ??= `${prefix}/message.eml`;
  let messageId = req.headers.get('x-gmail-msgid') ? `gmail-${req.headers.get('x-gmail-msgid')}` : `sha-${rawSha}`;

  // Infrastructure errors (storage, database) → 500 so the sender retries; the message is not lost.
  // Bad input (undecodable MIME, no Message-ID) → a visible failed record and 200, so one poison
  // message cannot block the mailbox.
  const storeRaw = async () => {
    if (!reprocess) await put(rawPath!, raw, 'message/rfc822');
  };

  let email;
  let parts;
  try {
    const pm = await PostalMime.parse(raw);
    parts = pm.attachments ?? [];
    email = await fromPostalMime(pm, {
      threadId: req.headers.get('x-gmail-thread-id'),
      gmailMessageId: req.headers.get('x-gmail-msgid'),
    });
    messageId = email.messageId;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('intake: undecodable message', messageId, message);
    try {
      await storeRaw();
    } catch (se) {
      return json(500, { error: se instanceof Error ? se.message : String(se) });
    }
    const { error } = await db.rpc('intake_record_failure', {
      p_message_id: messageId, p_raw_storage_path: rawPath, p_error: message, p_subject: null, p_from: null,
    });
    if (error) return json(500, { error: message, record_failure: error.message });
    return json(200, { result: 'failed', error: message });
  }

  // Push (Gmail forwarding) and the hourly IMAP safety net deliver the same mail twice with
  // different bytes: stop here, before storing anything, when the Message-ID is already known.
  if (!reprocess) {
    const { data: known, error: knownError } = await db.from('emails').select('id, case_id')
      .eq('gmail_message_id', messageId).maybeSingle();
    if (knownError) return json(500, { error: knownError.message });
    if (known) return json(200, { result: 'duplicate', email_id: known.id, case_id: known.case_id });
  }

  try {
    await storeRaw();
    // attachments are content-addressed and shared across copies of the same mail
    for (let i = 0; i < parts.length; i++) {
      const a = email.attachments[i];
      const path = `emails/att/${a.sha256}${extension(a.filename, a.mimeType)}`;
      await put(path, bytesOf(parts[i].content), a.mimeType);
      a.storagePath = path;
    }
    const cfg = await intakeConfig();
    let decision;
    try {
      decision = processEmail(email, cfg, { path: rawPath, sha256: rawSha });
    } catch (e) {
      // parser bug: deterministic, so record instead of retrying forever
      const message = `parser: ${e instanceof Error ? e.message : String(e)}`;
      const { error } = await db.rpc('intake_record_failure', {
        p_message_id: messageId, p_raw_storage_path: rawPath, p_error: message,
        p_subject: email.subject, p_from: email.from.address,
      });
      if (error) throw new Error(`intake_record_failure: ${error.message}`);
      return json(200, { result: 'failed', error: message });
    }
    const { data, error } = await db.rpc('intake_ingest', { p: decision });
    if (error) throw new Error(`intake_ingest: ${error.message}`);
    return json(200, { ...(data as Record<string, unknown>), action: decision.action, notes: decision.notes });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('intake: temporary failure', messageId, message);
    return json(500, { error: message });
  }
});
