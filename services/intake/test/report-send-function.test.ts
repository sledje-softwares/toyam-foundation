// report-send edge function (8.2, D50): configuration / test-mode switch, the outgoing envelope, and the
// claim → files → SMTP → complete / fail flow against a fake gateway and a scripted SMTP server.
// No real mail is sent anywhere.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import PostalMime from 'postal-mime';
import type { Duplex } from '../../../supabase/functions/_shared/send/smtp.ts';
import {
  buildEnvelope, type ClaimedSend, readSendConfig, secretMatches, sha256Hex, type SendConfig,
} from '../../../supabase/functions/_shared/report-send/logic.ts';
import {
  type Gateway, handleReportSend, type Mailer, processSend, sweep,
} from '../../../supabase/functions/_shared/report-send/handler.ts';
import { runSendSweep } from '../worker/send-sweep.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const SEND = '6f000000-0000-4000-8000-000000000001';
const REPORT = '5f000000-0000-4000-8000-000000000001';
const TEST_TO = 'dev@example.com';

const env = (o: Record<string, string>) => (k: string) => o[k];
const SMTP = { SMTP_USER: 'firm@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop' };

function cfg(mode: 'test' | 'live', extra: Partial<SendConfig> = {}): SendConfig {
  const r = readSendConfig(env({ ...SMTP, SEND_MODE: mode, ...(mode === 'test' ? { SEND_TEST_TO: TEST_TO } : {}), SEND_SECRET: 's3cret' }));
  assert.ok(r.ok);
  return { ...r.config, ...extra };
}

const claimed: ClaimedSend = {
  id: SEND, case_id: '3f000000-0000-4000-8000-000000000001', report_id: REPORT, formats: ['pdf', 'docx'],
  to_addresses: ['claims@insurer.example'], cc_addresses: ['boss@insurer.example', 'firm@gmail.com'],
  subject: 'Re: OD Investigation Case No - MOT1', body: 'Dear Sir,\nPlease find the report attached.\nRegards',
  attachment_name: 'IR_MOT1', in_reply_to: '<ins-1@insurer.example>', references_ids: ['<root@insurer.example>', '<ins-1@insurer.example>'],
  message_id: '<first@gmail.com>', case_ref: 'INV-2026-000001',
};

describe('configuration and the test-mode switch', () => {
  it('test mode is the default and needs SEND_TEST_TO', () => {
    const r = readSendConfig(env({ ...SMTP, SEND_TEST_TO: ' Dev@Example.com ' }));
    assert.ok(r.ok);
    assert.equal(r.config.mode, 'test');
    assert.equal(r.config.testTo, 'dev@example.com');
    assert.equal(r.config.smtpPassword, 'abcdefghijklmnop', 'spaces of a Gmail app password are dropped');
    const missing = readSendConfig(env(SMTP));
    assert.equal(missing.ok, false);
    assert.match((missing as { problem: string }).problem, /SEND_TEST_TO/);
  });
  it('refuses live mode with a leftover SEND_TEST_TO', () => {
    const r = readSendConfig(env({ ...SMTP, SEND_MODE: 'live', SEND_TEST_TO: TEST_TO }));
    assert.equal(r.ok, false);
  });
  it('live mode without a test address', () => {
    const r = readSendConfig(env({ ...SMTP, SEND_MODE: 'LIVE' }));
    assert.ok(r.ok);
    assert.equal(r.config.mode, 'live');
    assert.equal(r.config.testTo, null);
  });
  it('refuses an unknown mode, a bad test address, several test addresses, and missing SMTP credentials', () => {
    assert.equal(readSendConfig(env({ ...SMTP, SEND_MODE: 'prod', SEND_TEST_TO: TEST_TO })).ok, false);
    assert.equal(readSendConfig(env({ ...SMTP, SEND_TEST_TO: 'not an address' })).ok, false);
    assert.equal(readSendConfig(env({ ...SMTP, SEND_TEST_TO: 'a@x.co, b@y.co' })).ok, false);
    assert.equal(readSendConfig(env({ SEND_TEST_TO: TEST_TO })).ok, false);
  });
  it('sweep secret: constant-time compare, empty never matches', () => {
    assert.ok(secretMatches('s3cret', 's3cret'));
    assert.ok(!secretMatches('s3cre', 's3cret'));
    assert.ok(!secretMatches('', ''));
  });
});

