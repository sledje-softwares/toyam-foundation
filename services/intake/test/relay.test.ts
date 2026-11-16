// Gmail relay against a scripted fake Gmail IMAP server (no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ImapClient, ImapError } from '../worker/imap.ts';
import { pollOnce, type RelayEnv, type StateStore } from '../worker/relay.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const raw = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

interface Msg { uid: number; raw: Uint8Array; thrid: string; msgid: string }

function fakeGmail(mailbox: { uidValidity: number; uidNext: number; messages: Msg[]; password?: string }) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const log: string[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; c.enqueue(enc('* OK Gimap ready for requests\r\n')); },
  });
  const out = (s: string | Uint8Array) => ctrl.enqueue(typeof s === 'string' ? enc(s) : s);
  let pending = '';
  const handle = (line: string) => {
    const [tag, ...rest] = line.split(' ');
    const cmd = rest.join(' ');
    log.push(/^LOGIN/i.test(cmd) ? 'LOGIN ***' : cmd);
    if (/^LOGIN/i.test(cmd)) {
      const pw = /^LOGIN "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)"$/i.exec(cmd)?.[1]?.replace(/\\(.)/g, '$1');
      out(pw === (mailbox.password ?? 'app-pass') ? `${tag} OK user authenticated (Success)\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    } else if (/^SELECT/i.test(cmd)) {
      out(`* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n* ${mailbox.messages.length} EXISTS\r\n`);
      out(`* OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid.\r\n* OK [UIDNEXT ${mailbox.uidNext}] Predicted next UID.\r\n`);
      out(`${tag} OK [READ-WRITE] INBOX selected. (Success)\r\n`);
    } else if (/^UID SEARCH UID (\d+):\*/i.test(cmd)) {
      const from = parseInt(/UID (\d+):/.exec(cmd)![1], 10);
      let uids = mailbox.messages.map((m) => m.uid).filter((u) => u >= from);
      if (uids.length === 0 && mailbox.messages.length) uids = [Math.max(...mailbox.messages.map((m) => m.uid))]; // n:* semantics
      out(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH completed (Success)\r\n`);
    } else if (/^UID SEARCH SINCE/i.test(cmd)) {
      out(`* SEARCH ${mailbox.messages.map((m) => m.uid).join(' ')}\r\n${tag} OK SEARCH completed (Success)\r\n`);
    } else if (/^UID FETCH (\d+)/i.test(cmd)) {
      const uid = parseInt(/^UID FETCH (\d+)/i.exec(cmd)![1], 10);
      const m = mailbox.messages.find((x) => x.uid === uid);
      if (m) {
        const seq = mailbox.messages.indexOf(m) + 1;
        out(`* ${seq} FETCH (X-GM-THRID ${m.thrid} X-GM-MSGID ${m.msgid} UID ${m.uid} BODY[] {${m.raw.length}}\r\n`);
        out(m.raw);
        out(')\r\n');
      }
      out(`${tag} OK Success\r\n`);
    } else if (/^LOGOUT/i.test(cmd)) {
      out('* BYE LOGOUT Requested\r\n');
      out(`${tag} OK 73 good day (Success)\r\n`);
    } else {
      out(`${tag} BAD Unknown command\r\n`);
    }
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      pending += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        handle(line);
      }
    },
  });
  return { open: () => ({ readable, writable, close: () => { try { ctrl.close(); } catch { /* closed */ } } }), log };
}

function memoryStore(init?: Record<string, string>): StateStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init ?? {}));
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => { data.set(k, v); } };
}

function recorder(failFirst = 0) {
  const calls: { headers: Record<string, string>; body: Uint8Array }[] = [];
  let fails = failFirst;
  const post = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    if (fails > 0) { fails--; return new Response('busy', { status: 500 }); }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { post, calls };
}

const env: RelayEnv = { GMAIL_USER: 'toyam@example.com', GMAIL_APP_PASSWORD: 'app-pass', INTAKE_URL: 'https://x/functions/v1/intake', INTAKE_SECRET: 's3cret' };
const STATE = 'gmail-relay-state';
const m1: Msg = { uid: 101, raw: raw('igi-new-od.eml'), thrid: '1879908795976617680', msgid: '1879908795976617681' };
const m2: Msg = { uid: 104, raw: raw('icl-new-od.eml'), thrid: '1880000000000000001', msgid: '1880000000000000002' };

