// evidence-upload edge function (1.4): validation, caps, error mapping and the request flow against
// a fake gateway (the caller's JWT client). Lives here because this workspace runs the Node tests
// for supabase/functions/_shared.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapDbError, MAX_BYTES, MIME_EXT, maxBytesFor, normaliseMime, parseRequest,
} from '../../../supabase/functions/_shared/evidence-upload/logic.ts';
import { type Gateway, handleEvidenceUpload, MAX_BODY_CHARS } from '../../../supabase/functions/_shared/evidence-upload/handler.ts';
import { presignEvidencePut } from '../../../supabase/functions/_shared/r2/presign.ts';

const CASE = '3e500000-0000-4000-8000-000000000001';
const TASK = '3e600000-0000-4000-8000-000000000001';
const SHA = 'a1'.repeat(32);
const SHA2 = 'a2'.repeat(32);
const R2 = { accountId: 'acct', bucket: 'evidence', accessKeyId: 'AKID', secretAccessKey: 'TOPSECRETVALUE' };
const file = (over: Record<string, unknown> = {}) => ({ sha256: SHA, size: 800_000, mime: 'image/jpeg', device_captured_at: '2026-11-14T10:00:00Z', ...over });
const body = (over: Record<string, unknown> = {}) => ({ task_id: TASK, case_id: CASE, files: [file()], ...over });

type Res = { data: unknown; error: { code?: string; message?: string; hint?: string } | null };
function fakeGateway(results: Record<string, Res | ((args: Record<string, unknown>) => Res)>, uid: string | null = 'u-1') {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const gw: Gateway = {
    async verifyCaller() {
      return uid;
    },
    async rpc(fn, args) {
      calls.push({ fn, args });
      const r = results[fn];
      if (typeof r === 'function') return r(args);
      return r ?? { data: null, error: { code: 'XX000', message: 'unexpected' } };
    },
    logError(msg) {
      logs.push(msg);
    },
  };
  return { gw, calls, logs };
}
const allowed: Record<string, Res> = {
  can_upload_evidence_at: { data: true, error: null },
  evidence_upload_target: { data: [{ case_id: CASE, stored_sha256: [] }], error: null },
};
const post = (gw: Gateway, b: unknown, r2: typeof R2 | null = R2, auth = true) =>
  handleEvidenceUpload('POST', auth, JSON.stringify(b), gw, r2, () => new Date('2026-11-14T12:00:00Z'));

describe('evidence-upload validation', () => {
  it('needs task_id, case_id and 1-30 files', () => {
    assert.equal(parseRequest(body()).ok, true);
    assert.equal(parseRequest([]).ok, false);
    for (const b of [body({ task_id: 'x' }), body({ case_id: 1 }), body({ files: [] }), body({ files: Array(31).fill(file()) })]) {
      const r = parseRequest(b);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.failure.status, 400);
    }
  });
  it('checks each file: hash, capture time, no repeats', () => {
    const cases: [Record<string, unknown>[], string][] = [
      [[file({ sha256: 'A1'.repeat(32) })], 'files[0].sha256'],
      [[file({ device_captured_at: 'yesterday' })], 'files[0].device_captured_at'],
      [[file({ size: 0 })], 'files[0].size'],
      [[file({ size: 1.5 })], 'files[0].size'],
      [[file(), file()], 'files[1].sha256'],
    ];
    for (const [files, field] of cases) {
      const r = parseRequest(body({ files }));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.failure.error.field, field);
    }
  });
  it('allow-lists types and derives the extension from the type', () => {
    const r = parseRequest(body({ files: [file({ mime: 'Audio/MP4; codecs=aac' })] }));
    assert.equal(r.ok && r.value.files[0].ext, 'm4a');
    assert.equal(normaliseMime(' image/JPEG '), 'image/jpeg');
    for (const mime of ['text/html', 'application/x-msdownload', 'image/svg+xml', '']) {
      const x = parseRequest(body({ files: [file({ mime })] }));
      assert.equal(!x.ok && x.failure.error.code, 'unsupported_type', mime);
    }
    for (const ext of Object.values(MIME_EXT)) assert.match(ext, /^[a-z0-9]{1,8}$/); // DB key check
  });
  it('caps size per type family with 413', () => {
    assert.equal(maxBytesFor('image/jpeg'), MAX_BYTES.image);
    assert.equal(maxBytesFor('video/mp4'), MAX_BYTES.video);
    assert.ok(MAX_BYTES.video > MAX_BYTES.image);
    assert.equal(parseRequest(body({ files: [file({ size: MAX_BYTES.image })] })).ok, true);
    const r = parseRequest(body({ files: [file({ size: MAX_BYTES.image + 1 })] }));
    assert.equal(!r.ok && r.failure.status, 413);
    assert.equal(!r.ok && r.failure.error.code, 'file_too_large');
    assert.equal(parseRequest(body({ files: [file({ mime: 'video/mp4', size: MAX_BYTES.image + 1 })] })).ok, true);
  });
  it('maps database errors', () => {
    assert.equal(mapDbError({ code: '42501', hint: 'upload_window_closed' }).error.code, 'upload_window_closed');
    assert.equal(mapDbError({ code: '42501', hint: 'upload_window_closed' }).status, 403);
    assert.equal(mapDbError({ code: '42501' }).error.code, 'forbidden');
    assert.equal(mapDbError({ code: 'PGRST301' }).status, 401);
    assert.equal(mapDbError({ code: '22023' }).status, 400);
    assert.equal(mapDbError({ code: '57014' }).status, 502);
  });
});