describe('outgoing envelope', () => {
  it('test mode: only the test address, [TEST] subject, real recipients listed in the body, reply headers kept', async () => {
    const e = buildEnvelope(cfg('test'), claimed, []);
    assert.deepEqual(e.rcpt, [TEST_TO]);
    const m = await PostalMime.parse(await import('../../../supabase/functions/_shared/send/mime.ts').then((x) => x.buildMime(e.mail)));
    assert.deepEqual(m.to?.map((a) => a.address), [TEST_TO]);
    assert.equal(m.cc, undefined);
    assert.equal(m.subject, '[TEST] Re: OD Investigation Case No - MOT1');
    assert.match(m.text ?? '', /^TEST SEND - this message was NOT sent to the insurer\.\nCase: INV-2026-000001\nWould go to: claims@insurer\.example\nCc: boss@insurer\.example, firm@gmail\.com/);
    assert.match(m.text ?? '', /Please find the report attached\./);
    assert.equal(m.inReplyTo, '<ins-1@insurer.example>');
  });
  it('live mode: To and Cc as stored; RCPT is both, without duplicates', () => {
    const e = buildEnvelope(cfg('live'), { ...claimed, cc_addresses: ['boss@insurer.example', 'Claims@insurer.example'] }, []);
    assert.deepEqual(e.mail.to, ['claims@insurer.example']);
    assert.deepEqual(e.rcpt, ['claims@insurer.example', 'boss@insurer.example']);
    assert.equal(e.mail.subject, claimed.subject);
    assert.equal(e.mail.text, claimed.body);
  });
});

/** A scripted SMTP server on the other end of a duplex (same protocol subset as the shared SMTP tests). */
function fakeSmtp(o: { rcptFail?: string; dropAfterData?: boolean; dataCode?: number; authFail?: boolean } = {}) {
  const log: string[] = [];
  const messages: string[] = [];
  let inData = false;
  let buf = '';
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const out = new ReadableStream<Uint8Array>({ start(c) { ctl = c; c.enqueue(bytes('220 ready\r\n')); } });
  const say = (s: string) => ctl.enqueue(bytes(s + '\r\n'));
  const inbound = new WritableStream<Uint8Array>({
    write(chunk) {
      buf += new TextDecoder().decode(chunk);
      for (;;) {
        if (inData) {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          messages.push(buf.slice(0, i));
          buf = buf.slice(i + 5);
          inData = false;
          if (o.dropAfterData) { ctl.close(); return; }
          say(`${o.dataCode ?? 250} 2.0.0 OK queued`);
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line.replace(/^AUTH PLAIN .*/, 'AUTH PLAIN ***'));
        if (line.startsWith('EHLO')) say('250-smtp.example\r\n250 AUTH PLAIN');
        else if (line.startsWith('AUTH')) say(o.authFail ? '535 5.7.8 Username and Password not accepted' : '235 ok');
        else if (line.startsWith('MAIL')) say('250 ok');
        else if (line.startsWith('RCPT')) say(o.rcptFail && line.includes(o.rcptFail) ? '550 no such user' : '250 ok');
        else if (line === 'DATA') { say('354 go'); inData = true; }
        else if (line === 'QUIT') { say('221 bye'); }
      }
    },
  });
  const io: Duplex = { readable: out, writable: inbound };
  let opened = 0;
  const mailer: Mailer = { async open() { opened++; return io; } };
  return { mailer, log, messages, opened: () => opened, rcpt: () => log.filter((l) => l.startsWith('RCPT')) };
}

const PDF = bytes('%PDF-1.7 fake report');
const DOCX = bytes('PK fake docx');

async function fileRows(over: { pdfSha?: string | null; pdfSize?: number | null } = {}) {
  return [
    { format: 'pdf', storage_path: `${claimed.case_id}/${REPORT}/report.pdf`, sha256: over.pdfSha === undefined ? await sha256Hex(PDF) : over.pdfSha, size_bytes: over.pdfSize === undefined ? PDF.length : over.pdfSize },
    { format: 'docx', storage_path: `${claimed.case_id}/${REPORT}/report.docx`, sha256: await sha256Hex(DOCX), size_bytes: DOCX.length },
  ];
}