describe('IMAP client', () => {
  it('logs in, selects and fetches a message with Gmail ids, without marking it seen', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] });
    const c = new ImapClient(g.open());
    await c.greeting();
    await c.login('u', 'app-pass');
    assert.deepEqual(await c.select('INBOX'), { uidValidity: 7, uidNext: 105, exists: 2 });
    const f = await c.fetchMessage(104);
    assert.ok(f);
    assert.equal(f.gmailThreadId, '1880000000000000001');
    assert.equal(f.gmailMessageId, '1880000000000000002');
    assert.deepEqual(f.raw, m2.raw);
    assert.ok(g.log.some((l) => /BODY\.PEEK\[\]/.test(l)));
    await c.logout();
  });
  // Server output pre-scripted for the deterministic tags A0001 (LOGIN), A0002 (FETCH), split into
  // fixed-size chunks so lines, CRLFs and literals straddle chunk boundaries.
  function chunkedServer(message: Uint8Array, chunk: number) {
    const head = enc(`* OK Gimap ready\r\nA0001 OK authenticated\r\n* 1 FETCH (X-GM-THRID 11 X-GM-MSGID 12 UID 9 BODY[] {${message.length}}\r\n`);
    const tail = enc(')\r\nA0002 OK Success\r\n');
    const all = new Uint8Array(head.length + message.length + tail.length);
    all.set(head); all.set(message, head.length); all.set(tail, head.length + message.length);
    let pos = 0;
    let reads = 0;
    const readable = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pos >= all.length) { c.close(); return; }
        c.enqueue(all.slice(pos, pos + chunk)); pos += chunk; reads++;
      },
    });
    const writable = new WritableStream<Uint8Array>({ write() { /* commands ignored */ } });
    return { io: { readable, writable }, reads: () => reads };
  }
  it('reassembles lines and literals split across 1-byte chunks', async () => {
    const s = chunkedServer(m1.raw, 1);
    const c = new ImapClient(s.io);
    await c.greeting();
    await c.login('u', 'app-pass');
    const f = await c.fetchMessage(9);
    assert.ok(f);
    assert.deepEqual(f.raw, m1.raw);
    assert.equal(f.gmailThreadId, '11');
  });
  it('reads a 15 MB message in 16 KB chunks in linear time', async () => {
    const big = new Uint8Array(15 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 78 === 76 ? 13 : i % 78 === 77 ? 10 : 65 + (i % 26);
    const s = chunkedServer(big, 16 * 1024);
    const c = new ImapClient(s.io);
    await c.greeting();
    await c.login('u', 'app-pass');
    const t0 = performance.now();
    const f = await c.fetchMessage(9);
    const ms = performance.now() - t0;
    assert.ok(f);
    assert.equal(f.raw.length, big.length);
    assert.deepEqual(f.raw.subarray(big.length - 100), big.subarray(big.length - 100));
    assert.ok(s.reads() > 900);
    assert.ok(ms < 400, `fetch took ${ms.toFixed(0)} ms`);   // linear: ~40 ms; the old copy-everything buffer took ~1.1 s
  });
  it('quotes passwords and does not leak them in errors', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 1, messages: [], password: 'p"a\\ss' });
    const c = new ImapClient(g.open());
    await c.greeting();
    await c.login('u', 'p"a\\ss');
    const g2 = fakeGmail({ uidValidity: 7, uidNext: 1, messages: [] });
    const c2 = new ImapClient(g2.open());
    await c2.greeting();
    await assert.rejects(c2.login('u', 'wrong-secret'), (e: Error) => e instanceof ImapError && !e.message.includes('wrong-secret'));
  });
});

describe('relay run', () => {
  it('first run starts from now without relaying history', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] });
    const store = memoryStore();
    const r = recorder();
    const res = await pollOnce(env, g.open, store, r.post);
    assert.deepEqual(res.relayed, []);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(JSON.parse(store.data.get(STATE)!), { uidValidity: 7, lastUid: 104 });
  });
  it('relays new messages in order with the secret and Gmail headers', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] });
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 7, lastUid: 100 }) });
    const r = recorder();
    const res = await pollOnce(env, g.open, store, r.post);
    assert.deepEqual(res.relayed, [101, 104]);
    assert.equal(r.calls[0].headers['x-intake-secret'], 's3cret');
    assert.equal(r.calls[0].headers['x-gmail-thread-id'], '1879908795976617680');
    assert.deepEqual(r.calls[1].body, m2.raw);
    assert.equal(JSON.parse(store.data.get(STATE)!).lastUid, 104);
  });
  it('nothing new: the highest UID returned by "n:*" is not re-sent', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] });
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 7, lastUid: 104 }) });
    const r = recorder();
    assert.deepEqual((await pollOnce(env, g.open, store, r.post)).relayed, []);
    assert.equal(r.calls.length, 0);
  });
  it('a failed post stops the run and is retried next time', async () => {
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 7, lastUid: 100 }) });
    const r = recorder(1);
    const first = await pollOnce(env, fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] }).open, store, r.post);
    assert.equal(first.failedUid, 101);
    assert.equal(JSON.parse(store.data.get(STATE)!).lastUid, 100);
    const second = await pollOnce(env, fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] }).open, store, r.post);
    assert.deepEqual(second.relayed, [101, 104]);
  });
  it('respects MAX_PER_RUN', async () => {
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 7, lastUid: 100 }) });
    const res = await pollOnce({ ...env, MAX_PER_RUN: '1' }, fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] }).open, store, recorder().post);
    assert.deepEqual(res.relayed, [101]);
  });
  it('a new UIDVALIDITY restarts from now', async () => {
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 6, lastUid: 50 }) });
    const r = recorder();
    const res = await pollOnce(env, fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] }).open, store, r.post);
    assert.equal(res.note, 'UIDVALIDITY changed: restarted');
    assert.equal(r.calls.length, 0);
    assert.deepEqual(res.state, { uidValidity: 7, lastUid: 104 });
  });
  it('ONLY_FROM is sent to Gmail as an IMAP search filter', async () => {
    const g = fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] });
    const store = memoryStore({ [STATE]: JSON.stringify({ uidValidity: 7, lastUid: 100 }) });
    await pollOnce({ ...env, ONLY_FROM: 'indusindinsurance.com,icicilombard.com' }, g.open, store, recorder().post);
    assert.ok(g.log.includes('UID SEARCH UID 101:* OR FROM "indusindinsurance.com" FROM "icicilombard.com"'), g.log.join(' | '));
  });
  it('BACKFILL_SINCE relays existing mail on the first run', async () => {
    const r = recorder();
    const res = await pollOnce({ ...env, BACKFILL_SINCE: '01-Nov-2026' }, fakeGmail({ uidValidity: 7, uidNext: 105, messages: [m1, m2] }).open, memoryStore(), r.post);
    assert.deepEqual(res.relayed, [101, 104]);
  });
});
