// Cloudflare Worker for email intake.
//
//   email()      PUSH (D33): Gmail filter auto-forwards insurer mail to an Email Routing address
//                (e.g. intake@in.toyaminvestigation.in) routed to this Worker. Runs only when mail
//                arrives and relays the raw message to the Supabase `intake` function.
//   scheduled()  SAFETY NET: hourly IMAP poll of the shared inbox (insurer senders only) for
//                anything forwarding missed. Idempotent downstream (Message-ID).
//   scheduled()  RETRY QUEUE (D39, cron */10): staff-queued retries of failed emails are claimed and
//                reprocessed through the intake function; stuck ones alert in-app and by one email
//                (ALERT_EMAIL=smtp: Gmail SMTP with the same app password, no DNS needed).
//   fetch()      Manual poll for testing: POST / with header x-intake-secret (POST /retry: one retry run).
//
// Secrets (wrangler secret put): GMAIL_USER, GMAIL_APP_PASSWORD, INTAKE_SECRET
// Vars (wrangler.jsonc): INTAKE_URL, MAILBOX, MAX_PER_RUN, ONLY_FROM, ALLOWED_SENDERS, BACKFILL_SINCE,
//                        RETRY_BATCH, ALERT_EMAIL, ALERT_TO, APP_URL
// KV binding STATE keeps the poll position { uidValidity, lastUid }.
import { connect } from 'cloudflare:sockets';
import { type EmailEnv, handleInbound } from './email.ts';
import { pollOnce, type RelayEnv } from './relay.ts';
import { type AlertSender, runRetryQueue, type RetryEnv } from './retry.ts';
import { sendSmtp } from './smtp.ts';

const RETRY_CRON = '*/10 * * * *';

interface Env extends RelayEnv, EmailEnv, RetryEnv {
  STATE: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

function gmailSocket() {
  return connect({ hostname: 'imap.gmail.com', port: 993 }, { secureTransport: 'on', allowHalfOpen: false });
}

/** ALERT_EMAIL flag → sender. "smtp" uses Gmail submission (465, implicit TLS); anything else: off. */
function alertSender(env: Env): AlertSender | null {
  if ((env.ALERT_EMAIL ?? 'off').toLowerCase() !== 'smtp') return null;
  return {
    send: (mail) => sendSmtp(connect({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on', allowHalfOpen: false }),
      { user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD }, { from: env.GMAIL_USER, ...mail }),
  };
}

async function retryRun(env: Env) {
  const result = await runRetryQueue(env, alertSender(env));
  console.log(JSON.stringify({ mode: 'retry', ...result }));
  return result;
}

async function poll(env: Env) {
  const result = await pollOnce(env, gmailSocket, env.STATE);
  console.log(JSON.stringify({ mode: 'poll', relayed: result.relayed.length, failedUid: result.failedUid, lastUid: result.state.lastUid, note: result.note }));
  return result;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    const outcome = await handleInbound({ from: message.from, to: message.to, raw: message.raw }, env);
    if (outcome.kind === 'rejected_sender') message.setReject('Sender not allowed');
    // confirmation: the Gmail forwarding code/link appears in the Worker logs (one-time setup)
    console.log(JSON.stringify({ mode: 'push', size: message.rawSize, ...outcome }));
  },

  async scheduled(event: { cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(event.cron === RETRY_CRON ? retryRun(env) : poll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST' || req.headers.get('x-intake-secret') !== env.INTAKE_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    if (new URL(req.url).pathname === '/retry') return Response.json(await retryRun(env));
    const result = await poll(env);
    return Response.json({ relayed: result.relayed, failedUid: result.failedUid, lastUid: result.state.lastUid, note: result.note });
  },
};