type Call = { fn: string; args: unknown[] };
function fakeGateway(o: {
  claim?: unknown[]; files?: Awaited<ReturnType<typeof fileRows>>; objects?: Record<string, Uint8Array>;
  completeErrors?: number; settings?: Record<string, string>; visible?: Awaited<ReturnType<Gateway['visibleSend']>>;
  staff?: Awaited<ReturnType<Gateway['isStaff']>>; pending?: { id: string; status: string; claimed_at: string | null }[];
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let completeErrors = o.completeErrors ?? 0;
  const gw: Gateway = {
    async visibleSend(jwt, id) { calls.push({ fn: 'visibleSend', args: [jwt, id] }); return o.visible === undefined ? { status: 'queued' } : o.visible; },
    async isStaff(jwt) { calls.push({ fn: 'isStaff', args: [jwt] }); return o.staff ?? true; },
    async pendingSends(limit) { calls.push({ fn: 'pendingSends', args: [limit] }); return o.pending ?? []; },
    async setting(key) { return o.settings?.[key] ?? null; },
    async claim(id, messageId, testRecipient) {
      calls.push({ fn: 'claim', args: [id, messageId, testRecipient] });
      return { data: o.claim ?? [claimed], error: null };
    },
    async reportFiles(reportId) { calls.push({ fn: 'reportFiles', args: [reportId] }); return o.files ?? null; },
    async download(path) { return o.objects?.[path] ?? null; },
    async complete(id, delivery) {
      calls.push({ fn: 'complete', args: [id, delivery] });
      if (completeErrors > 0) { completeErrors--; return { error: { code: '08006', message: 'connection lost' } }; }
      return { error: null };
    },
    async fail(id, error, ambiguous) { calls.push({ fn: 'fail', args: [id, error, ambiguous] }); return { error: null }; },
    log(msg) { logs.push(msg); },
  };
  const of = (fn: string) => calls.filter((c) => c.fn === fn);
  return { gw, calls, logs, of };
}

async function standard(over: Parameters<typeof fakeGateway>[0] = {}) {
  const files = await fileRows();
  return fakeGateway({ files, objects: { [files[0].storage_path]: PDF, [files[1].storage_path]: DOCX }, ...over });
}

describe('processSend', () => {
  it('test mode: claims with the test address, mails only the test address with both files, completes', async () => {
    const g = await standard();
    const s = fakeSmtp();
    const out = await processSend(SEND, cfg('test'), { gw: g.gw, mailer: s.mailer, newId: () => 'fixed-id' });
    assert.equal(out, 'test_sent');
    assert.deepEqual(g.of('claim')[0].args, [SEND, '<fixed-id@gmail.com>', TEST_TO]);
    assert.deepEqual(s.rcpt(), [`RCPT TO:<${TEST_TO}>`]);
    assert.equal(s.messages.length, 1);
    const m = await PostalMime.parse(s.messages[0]);
    assert.deepEqual(m.to?.map((a) => a.address), [TEST_TO]);
    assert.ok(!/insurer\.example/.test(s.messages[0].split('\r\n\r\n')[0].replace(/^(In-Reply-To|References):.*$/gim, '')),
      'no insurer address in the headers apart from the reply ids');
    assert.equal(m.messageId, '<first@gmail.com>', 'the Message-ID fixed by the database is used');
    assert.deepEqual(m.attachments.map((a) => a.filename), ['IR_MOT1.pdf', 'IR_MOT1.docx']);
    assert.deepEqual(new Uint8Array(m.attachments[0].content as ArrayBuffer), PDF);
    assert.deepEqual(g.of('complete').map((c) => c.args), [[SEND, 'attached']]);
    assert.equal(g.of('fail').length, 0);
    assert.ok(s.log.includes('AUTH PLAIN ***'));
    assert.ok(!g.logs.join('\n').includes('abcdefghijklmnop'), 'the app password is never logged');
  });

  it('live mode: claims without a test address and mails To + Cc', async () => {
    const g = await standard();
    const s = fakeSmtp();
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'sent');
    assert.equal(g.of('claim')[0].args[2], null);
    assert.deepEqual(s.rcpt(), ['RCPT TO:<claims@insurer.example>', 'RCPT TO:<boss@insurer.example>', 'RCPT TO:<firm@gmail.com>']);
    const m = await PostalMime.parse(s.messages[0]);
    assert.equal(m.subject, claimed.subject);
    assert.equal(m.inReplyTo, '<ins-1@insurer.example>');
    assert.equal(m.references, '<root@insurer.example> <ins-1@insurer.example>');
  });

  it('nothing to claim: no connection is opened', async () => {
    const g = await standard({ claim: [] });
    const s = fakeSmtp();
    assert.equal(await processSend(SEND, cfg('test'), { gw: g.gw, mailer: s.mailer }), 'skipped');
    assert.equal(s.opened(), 0);
    assert.equal(g.of('fail').length + g.of('complete').length, 0);
  });

  it('a file that does not match its SHA-256 fails the send before connecting', async () => {
    const files = await fileRows({ pdfSha: 'ab'.repeat(32) });
    const g = fakeGateway({ files, objects: { [files[0].storage_path]: PDF, [files[1].storage_path]: DOCX } });
    const s = fakeSmtp();
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'failed');
    assert.equal(s.opened(), 0);
    const [args] = g.of('fail').map((c) => c.args);
    assert.match(String(args[1]), /PDF file .* does not match its recorded SHA-256/);
    assert.equal(args[2], false);
  });

  it('a file with no recorded hash, a missing object or a missing format fails cleanly', async () => {
    for (const g of [
      await (async () => { const f = await fileRows({ pdfSha: null }); return fakeGateway({ files: f, objects: { [f[0].storage_path]: PDF, [f[1].storage_path]: DOCX } }); })(),
      await (async () => { const f = await fileRows(); return fakeGateway({ files: f, objects: { [f[1].storage_path]: DOCX } }); })(),
      await (async () => { const f = await fileRows(); return fakeGateway({ files: [f[0]], objects: { [f[0].storage_path]: PDF } }); })(),
    ]) {
      const s = fakeSmtp();
      assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'failed');
      assert.equal(s.opened(), 0);
      assert.equal(g.of('fail')[0].args[2], false);
    }
  });

  it('report files over send_attach_max_mb are not sent (secure links are 8.3)', async () => {
    const g = await standard({ settings: { send_attach_max_mb: '0.00001' } });
    const s = fakeSmtp();
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'failed');
    assert.equal(s.opened(), 0);
    assert.match(String(g.of('fail')[0].args[1]), /more than the .* MB that can be attached/);
  });

  it('a connection that cannot be opened is failed (nothing left)', async () => {
    const g = await standard();
    const mailer: Mailer = { async open() { throw new Error('connect timeout'); } };
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer }), 'failed');
    assert.deepEqual(g.of('fail')[0].args.slice(2), [false]);
  });

  it('a refusal before the body (auth, recipient) is failed, may be retried', async () => {
    for (const s of [fakeSmtp({ authFail: true }), fakeSmtp({ rcptFail: 'boss@' })]) {
      const g = await standard();
      assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'failed');
      assert.equal(g.of('fail')[0].args[2], false);
      assert.equal(s.messages.length, 0);
      assert.equal(g.of('complete').length, 0);
    }
  });

  it('a body the server rejects (5xx after DATA) is failed', async () => {
    const g = await standard();
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: fakeSmtp({ dataCode: 552 }).mailer }), 'failed');
    assert.equal(g.of('fail')[0].args[2], false);
  });

  it('a connection lost after the body was handed over is unknown, never resent', async () => {
    const g = await standard();
    const s = fakeSmtp({ dropAfterData: true });
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'unknown');
    assert.equal(g.of('fail')[0].args[2], true, 'ambiguous');
    assert.equal(s.messages.length, 1);
    assert.equal(g.of('complete').length, 0);
  });

  it('accepted but the database does not answer: complete is repeated, never the mail; then left for the lease', async () => {
    const g = await standard({ completeErrors: 5 });
    const s = fakeSmtp();
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: s.mailer }), 'unknown');
    assert.equal(s.messages.length, 1, 'mailed once');
    assert.equal(g.of('complete').length, 3);
    assert.equal(g.of('fail').length, 0, 'not marked failed: the mail went out');
    assert.ok(g.logs.some((l) => l.includes('MAIL ACCEPTED BUT NOT RECORDED')));
  });

  it('a transient complete error is retried and recorded', async () => {
    const g = await standard({ completeErrors: 1 });
    assert.equal(await processSend(SEND, cfg('live'), { gw: g.gw, mailer: fakeSmtp().mailer }), 'sent');
    assert.equal(g.of('complete').length, 2);
  });
});

