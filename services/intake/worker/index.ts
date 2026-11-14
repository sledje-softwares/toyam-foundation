// Cloudflare Worker for email intake.
//
//   email()      PUSH (D33): Gmail filter auto-forwards insurer mail to an Email Routing address
//                (e.g. intake@in.toyaminvestigation.in) routed to this Worker. Runs only when mail
//                arrives and relays the raw message to the Supabase `intake` function.
//   scheduled()  SAFETY NET: hourly IMAP poll of the shared inbox (insurer senders only) for
//                anything forwarding missed. Idempotent downstream (Message-ID).
//   fetch()      Manual poll for testing: POST / with header x-intake-secret.
//
// Secrets (wrangler secret put): GMAIL_USER, GMAIL_APP_PASSWORD, INTAKE_SECRET
// Vars (wrangler.jsonc): INTAKE_URL, MAILBOX, MAX_PER_RUN, ONLY_FROM, ALLOWED_SENDERS, BACKFILL_SINCE
// KV binding STATE keeps the poll position { uidValidity, lastUid }.
import { connect } from 'cloudflare:sockets';
import { type EmailEnv, handleInbound } from './email.ts';
import { pollOnce, type RelayEnv } from './relay.ts';

interface Env extends RelayEnv, EmailEnv {
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

  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(poll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST' || req.headers.get('x-intake-secret') !== env.INTAKE_SECRET) {
      return new Response('Not found', { status: 404 });
    }
    const result = await poll(env);
    return Response.json({ relayed: result.relayed, failedUid: result.failedUid, lastUid: result.state.lastUid, note: result.note });
  },
};
