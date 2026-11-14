// evidence-view edge function: validation, names and disposition, the rate limit, presigned GETs and
// the request flow against a fake gateway (the caller's JWT client). Lives here because this
// workspace runs the Node tests for supabase/functions/_shared.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canInline, contentDisposition, createRateLimit, isR2EvidenceKey, isStoragePath, keyExt, MAX_IDS, parseRequest,
  publicStorageUrl, readViewR2Config, safeFileName, serveType,
} from '../../../supabase/functions/_shared/evidence-view/logic.ts';
import {
  type AttachmentRow, type EvidenceRow, type Gateway, handleEvidenceView, MAX_BODY_CHARS,
} from '../../../supabase/functions/_shared/evidence-view/handler.ts';
import { evidenceKey, presignEvidenceGet, presignEvidencePut } from '../../../supabase/functions/_shared/r2/presign.ts';

const CASE = '3e500000-0000-4000-8000-000000000001';
const TASK = '3e600000-0000-4000-8000-000000000001';
const E1 = '3e700000-0000-4000-8000-000000000001';
const E2 = '3e700000-0000-4000-8000-000000000002';
const E3 = '3e700000-0000-4000-8000-000000000003';
const A1 = '3e800000-0000-4000-8000-000000000001';
const SHA = 'a1'.repeat(32);
const R2 = { accountId: 'acct', bucket: 'evidence', accessKeyId: 'AKID', secretAccessKey: 'TOPSECRETVALUE' };
const NOW = new Date('2026-11-15T12:00:00Z');

const r2Row = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: E1, evidence_type: 'photo', storage_backend: 'r2', storage_path: evidenceKey(CASE, TASK, SHA, 'jpg'),
  mime_type: 'image/jpeg', original_filename: 'IMG_0001.jpg', cloud_purged_at: null, ...over,
});

function fakeGateway(opts: { evidence?: EvidenceRow[]; attachments?: AttachmentRow[]; uid?: string | null; selectError?: { code: string }; signOk?: boolean } = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const logs: string[] = [];
  const gw: Gateway = {
    async verifyCaller() {
      return opts.uid === undefined ? 'u-1' : opts.uid;
    },
    async selectEvidence(ids) {
      calls.push({ fn: 'selectEvidence', args: [ids] });
      if (opts.selectError) return { data: null, error: opts.selectError };
      return { data: (opts.evidence ?? []).filter((r) => ids.includes(r.id)), error: null };
    },
    async selectAttachments(ids) {
      calls.push({ fn: 'selectAttachments', args: [ids] });
      return { data: (opts.attachments ?? []).filter((r) => ids.includes(r.id)), error: null };
    },
    async signStorage(bucket, path, seconds, name) {
      calls.push({ fn: 'signStorage', args: [bucket, path, seconds, name] });
      return opts.signOk === false ? null : `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t`;
    },
    logError(msg) {
      logs.push(msg);
    },
  };
  return { gw, calls, logs };
}
const open = () => createRateLimit({ calls: 1000, ids: 100_000 });
const post = (gw: Gateway, b: unknown, r2: typeof R2 | null = R2, limit = open()) =>
  handleEvidenceView('POST', true, JSON.stringify(b), gw, r2, limit, () => NOW);
type FileOut = Record<string, unknown>;
const files = (r: { body: Record<string, unknown> }) => r.body.files as FileOut[];

