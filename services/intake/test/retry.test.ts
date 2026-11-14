// D39 retry cron: claim → reprocess each → escalate → one alert email each (mocked fetch, fake SMTP).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALERT_SUBJECT, type AlertMail, alertMail, type RetryEnv, runRetryQueue, type StuckRetry } from '../worker/retry.ts';
import { buildMessage, sendSmtp, SmtpError } from '../worker/smtp.ts';

const env: RetryEnv = {
  INTAKE_URL: 'https://x.supabase.co/functions/v1/intake',
  INTAKE_SECRET: 's3cret',
  GMAIL_USER: 'toyaminvestigation@gmail.com',
};
const stuck: StuckRetry = {
  email_id: 'e-2', from_address: 'rcu@insurer.example', subject: 'OD || 123', received_at: '2026-11-14T05:00:00Z',
  email_status: 'failed', retry_attempts: 2, retry_requested_at: '2026-11-14T05:10:00Z',
};

function intake(routes: { claim?: unknown; claimStatus?: number; retry?: (id: string) => [number, unknown]; alerts?: StuckRetry[]; escStatus?: number }) {
  const calls: { url: URL; secret: string | undefined; method: string | undefined }[] = [];
  const post = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, secret: (init.headers as Record<string, string>)['x-intake-secret'], method: init.method });
    const op = u.searchParams.get('op');
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (op === 'claim-retries') return reply(routes.claimStatus ?? 200, routes.claim ?? { items: [] });
    if (op === 'escalate-retries') return reply(routes.escStatus ?? 200, { alerts: routes.alerts ?? [] });
    const [status, body] = routes.retry?.(u.searchParams.get('retry')!) ?? [200, { result: 'review' }];
    return reply(status, body);
  }) as typeof fetch;
  return { post, calls };
}

const quiet = () => {};

describe('retry cron (runRetryQueue)', () => {
  it('claims, posts each email id with the secret, then escalates', async () => {
    const f = intake({
      claim: { items: [{ id: 'e-1', raw_storage_path: 'emails/a.eml' }, { id: 'e-2', raw_storage_path: 'emails/b.eml' }] },
      retry: (id) => (id === 'e-1' ? [200, { result: 'created' }] : [200, { result: 'failed' }]),
    });
    const r = await runRetryQueue({ ...env, RETRY_BATCH: '5' }, null, f.post, quiet);
    assert.deepEqual(f.calls.map((c) => c.url.search), ['?op=claim-retries&limit=5', '?retry=e-1', '?retry=e-2', '?op=escalate-retries']);
    assert.ok(f.calls.every((c) => c.secret === 's3cret' && c.method === 'POST'));
    assert.equal(r.claimed, 2);
    assert.deepEqual(r.outcomes, [{ id: 'e-1', status: 200, result: 'created' }, { id: 'e-2', status: 200, result: 'failed' }]);
  });

  it('sends one alert email per escalated email to the shared inbox', async () => {
    const sent: AlertMail[] = [];
    const f = intake({ alerts: [stuck, { ...stuck, email_id: 'e-3', email_status: 'retry_requested', retry_attempts: 0 }] });
    const r = await runRetryQueue(env, { send: async (m) => { sent.push(m); } }, f.post, quiet);
    assert.equal(r.alerts, 2);
    assert.equal(r.mailed, 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((m) => m.to === env.GMAIL_USER && m.subject === ALERT_SUBJECT));
    assert.match(sent[1].text, /still waiting for a retry after an hour/);
  });

  it('logs and skips the email when sending is off; in-app alerts already exist', async () => {
    const lines: string[] = [];
    const r = await runRetryQueue(env, null, intake({ alerts: [stuck] }).post, (l) => lines.push(l));
    assert.deepEqual([r.alerts, r.mailed, r.skipped], [1, 0, 1]);
    assert.match(lines[0], /"skipped":"ALERT_EMAIL off".*"email_id":"e-2"/);
  });

  it('a failing sender does not stop the run', async () => {
    const r = await runRetryQueue(env, { send: async () => { throw new Error('smtp down'); } },
      intake({ alerts: [stuck, stuck] }).post, quiet);
    assert.deepEqual([r.alerts, r.mailed, r.skipped], [2, 0, 2]);
  });

  it('still escalates when the claim fails', async () => {
    const f = intake({ claimStatus: 500, claim: { error: 'db down' }, alerts: [stuck] });
    const r = await runRetryQueue(env, null, f.post, quiet);
    assert.match(r.claimError ?? '', /claim 500: db down/);
    assert.equal(r.alerts, 1);
    assert.deepEqual(f.calls.map((c) => c.url.searchParams.get('op')), ['claim-retries', 'escalate-retries']);
  });

  it('records a reprocess that errors and goes on to the next email', async () => {
    const f = intake({
      claim: { items: [{ id: 'e-1', raw_storage_path: 'p' }, { id: 'e-2', raw_storage_path: 'p' }] },
      retry: (id) => (id === 'e-1' ? [500, { error: 'temporary' }] : [200, { result: 'review' }]),
    });
    const r = await runRetryQueue(env, null, f.post, quiet);
    assert.deepEqual(r.outcomes.map((o) => o.status), [500, 200]);
  });

  it('alert body carries sender, subject, received, attempts and the link only', () => {
    const m = alertMail(stuck, 'inbox@example.com', 'https://app.example.in/');
    assert.equal(m.subject, '[Toyam alert] Intake retry stuck');
    for (const s of ['rcu@insurer.example', 'OD || 123', '2026-11-14T05:00:00Z', 'Attempts: 2', 'https://app.example.in/intake/failed']) {
      assert.ok(m.text.includes(s), s);
    }
    assert.match(alertMail(stuck, 'x@y').text, /Open \/intake\/failed/);
  });
});