describe('R2 PUT bound to size', () => {
  it('signs content-length with the hash; a different size changes the signature', async () => {
    const at = new Date('2026-11-14T12:00:00Z');
    const a = await presignEvidencePut(R2, 'k', SHA, at, 1000);
    const b = await presignEvidencePut(R2, 'k', SHA, at, 1001);
    assert.match(a.url, /X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-content-sha256/);
    assert.notEqual(a.url, b.url);
    assert.deepEqual(a.headers, { 'x-amz-content-sha256': SHA });
    const drain = await presignEvidencePut(R2, 'k', SHA, at);
    assert.match(drain.url, /X-Amz-SignedHeaders=host%3Bx-amz-content-sha256/); // field-drain unchanged
  });
});

describe('evidence-upload handler', () => {
  it('POST only, bearer token required, body limit, JSON only', async () => {
    const { gw, calls } = fakeGateway(allowed);
    assert.equal((await handleEvidenceUpload('GET', true, '', gw, R2)).status, 405);
    assert.equal((await post(gw, body(), R2, false)).status, 401);
    assert.equal((await handleEvidenceUpload('POST', true, 'x'.repeat(MAX_BODY_CHARS + 1), gw, R2)).status, 400);
    assert.equal((await handleEvidenceUpload('POST', true, '{', gw, R2)).status, 400);
    assert.equal(calls.length, 0);
  });
  it('an invalid session is 401 before any rpc', async () => {
    const { gw, calls } = fakeGateway(allowed, null);
    const r = await post(gw, body());
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  });
  it('checks the window with the caller, then signs the conventional key bound to hash and size', async () => {
    const { gw, calls } = fakeGateway(allowed);
    const r = await post(gw, body());
    assert.equal(r.status, 200);
    assert.deepEqual(calls.map((c) => c.fn), ['can_upload_evidence_at', 'evidence_upload_target']);
    assert.deepEqual(calls[0].args, { p_task_id: TASK, p_device_captured_at: '2026-11-14T10:00:00Z' });
    assert.deepEqual(calls[1].args, { p_task_id: TASK, p_sha256: [SHA] });
    const f = (r.body.files as Record<string, unknown>[])[0];
    assert.equal(f.status, 'upload');
    assert.equal(f.storage_path, `cases/${CASE}/tasks/${TASK}/${SHA}.jpg`);
    assert.equal(f.method, 'PUT');
    assert.equal(f.expires_in, 600);
    assert.deepEqual(f.headers, { 'x-amz-content-sha256': SHA });
    assert.match(String(f.url), new RegExp(`^https://acct\\.r2\\.cloudflarestorage\\.com/evidence/cases/${CASE}/tasks/${TASK}/${SHA}\\.jpg\\?`));
    assert.match(String(f.url), /content-length/);
  });
  it('one window check per distinct capture time', async () => {
    const { gw, calls } = fakeGateway(allowed);
    await post(gw, body({ files: [file(), file({ sha256: SHA2 }), file({ sha256: 'a3'.repeat(32), device_captured_at: '2026-11-14T11:00:00Z' })] }));
    assert.equal(calls.filter((c) => c.fn === 'can_upload_evidence_at').length, 2);
  });
  it('outside the window: 403 upload_window_closed, never signs, lists the refused files', async () => {
    const { gw, calls } = fakeGateway({
      ...allowed,
      can_upload_evidence_at: (a) => ({ data: a.p_device_captured_at === '2026-11-14T10:00:00Z', error: null }),
    });
    const r = await post(gw, body({ files: [file(), file({ sha256: SHA2, device_captured_at: '2026-11-14T11:30:00Z' })] }));
    assert.equal(r.status, 403);
    const e = r.body.error as Record<string, unknown>;
    assert.equal(e.code, 'upload_window_closed');
    assert.deepEqual(e.refused, [SHA2]);
    assert.ok(!calls.some((c) => c.fn === 'evidence_upload_target'));
    assert.ok(!JSON.stringify(r.body).includes('X-Amz'));
  });
  it('files already on the case are returned as already_stored without a URL (rule 6)', async () => {
    const { gw } = fakeGateway({ ...allowed, evidence_upload_target: { data: [{ case_id: CASE, stored_sha256: [SHA] }], error: null } });
    const r = await post(gw, body({ files: [file(), file({ sha256: SHA2, mime: 'application/pdf' })] }));
    const [a, b] = r.body.files as Record<string, unknown>[];
    assert.deepEqual(a, { sha256: SHA, status: 'already_stored', storage_path: `cases/${CASE}/tasks/${TASK}/${SHA}.jpg` });
    assert.equal(b.status, 'upload');
    assert.equal(b.storage_path, `cases/${CASE}/tasks/${TASK}/${SHA2}.pdf`);
  });
  it('a case_id that is not the task\'s case is 400 and never signs', async () => {
    const { gw } = fakeGateway({ ...allowed, evidence_upload_target: { data: [{ case_id: '3e500000-0000-4000-8000-0000000000ff', stored_sha256: [] }], error: null } });
    const r = await post(gw, body());
    assert.equal(r.status, 400);
    assert.equal((r.body.error as Record<string, unknown>).field, 'case_id');
  });
  it('maps rpc failures: 403 forbidden, 401 expired, 502 upstream (logged without secrets)', async () => {
    const forb = fakeGateway({ ...allowed, evidence_upload_target: { data: null, error: { code: '42501', message: 'Task not found' } } });
    const f = await post(forb.gw, body());
    assert.equal(f.status, 403);
    assert.equal((f.body.error as Record<string, unknown>).code, 'forbidden');
    const exp = fakeGateway({ can_upload_evidence_at: { data: null, error: { code: 'PGRST303', message: 'JWT expired' } } });
    assert.equal((await post(exp.gw, body())).status, 401);
    const down = fakeGateway({ can_upload_evidence_at: { data: null, error: { code: '57014', message: 'timeout' } } });
    const r = await post(down.gw, body());
    assert.equal(r.status, 502);
    assert.equal(down.logs.length, 1);
    assert.ok(!down.logs[0].includes(R2.secretAccessKey));
  });
  it('without R2 config: 503 before any rpc; the secret never appears in a reply or log', async () => {
    const none = fakeGateway(allowed);
    assert.equal((await post(none.gw, body(), null)).status, 503);
    assert.equal(none.calls.length, 0);
    const { gw, logs } = fakeGateway(allowed);
    const r = await post(gw, body({ files: [file(), file({ sha256: SHA2 })] }));
    assert.ok(!JSON.stringify(r.body).includes(R2.secretAccessKey));
    assert.ok(!logs.join('\n').includes(R2.secretAccessKey));
  });
});