describe('evidence-view validation', () => {
  it('needs 1-50 UUIDs across evidence_ids and attachment_ids', () => {
    assert.equal(parseRequest({ evidence_ids: [E1] }).ok, true);
    assert.equal(parseRequest({ attachment_ids: [A1] }).ok, true);
    for (const b of [{}, { evidence_ids: [] }, { evidence_ids: 'x' }, { evidence_ids: ['nope'] }, [],
      { evidence_ids: Array.from({ length: 30 }, (_, i) => `3e700000-0000-4000-8000-${String(i).padStart(12, '0')}`),
        attachment_ids: Array.from({ length: 21 }, (_, i) => `3e800000-0000-4000-8000-${String(i).padStart(12, '0')}`) }]) {
      assert.equal(parseRequest(b).ok, false, JSON.stringify(b).slice(0, 40));
    }
    assert.equal(MAX_IDS, 50);
  });
  it('lower-cases, drops repeats and defaults to inline', () => {
    const r = parseRequest({ evidence_ids: [E1.toUpperCase(), E1] });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, { evidence_ids: [E1], attachment_ids: [], disposition: 'inline' });
    const d = parseRequest({ evidence_ids: [E1], disposition: 'download' });
    assert.equal(!d.ok && d.failure.error.field, 'disposition');
  });
});