// ---- fake SMTP server ------------------------------------------------------
const enc = (s: string) => new TextEncoder().encode(s);
function fakeSmtp(opts: { authOk?: boolean } = {}) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const log: string[] = [];
  let data = '';
  let inData = false;
  let pending = '';
  const readable = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; c.enqueue(enc('220 smtp.gmail.com ESMTP ready\r\n')); } });
  const out = (s: string) => ctrl.enqueue(enc(s));
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      pending += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; out('250 2.0.0 OK queued\r\n'); } else data += line + '\r\n';
          continue;
        }
        log.push(/^AUTH/.test(line) ? 'AUTH ***' : line);
        if (/^EHLO/.test(line)) out('250-smtp.gmail.com at your service\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          const creds = atob(line.slice(11)).split('\0');
          out(opts.authOk !== false && creds[1] === 'me@gmail.com' && creds[2] === 'app-pass'
            ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Username and Password not accepted\r\n');
        } else if (/^(MAIL|RCPT)/.test(line)) out('250 2.1.0 OK\r\n');
        else if (line === 'DATA') { inData = true; out('354 Go ahead\r\n'); }
        else if (line === 'QUIT') { out('221 2.0.0 closing\r\n'); ctrl.close(); }
      }
    },
  });
  return { io: { readable, writable }, log, data: () => data };
}

describe('alert email over SMTP', () => {
  const mail = { from: 'me@gmail.com', to: 'me@gmail.com', subject: ALERT_SUBJECT, text: 'Sender: rcu@x\nबीमा' };

  it('submits one message with AUTH PLAIN', async () => {
    const s = fakeSmtp();
    await sendSmtp(s.io, { user: 'me@gmail.com', password: 'app-pass' }, mail);
    assert.deepEqual(s.log, ['EHLO toyam-intake', 'AUTH ***', 'MAIL FROM:<me@gmail.com>', 'RCPT TO:<me@gmail.com>', 'DATA', 'QUIT']);
    assert.match(s.data(), /^Subject: \[Toyam alert\] Intake retry stuck\r$/m);
    const body = s.data().split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))), mail.text);
  });

  it('fails on rejected credentials', async () => {
    const s = fakeSmtp({ authOk: false });
    await assert.rejects(sendSmtp(s.io, { user: 'me@gmail.com', password: 'wrong' }, mail), SmtpError);
  });

  it('builds headers without line breaks from the subject', () => {
    const m = buildMessage({ ...mail, subject: 'a\r\nBcc: x@y' }, new Date('2026-11-14T00:00:00Z'), 'id1');
    assert.match(m, /^Subject: a Bcc: x@y\r$/m);
    assert.match(m, /^Message-ID: <id1@gmail.com>\r$/m);
  });
});