// ---- shrunk copies (D51) ----
const SHA3 = 'a3'.repeat(32);
const CSHA = 'c1'.repeat(32);
const CSHA2 = 'c2'.repeat(32);
const deriv = (over: Record<string, unknown> = {}) => ({ original_sha256: SHA, width: 1600, sha256: CSHA, size: 250_000, ...over });
const dbody = (derivatives: unknown[], over: Record<string, unknown> = {}) => ({ task_id: TASK, case_id: CASE, files: [], derivatives, ...over });
const target = (originals: Record<string, number[]>, over: Record<string, unknown> = {}): Record<string, Res> => ({
  device_derivative_target: { data: { case_id: CASE, allowed: true, originals, ...over }, error: null },
});

describe('evidence-upload copies: validation', () => {
  it('copies may travel alone, but not with files, and files are still required otherwise', () => {
    assert.equal(parseRequest(dbody([deriv()])).ok, true);
    assert.equal(parseRequest(dbody([])).ok, false);
    assert.equal(parseRequest(dbody([deriv()], { files: [file()] })).ok, false);
    assert.equal(parseRequest(body({ derivatives: [] })).ok, true);
    const r = parseRequest(dbody([deriv()]));
    if (r.ok) assert.deepEqual(r.value.derivatives, [deriv()]);
  });
  it('checks width, hashes, size, repeats and the cap of 60', () => {
    const cases: [unknown[], string][] = [
      [[deriv({ width: 800 })], 'derivatives[0].width'],
      [[deriv({ sha256: 'X' })], 'derivatives[0].sha256'],
      [[deriv({ original_sha256: 'x' })], 'derivatives[0].original_sha256'],
      [[deriv({ size: 0 })], 'derivatives[0].size'],
      [[deriv(), deriv({ sha256: CSHA2 })], 'derivatives[1]'],
      [[5], 'derivatives[0]'],
    ];
    for (const [d, field] of cases) {
      const r = parseRequest(dbody(d));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.failure.error.field, field);
    }
    assert.equal(parseRequest(dbody(Array(61).fill(deriv()))).ok, false);
    const big = parseRequest(dbody([deriv({ size: 3 * 1024 * 1024 + 1 })]));
    assert.equal(big.ok, false);
    if (!big.ok) assert.equal(big.failure.status, 413);
    assert.equal(parseRequest(dbody([deriv({ size: 3 * 1024 * 1024 })])).ok, true);
    // 60 copies are allowed (30 photos x 2), but only 30 distinct originals per request
    const sixty = Array.from({ length: 30 }, (_, i) => [384, 1600].map((w) => deriv({ original_sha256: i.toString(16).padStart(64, 'b'), width: w }))).flat();
    assert.equal(parseRequest(dbody(sixty)).ok, true);
    const many = Array.from({ length: 31 }, (_, i) => deriv({ original_sha256: i.toString(16).padStart(64, 'b') }));
    assert.equal(parseRequest(dbody(many)).ok, false);
  });
});