describe('evidence-view names and types', () => {
  it('only renders known safe types inline', () => {
    for (const m of ['image/jpeg', 'image/png', 'application/pdf', 'video/mp4', 'audio/mpeg', 'text/plain']) assert.ok(canInline(m), m);
    for (const m of ['text/html', 'image/svg+xml', 'application/xml', 'application/octet-stream',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) assert.equal(canInline(m), false, m);
    assert.equal(serveType(' Image/JPEG; q=1'), 'image/jpeg');
    assert.equal(serveType(null), 'application/octet-stream');
    assert.equal(serveType('text/html\r\nX: y'), 'application/octet-stream');
  });
  it('makes header-safe file names', () => {
    assert.equal(safeFileName('../../etc/passwd', 'f'), 'passwd');
    assert.equal(safeFileName('C:\\x\\a"b\r\n.pdf', 'f'), 'ab.pdf');
    assert.equal(safeFileName('', 'photo-1.jpg'), 'photo-1.jpg');
    assert.equal(safeFileName('..', 'f'), 'f');
    assert.equal([...safeFileName('a'.repeat(500), 'f')].length, 120);
    assert.equal(contentDisposition('attachment', 'Claim ₹ form.pdf'),
      `attachment; filename="Claim _ form.pdf"; filename*=UTF-8''Claim%20%E2%82%B9%20form.pdf`);
    assert.equal(keyExt('cases/x/files/abc.JPG'), 'jpg');
    assert.equal(keyExt('noext'), '');
  });
  it('checks object keys before signing', () => {
    assert.ok(isR2EvidenceKey(evidenceKey(CASE, TASK, SHA, 'jpg')));
    assert.ok(isR2EvidenceKey(`cases/${CASE}/files/${SHA}.pdf`));
    assert.equal(isR2EvidenceKey(`cases/${CASE}/../${SHA}.pdf`), false);
    assert.ok(isStoragePath('2026/11/msg-1/att-1.pdf'));
    for (const p of ['', '/abs', 'a/../b']) assert.equal(isStoragePath(p), false, p);
  });
  it('rewrites Storage links to the public origin when configured', () => {
    const s = 'http://kong:8000/storage/v1/object/sign/email-raw/a.pdf?token=t';
    assert.equal(publicStorageUrl(s, undefined), s);
    assert.equal(publicStorageUrl(s, 'http://127.0.0.1:54321/'), 'http://127.0.0.1:54321/storage/v1/object/sign/email-raw/a.pdf?token=t');
  });
  it('prefers the read-only R2 token', () => {
    const base = { R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'rw', R2_SECRET_ACCESS_KEY: 'rws' } as Record<string, string>;
    assert.equal(readViewR2Config((k) => base[k])?.accessKeyId, 'rw');
    const ro = { ...base, R2_READ_ACCESS_KEY_ID: 'ro', R2_READ_SECRET_ACCESS_KEY: 'ros' } as Record<string, string>;
    assert.deepEqual(readViewR2Config((k) => ro[k]), { accountId: 'a', bucket: 'b', accessKeyId: 'ro', secretAccessKey: 'ros' });
    assert.equal(readViewR2Config((k) => ({ R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' } as Record<string, string>)[k]), null);
  });
});

describe('evidence-view rate limit', () => {
  it('limits calls and ids per user per minute', () => {
    const l = createRateLimit({ calls: 2, ids: 60 });
    assert.equal(l.take('u', 50, 0), null);
    assert.equal(l.take('u', 20, 1_000), 59); // ids
    assert.equal(l.take('u', 5, 1_000), null);
    assert.equal(l.take('u', 1, 2_000), 58); // calls
    assert.equal(l.take('other', 50, 2_000), null);
    assert.equal(l.take('u', 50, 60_001), null); // window moved on
  });
  it('forgets the least recently used callers', () => {
    const l = createRateLimit({ calls: 1, ids: 10, maxUsers: 2 });
    l.take('a', 1, 0);
    l.take('b', 1, 0);
    l.take('c', 1, 0); // evicts a
    assert.equal(l.take('a', 1, 1), null);
    assert.notEqual(l.take('c', 1, 1), null);
  });
});

describe('evidence-view presigned GET', () => {
  it('signs the disposition and type and lives 300 s', async () => {
    const key = evidenceKey(CASE, TASK, SHA, 'jpg');
    const g = await presignEvidenceGet(R2, key, NOW, { contentType: 'image/jpeg', contentDisposition: contentDisposition('inline', 'a b.jpg') });
    const u = new URL(g.url);
    assert.equal(`${u.origin}${u.pathname}`, `https://acct.r2.cloudflarestorage.com/evidence/${key}`);
    assert.equal(u.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(u.searchParams.get('response-content-type'), 'image/jpeg');
    assert.equal(u.searchParams.get('response-content-disposition'), `inline; filename="a b.jpg"; filename*=UTF-8''a%20b.jpg`);
    assert.equal(g.expires_in, 300);
    assert.ok(!g.url.includes('TOPSECRETVALUE'));
    const dl = await presignEvidenceGet(R2, key, NOW, { contentType: 'image/jpeg', contentDisposition: contentDisposition('attachment', 'a b.jpg') });
    assert.notEqual(u.searchParams.get('X-Amz-Signature'), new URL(dl.url).searchParams.get('X-Amz-Signature'));
  });
  it('leaves the PUT unchanged (no extra query parameters)', async () => {
    const put = await presignEvidencePut(R2, 'k', SHA, NOW, 10);
    assert.deepEqual([...new URL(put.url).searchParams.keys()].sort(),
      ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Signature', 'X-Amz-SignedHeaders']);
  });
});

describe('evidence-view flow', () => {
  it('refuses non-POST, no session, big or bad bodies', async () => {
    const { gw } = fakeGateway();
    assert.equal((await handleEvidenceView('GET', true, '', gw, R2, open())).status, 405);
    assert.equal((await handleEvidenceView('POST', false, '{}', gw, R2, open())).status, 401);
    assert.equal((await handleEvidenceView('POST', true, 'x'.repeat(MAX_BODY_CHARS + 1), gw, R2, open())).status, 400);
    assert.equal((await handleEvidenceView('POST', true, '{', gw, R2, open())).status, 400);
    assert.equal((await post(fakeGateway({ uid: null }).gw, { evidence_ids: [E1] })).status, 401);
  });
  it('returns an R2 GET for a visible file and not_found for the rest', async () => {
    const { gw, calls } = fakeGateway({ evidence: [r2Row()] });
    const r = await post(gw, { evidence_ids: [E1, E2] });
    assert.equal(r.status, 200);
    assert.equal(r.body.expires_in, 300);
    const [a, b] = files(r);
    assert.equal(a.id, E1);
    assert.equal(a.kind, 'evidence');
    assert.equal(a.content_type, 'image/jpeg');
    assert.equal(a.file_name, 'IMG_0001.jpg');
    assert.equal(a.disposition, 'inline');
    assert.equal(a.expires_at, '2026-11-15T12:05:00.000Z');
    assert.match(String(a.url), /^https:\/\/acct\.r2\.cloudflarestorage\.com\/evidence\/cases\//);
    assert.deepEqual(b, { kind: 'evidence', id: E2, error: 'not_found' });
    assert.deepEqual(calls.map((c) => c.fn), ['selectEvidence']); // R2 is signed locally, no Storage call
  });
  it('signs insurer attachments with the caller client, as a download when asked or unsafe', async () => {
    const { gw, calls } = fakeGateway({
      evidence: [r2Row({ id: E3, storage_backend: 'supabase', storage_path: 'raw/m1/policy.pdf', mime_type: 'application/pdf', original_filename: 'policy.pdf' })],
      attachments: [{ id: A1, filename: 'page.html', mime_type: 'text/html', storage_path: 'raw/m1/page.html' }],
    });
    const r = await post(gw, { evidence_ids: [E3], attachment_ids: [A1] });
    const [ev, at] = files(r);
    assert.equal(ev.disposition, 'inline');
    assert.equal(at.disposition, 'attachment'); // HTML is never inline
    assert.equal(at.kind, 'attachment');
    assert.match(String(ev.url), /\/object\/sign\/email-raw\/raw\/m1\/policy\.pdf/);
    assert.deepEqual(calls.filter((c) => c.fn === 'signStorage').map((c) => c.args),
      [['email-raw', 'raw/m1/policy.pdf', 300, null], ['email-raw', 'raw/m1/page.html', 300, 'page.html']]);
    const dl = await post(fakeGateway({ evidence: [r2Row()] }).gw, { evidence_ids: [E1], disposition: 'attachment' });
    assert.match(decodeURIComponent(String(files(dl)[0].url)), /response-content-disposition=attachment; filename="IMG_0001.jpg"/);
  });
  it('names notes, archived and refused files without a link', async () => {
    const { gw, logs } = fakeGateway({
      evidence: [
        r2Row({ id: E1, evidence_type: 'note', storage_path: null }),
        r2Row({ id: E2, cloud_purged_at: '2026-11-01T00:00:00Z' }),
        r2Row({ id: E3, storage_backend: 'supabase', storage_path: 'raw/x.pdf' }),
      ],
      signOk: false,
    });
    const r = await post(gw, { evidence_ids: [E1, E2, E3] });
    assert.deepEqual(files(r).map((f) => f.error), ['no_file', 'archived', 'unavailable']);
    assert.ok(logs.every((l) => !l.includes('TOPSECRET')));
  });
  it('returns 503 when R2 is not configured, but only once a visible R2 file is asked for', async () => {
    const none = await post(fakeGateway().gw, { evidence_ids: [E1] }, null);
    assert.equal(none.status, 200); // nothing visible: same answer as with storage configured
    assert.deepEqual(files(none)[0], { kind: 'evidence', id: E1, error: 'not_found' });
    const r = await post(fakeGateway({ evidence: [r2Row()] }).gw, { evidence_ids: [E1] }, null);
    assert.equal(r.status, 503);
    assert.equal((r.body.error as { code: string }).code, 'storage_not_configured');
    const att = await post(fakeGateway({ attachments: [{ id: A1, filename: 'a.pdf', mime_type: 'application/pdf', storage_path: 'a.pdf' }] }).gw,
      { attachment_ids: [A1] }, null);
    assert.equal(att.status, 200);
  });
  it('maps database errors and rate limits', async () => {
    const jwt = await post(fakeGateway({ selectError: { code: 'PGRST301' } }).gw, { evidence_ids: [E1] });
    assert.equal(jwt.status, 401);
    const { gw, logs } = fakeGateway({ selectError: { code: 'XX000' } });
    assert.equal((await post(gw, { evidence_ids: [E1] })).status, 502);
    assert.equal(logs.length, 1);
    const limit = createRateLimit({ calls: 1, ids: 50 });
    const ok = fakeGateway({ evidence: [r2Row()] });
    assert.equal((await post(ok.gw, { evidence_ids: [E1] }, R2, limit)).status, 200);
    const again = await post(ok.gw, { evidence_ids: [E1] }, R2, limit);
    assert.equal(again.status, 429);
    assert.equal(again.retryAfter, 60);
  });
});