describe('handleReportSend', () => {
  const post = (body: unknown, h: { authorization?: string; sendSecret?: string } = {}) => ({
    method: 'POST', authorization: h.authorization ?? null, sendSecret: h.sendSecret ?? null, body: JSON.stringify(body),
  });
  const user = { authorization: 'Bearer user.jwt' };

  it('send: checks the caller sees a queued row, answers 202 and delivers in the background', async () => {
    const g = await standard();
    const s = fakeSmtp();
    const deferred: Promise<unknown>[] = [];
    const r = await handleReportSend(post({ action: 'send', id: SEND }, user), { ok: true, config: cfg('test') }, { gw: g.gw, mailer: s.mailer },
      (p) => deferred.push(p));
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { ok: true, accepted: true, mode: 'test', test_to: TEST_TO });
    assert.deepEqual(g.of('visibleSend')[0].args, ['user.jwt', SEND]);
    assert.equal(deferred.length, 1);
    assert.equal(await deferred[0], 'test_sent');
    assert.deepEqual(s.rcpt(), [`RCPT TO:<${TEST_TO}>`]);
  });

  it('send: no token 401, not visible 404, not queued 409, bad id 400, GET 405', async () => {
    const c = { ok: true as const, config: cfg('test') };
    const none = () => assert.fail('nothing may be deferred');
    const g = await standard();
    assert.equal((await handleReportSend(post({ action: 'send', id: SEND }), c, { gw: g.gw, mailer: fakeSmtp().mailer }, none)).status, 401);
    assert.equal((await handleReportSend(post({ action: 'send', id: SEND }, user), c, { gw: (await standard({ visible: null })).gw, mailer: fakeSmtp().mailer }, none)).status, 404);
    assert.equal((await handleReportSend(post({ action: 'send', id: SEND }, user), c, { gw: (await standard({ visible: 'unauthorized' })).gw, mailer: fakeSmtp().mailer }, none)).status, 401);
    const busy = await handleReportSend(post({ action: 'send', id: SEND }, user), c, { gw: (await standard({ visible: { status: 'sending' } })).gw, mailer: fakeSmtp().mailer }, none);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.status, 'sending');
    assert.equal((await handleReportSend(post({ action: 'send', id: 'x' }, user), c, { gw: g.gw, mailer: fakeSmtp().mailer }, none)).status, 400);
    assert.equal((await handleReportSend({ ...post({}), method: 'GET' }, c, { gw: g.gw, mailer: fakeSmtp().mailer }, none)).status, 405);
    assert.equal(g.of('claim').length, 0);
  });

  it('refuses to start when the configuration is inconsistent: nothing is claimed', async () => {
    const bad = readSendConfig(env({ ...SMTP, SEND_MODE: 'live', SEND_TEST_TO: TEST_TO }));
    const g = await standard();
    const r = await handleReportSend(post({ action: 'send', id: SEND }, user), bad, { gw: g.gw, mailer: fakeSmtp().mailer }, () => assert.fail());
    assert.equal(r.status, 503);
    assert.equal((r.body.error as { code: string }).code, 'not_configured');
    const sw = await handleReportSend(post({ action: 'sweep' }, { sendSecret: 's3cret' }), bad, { gw: g.gw, mailer: fakeSmtp().mailer }, () => assert.fail());
    assert.equal(sw.status, 503);
    assert.equal(g.of('claim').length + g.of('pendingSends').length, 0);
    const mode = await handleReportSend(post({ action: 'mode' }, user), bad, { gw: g.gw, mailer: fakeSmtp().mailer }, () => assert.fail());
    assert.deepEqual(mode.body, { ok: true, configured: false, mode: null, test_to: null });
  });

  it('mode: staff only', async () => {
    const c = { ok: true as const, config: cfg('live') };
    assert.deepEqual((await handleReportSend(post({ action: 'mode' }, user), c, { gw: (await standard()).gw, mailer: fakeSmtp().mailer }, () => {})).body,
      { ok: true, configured: true, mode: 'live', test_to: null });
    assert.equal((await handleReportSend(post({ action: 'mode' }, user), c, { gw: (await standard({ staff: false })).gw, mailer: fakeSmtp().mailer }, () => {})).status, 403);
  });

  it('sweep: needs the secret; settles expired claims and sends queued ones up to the batch, oldest first', async () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const pending = [
      { id: 'q1', status: 'queued', claimed_at: null },
      { id: 'stale', status: 'sending', claimed_at: '2026-11-19T11:30:00Z' },
      { id: 'fresh', status: 'sending', claimed_at: '2026-11-19T11:58:00Z' },
      { id: 'q2', status: 'queued', claimed_at: null },
      { id: 'q3', status: 'queued', claimed_at: null },
    ];
    const g = await standard({ pending, claim: [] });
    const c = { ok: true as const, config: cfg('live', { sweepBatch: 2 }) };
    assert.equal((await handleReportSend(post({ action: 'sweep' }, { sendSecret: 'wrong' }), c, { gw: g.gw, mailer: fakeSmtp().mailer }, () => {})).status, 401);
    assert.equal((await handleReportSend(post({ action: 'sweep' }), c, { gw: g.gw, mailer: fakeSmtp().mailer }, () => {})).status, 401);
    const results = await sweep(c.config, { gw: g.gw, mailer: fakeSmtp().mailer, now: () => now });
    assert.deepEqual(results?.map((r) => r.id), ['stale', 'q1', 'q2']);
    assert.deepEqual(g.of('claim').map((x) => x.args[0]), ['stale', 'q1', 'q2']);
    const r = await handleReportSend(post({ action: 'sweep' }, { sendSecret: 's3cret' }), c, { gw: g.gw, mailer: fakeSmtp().mailer }, () => {});
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'live');
  });
});