describe('evidence-upload copies: handler', () => {
  it('signs the content-addressed key bound to the copy hash and size, with the caller only', async () => {
    const { gw, calls } = fakeGateway(target({ [SHA]: [] }));
    const r = await post(gw, dbody([deriv(), deriv({ width: 384, sha256: CSHA2, size: 30_000 })]));
    assert.equal(r.status, 200);
    assert.deepEqual(calls.map((c) => c.fn), ['device_derivative_target']);
    assert.deepEqual(calls[0].args, { p_task_id: TASK, p_originals: [SHA] });
    const ds = r.body.derivatives as Record<string, unknown>[];
    assert.equal(ds.length, 2);
    assert.equal(ds[0].status, 'upload');
    assert.equal(ds[0].storage_path, `derived/${CASE}/${SHA}/w1600-${CSHA}.jpg`);
    assert.equal(ds[0].method, 'PUT');
    assert.equal(ds[0].expires_in, 600);
    assert.deepEqual(ds[0].headers, { 'x-amz-content-sha256': CSHA });
    assert.match(String(ds[0].url), /content-length/);
    assert.equal(ds[1].storage_path, `derived/${CASE}/${SHA}/w384-${CSHA2}.jpg`);
    assert.deepEqual(r.body.files, []);
    assert.ok(!JSON.stringify(r.body).includes(R2.secretAccessKey));
  });
  it('a copy already recorded is already_stored; an unusable original is skipped (no URL)', async () => {
    const { gw } = fakeGateway(target({ [SHA]: [1600] }));
    const r = await post(gw, dbody([deriv(), deriv({ width: 384, sha256: CSHA2 }), deriv({ original_sha256: SHA3 })]));
    const [a, b, c] = r.body.derivatives as Record<string, unknown>[];
    assert.deepEqual(a, { original_sha256: SHA, width: 1600, sha256: CSHA, status: 'already_stored', storage_path: `derived/${CASE}/${SHA}/w1600-${CSHA}.jpg` });
    assert.equal(b.status, 'upload');
    assert.deepEqual(c, { original_sha256: SHA3, width: 1600, sha256: CSHA, status: 'skipped' });
  });
  it('not allowed (closed window): 403 upload_window_closed, nothing signed', async () => {
    const { gw } = fakeGateway(target({ [SHA]: [] }, { allowed: false }));
    const r = await post(gw, dbody([deriv()]));
    assert.equal(r.status, 403);
    assert.equal((r.body.error as Record<string, unknown>).code, 'upload_window_closed');
    assert.ok(!JSON.stringify(r.body).includes('X-Amz'));
  });
  it('a case_id that is not the task\'s case is 400; rpc failures map as for files', async () => {
    const { gw } = fakeGateway(target({ [SHA]: [] }, { case_id: '3e500000-0000-4000-8000-0000000000ff' }));
    assert.equal((await post(gw, dbody([deriv()]))).status, 400);
    const forb = fakeGateway({ device_derivative_target: { data: null, error: { code: '42501', message: 'x' } } });
    assert.equal((await post(forb.gw, dbody([deriv()]))).status, 403);
    const down = fakeGateway({ device_derivative_target: { data: null, error: { code: '57014', message: 'timeout' } } });
    assert.equal((await post(down.gw, dbody([deriv()]))).status, 502);
    const odd = fakeGateway({ device_derivative_target: { data: null, error: null } });
    assert.equal((await post(odd.gw, dbody([deriv()]))).status, 502);
  });
});
