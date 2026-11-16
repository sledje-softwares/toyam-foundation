// Push intake: email() handler logic (sender check, Gmail confirmation, relay) and the
// safety net's IMAP sender filter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { baseAddress, confirmationDetails, type EmailEnv, handleInbound } from '../worker/email.ts';
import { fromCriteria } from '../worker/relay.ts';

const env: EmailEnv = {
  INTAKE_URL: 'https://x/functions/v1/intake',
  INTAKE_SECRET: 's3cret',
  GMAIL_USER: 'toyaminvestigation@gmail.com',
};
const fixture = new Uint8Array(readFileSync(new URL('./fixtures/igi-new-od.eml', import.meta.url)));
const stream = (bytes: Uint8Array) => new Response(bytes as unknown as BodyInit).body as ReadableStream<Uint8Array>;

function recorder(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  const post = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { post, calls };
}

describe('push intake (email handler)', () => {
  it('strips the Gmail forwarding +tag from the envelope sender', () => {
    assert.equal(baseAddress('ToyamInvestigation+caf_=intake=in.toyaminvestigation.in@gmail.com'), 'toyaminvestigation@gmail.com');
    assert.equal(baseAddress('a@b.c'), 'a@b.c');
  });

  it('relays mail forwarded by the shared Gmail, unchanged, with the secret', async () => {
    const r = recorder();
    const out = await handleInbound(
      { from: 'toyaminvestigation+caf_=intake=in.toyaminvestigation.in@gmail.com', to: 'intake@in.toyaminvestigation.in', raw: stream(fixture) },
      env, r.post);
    assert.deepEqual(out, { kind: 'relayed', status: 200 });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].headers['x-intake-secret'], 's3cret');
    assert.equal(r.calls[0].headers['content-type'], 'message/rfc822');
    assert.deepEqual(r.calls[0].body, fixture);
  });

  it('rejects any other envelope sender (no direct mail into intake)', async () => {
    const r = recorder();
    const out = await handleInbound({ from: 'rcu@indusindinsurance.com', to: 'intake@in.toyaminvestigation.in', raw: fixture }, env, r.post);
    assert.deepEqual(out, { kind: 'rejected_sender', sender: 'rcu@indusindinsurance.com' });
    assert.equal(r.calls.length, 0);
  });

  it('accepts extra senders from ALLOWED_SENDERS', async () => {
    const r = recorder();
    const out = await handleInbound({ from: 'gi@toyaminvestigation.in', to: 'x', raw: fixture },
      { ...env, ALLOWED_SENDERS: 'gi@toyaminvestigation.in, other@example.com' }, r.post);
    assert.equal(out.kind, 'relayed');
  });

  it('does not bounce when the intake function fails (the safety net retries)', async () => {
    const out = await handleInbound({ from: env.GMAIL_USER, to: 'x', raw: fixture }, env, recorder(500).post);
    assert.deepEqual(out, { kind: 'failed', status: 500 });
    const thrown = await handleInbound({ from: env.GMAIL_USER, to: 'x', raw: fixture }, env,
      (async () => { throw new Error('network'); }) as unknown as typeof fetch);
    assert.deepEqual(thrown, { kind: 'failed', error: 'network' });
  });

  it('surfaces the Gmail forwarding confirmation code instead of relaying it', async () => {
    const mail = 'From: Gmail Team <forwarding-noreply@google.com>\r\nSubject: (#123456789) Gmail Forwarding Confirmation\r\n\r\n'
      + 'Confirmation code: 123456789\r\nTo allow toyaminvestigation@gmail.com to automatically forward mail, click the link below:\r\n'
      + 'https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc123\r\n';
    const r = recorder();
    const out = await handleInbound({ from: 'forwarding-noreply@google.com', to: 'intake@in.toyaminvestigation.in', raw: new TextEncoder().encode(mail) }, env, r.post);
    assert.deepEqual(out, { kind: 'confirmation', code: '123456789', link: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc123' });
    assert.equal(r.calls.length, 0);
  });

  it('reads the code from the subject and the link from a quoted-printable HTML body', () => {
    const mail = 'From: forwarding-noreply@google.com\r\nSubject: (#987654321) Gmail Forwarding Confirmation - Receive Mail from x@gmail.com\r\n'
      + 'Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n'
      + '<p>Confirmation code: <b>98765=\r\n4321</b></p><a href=3D"https://mail-settings.google.com/mail/vf-%5BAN=\r\nGjdJ%5D-abc">link</a>\r\n';
    assert.deepEqual(confirmationDetails(mail), { code: '987654321', link: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ%5D-abc' });
  });

  it('finds the code in a quoted-printable HTML body when the subject has none', () => {
    const body = 'Subject: Gmail Forwarding Confirmation\r\n\r\n<td>Confirmation code:</td><td><b>1234=\r\n56789</b></td>';
    assert.equal(confirmationDetails(body).code, '123456789');
  });

  it('confirmationDetails returns nulls on unrelated text', () => {
    assert.deepEqual(confirmationDetails('hello'), { code: null, link: null });
  });
});

describe('safety-net sender filter', () => {
  it('builds nested IMAP OR criteria', () => {
    assert.equal(fromCriteria(undefined), '');
    assert.equal(fromCriteria('a.com'), 'FROM "a.com"');
    assert.equal(fromCriteria('a.com, b.com,c.com'), 'OR FROM "a.com" OR FROM "b.com" FROM "c.com"');
    assert.equal(fromCriteria('x"y.com'), 'FROM "xy.com"');
  });
});