describe('Worker send sweep (cron */10)', () => {
  it('is off until REPORT_SEND_URL and SEND_SECRET are set', async () => {
    const never = (async () => assert.fail('no request')) as unknown as typeof fetch;
    assert.deepEqual(await runSendSweep({}, never), { ran: false });
    assert.deepEqual(await runSendSweep({ REPORT_SEND_URL: 'https://x.supabase.co/functions/v1/report-send' }, never), { ran: false });
  });
  it('posts the sweep with the secret header and reports the outcomes', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const post = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, mode: 'test', results: [{ id: 'a', outcome: 'test_sent' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runSendSweep({ REPORT_SEND_URL: 'https://x.supabase.co/functions/v1/report-send', SEND_SECRET: 'k' }, post);
    assert.deepEqual(r, { ran: true, status: 200, mode: 'test', results: [{ id: 'a', outcome: 'test_sent' }] });
    assert.equal((seen[0].init.headers as Record<string, string>)['x-send-secret'], 'k');
    assert.equal(seen[0].init.body, JSON.stringify({ action: 'sweep' }));
  });
  it('an error answer or a network error is reported, not thrown', async () => {
    const e503 = (async () => new Response(JSON.stringify({ ok: false, error: { code: 'not_configured' } }), { status: 503 })) as unknown as typeof fetch;
    assert.deepEqual(await runSendSweep({ REPORT_SEND_URL: 'https://x', SEND_SECRET: 'k' }, e503), { ran: true, status: 503, error: 'not_configured' });
    const down = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    assert.deepEqual(await runSendSweep({ REPORT_SEND_URL: 'https://x', SEND_SECRET: 'k' }, down), { ran: true, error: 'network down' });
  });
});
