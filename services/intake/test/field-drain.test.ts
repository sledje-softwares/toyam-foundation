// field-drain edge function (D43): pure logic, SigV4 presign and request flow against a fake gateway.
// Lives here because this workspace runs the Node tests for supabase/functions/_shared.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evidenceKey, mapDbError, parseRequest, rateLimited, presignEvidencePut, presignUrl, readR2Config, uriEncode,
} from '../../../supabase/functions/_shared/field-drain/logic.ts';
import { type Gateway, handleFieldDrain, MAX_BODY_CHARS } from '../../../supabase/functions/_shared/field-drain/handler.ts';

const DEV = '5d000000-0000-4000-8000-000000000003';
const SECRET = 'ab'.repeat(32);
const CASE = '3d200000-0000-4000-8000-000000000001';
const TASK = '3d300000-0000-4000-8000-000000000003';
const SHA = 'e1'.repeat(32);
const R2 = { accountId: 'acct', bucket: 'evidence', accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
const item = { evidence_type: 'photo', capture_source: 'camera', sha256: SHA, device_captured_at: '2026-11-13T10:00:00Z' };

function fakeGateway(results: Record<string, { data: unknown; error: { code?: string; message?: string; hint?: string } | null }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const checks: { fn: string; args: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const gw: Gateway = {
    async rpc(fn, args) {
      (fn === 'drain_check' ? checks : calls).push({ fn, args });
      if (fn === 'drain_check' && !results[fn]) return { data: [{ result: 'ok', retry_after_seconds: null }], error: null };
      return results[fn] ?? { data: null, error: { code: 'XX000', message: 'unexpected' } };
    },
    logError(msg) {
      logs.push(msg);
    },
  };
  return { gw, calls, checks, logs };
}
const post = (gw: Gateway, body: unknown, r2: typeof R2 | null = R2) =>
  handleFieldDrain('POST', JSON.stringify(body), gw, r2, () => new Date('2026-11-14T12:00:00Z'));

describe('SigV4 presign', () => {
  it('matches the AWS S3 documented presigned GET example', async () => {
    const url = await presignUrl({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1', service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'), expiresSeconds: 86400,
    });
    assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
    assert.match(url, /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request/);
  });
  it('binds the R2 PUT to the file hash and a short expiry', async () => {
    const key = evidenceKey(CASE, TASK, SHA, 'jpg');
    const put = await presignEvidencePut(R2, key, SHA, new Date('2026-11-14T12:00:00Z'));
    assert.ok(put.url.startsWith(`https://acct.r2.cloudflarestorage.com/evidence/${key}?`));
    assert.match(put.url, /X-Amz-SignedHeaders=host%3Bx-amz-content-sha256/);
    assert.match(put.url, /X-Amz-Expires=600&/);
    assert.deepEqual(put.headers, { 'x-amz-content-sha256': SHA });
    const other = await presignEvidencePut(R2, key, 'e2'.repeat(32), new Date('2026-11-14T12:00:00Z'));
    assert.notEqual(new URL(put.url).searchParams.get('X-Amz-Signature'), new URL(other.url).searchParams.get('X-Amz-Signature'));
  });
  it('RFC 3986 encodes', () => {
    assert.equal(uriEncode("a b!'()*"), 'a%20b%21%27%28%29%2A');
    assert.equal(uriEncode('/x/y z', true), '/x/y%20z');
  });
  it('R2 config needs all four values', () => {
    const env: Record<string, string> = { R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'c', R2_SECRET_ACCESS_KEY: 'd' };
    assert.deepEqual(readR2Config((k) => env[k]), { accountId: 'a', bucket: 'b', accessKeyId: 'c', secretAccessKey: 'd' });
    delete env.R2_BUCKET;
    assert.equal(readR2Config((k) => env[k]), null);
  });
});

describe('request validation', () => {
  it('requires a UUID device and a 64-hex secret', () => {
    assert.equal(parseRequest({ action: 'status', device_id: 'x', secret: SECRET }).ok, false);
    const r = parseRequest({ action: 'status', device_id: DEV, secret: 'AB'.repeat(32) });
    assert.ok(!r.ok && r.failure.error.field === 'secret');
    assert.ok(parseRequest({ action: 'status', device_id: DEV, secret: SECRET }).ok);
  });
  it('post: files only, 1-30 items, each with a capture time', () => {
    const base = { action: 'post', device_id: DEV, secret: SECRET, case_id: CASE, client_message_id: DEV, task_id: TASK };
    assert.ok(parseRequest({ ...base, kind: 'media', items: [item] }).ok);
    const text = parseRequest({ ...base, kind: 'text', body: 'hi', items: [item] });
    assert.ok(!text.ok && text.failure.error.field === 'kind');
    assert.equal(parseRequest({ ...base, kind: 'media', items: [] }).ok, false);
    assert.equal(parseRequest({ ...base, kind: 'media', items: Array(31).fill(item) }).ok, false);
    assert.equal(parseRequest({ ...base, kind: 'media', items: [{ ...item, device_captured_at: 'yesterday' }] }).ok, false);
  });
  it('presign: sha256, ext and capture time', () => {
    const base = { action: 'presign', device_id: DEV, secret: SECRET, task_id: TASK, sha256: SHA, ext: 'jpg', device_captured_at: '2026-11-13T10:00:00+05:30' };
    assert.ok(parseRequest(base).ok);
    assert.equal(parseRequest({ ...base, ext: '../x' }).ok, false);
    assert.equal(parseRequest({ ...base, sha256: 'e1' }).ok, false);
  });
  it('outbox counts are whole and non-negative', () => {
    const base = { action: 'outbox', device_id: DEV, secret: SECRET, pending_bytes: 10 };
    assert.ok(parseRequest({ ...base, pending_count: 2 }).ok);
    assert.equal(parseRequest({ ...base, pending_count: -1 }).ok, false);
    assert.equal(parseRequest({ ...base, pending_count: 1.5 }).ok, false);
  });
});

describe('error mapping', () => {
  it('maps drain hints to statuses', () => {
    assert.equal(mapDbError({ code: '42501', hint: 'device_unknown' }).status, 401);
    assert.equal(mapDbError({ code: '42501', hint: 'not_deactivated' }).status, 409);
    assert.equal(mapDbError({ code: '42501', hint: 'drain_window_closed' }).status, 410);
    assert.equal(mapDbError({ code: '42501', hint: 'drain_finished' }).status, 410);
    assert.equal(mapDbError({ code: '42501', hint: 'upload_window_closed' }).error.code, 'upload_window_closed');
    assert.equal(mapDbError({ code: '22023', message: 'bad' }).status, 400);
    const locked = mapDbError({ code: '42501', hint: 'device_locked', details: '1800' });
    assert.equal(locked.status, 429);
    assert.equal(locked.retryAfter, 1800);
    assert.equal(mapDbError({ code: '42501', hint: 'device_locked' }).retryAfter, 3600);
    assert.equal(mapDbError({ code: '42501' }).status, 500);
  });
});

describe('handler', () => {
  it('POST only, size limit, JSON only', async () => {
    const { gw, calls } = fakeGateway({});
    assert.equal((await handleFieldDrain('GET', '', gw, R2)).status, 405);
    assert.equal((await handleFieldDrain('POST', 'x'.repeat(MAX_BODY_CHARS + 1), gw, R2)).status, 400);
    assert.equal((await handleFieldDrain('POST', '{', gw, R2)).status, 400);
    assert.equal(calls.length, 0);
  });
  it('status passes the device and secret to drain_status', async () => {
    const { gw, calls } = fakeGateway({ drain_status: { data: [{ state: 'drain', deactivated_at: 'd', drain_until: 'u' }], error: null } });
    const r = await post(gw, { action: 'status', device_id: DEV, secret: SECRET });
    assert.deepEqual(r.body, { ok: true, state: 'drain', deactivated_at: 'd', drain_until: 'u' });
    assert.deepEqual(calls[0], { fn: 'drain_status', args: { p_device_id: DEV, p_secret: SECRET } });
  });
  it('presign authorises in the database, then signs the conventional key', async () => {
    const { gw, calls } = fakeGateway({ drain_authorize_upload: { data: CASE, error: null } });
    const r = await post(gw, { action: 'presign', device_id: DEV, secret: SECRET, task_id: TASK, sha256: SHA, ext: 'jpg', device_captured_at: '2026-11-13T10:00:00Z' });
    assert.equal(r.status, 200);
    assert.equal(r.body.storage_path, `cases/${CASE}/tasks/${TASK}/${SHA}.jpg`);
    assert.equal(r.body.method, 'PUT');
    assert.deepEqual(calls[0].args, { p_device_id: DEV, p_secret: SECRET, p_task_id: TASK, p_sha256: SHA, p_device_captured_at: '2026-11-13T10:00:00Z' });
  });
  it('presign refused by the window never signs', async () => {
    const { gw } = fakeGateway({ drain_authorize_upload: { data: null, error: { code: '42501', hint: 'upload_window_closed' } } });
    const r = await post(gw, { action: 'presign', device_id: DEV, secret: SECRET, task_id: TASK, sha256: SHA, ext: 'jpg', device_captured_at: '2026-11-14T10:00:00Z' });
    assert.equal(r.status, 422);
    assert.equal(r.body.url, undefined);
  });
  it('presign without R2 config is 503 before any rpc', async () => {
    const { gw, calls } = fakeGateway({});
    const r = await post(gw, { action: 'presign', device_id: DEV, secret: SECRET, task_id: TASK, sha256: SHA, ext: 'jpg', device_captured_at: '2026-11-13T10:00:00Z' }, null);
    assert.equal(r.status, 503);
    assert.equal(calls.length, 0);
  });
  it('post forwards to drain_post_message and returns the message id', async () => {
    const { gw, calls } = fakeGateway({ drain_post_message: { data: 'msg-1', error: null } });
    const r = await post(gw, { action: 'post', device_id: DEV, secret: SECRET, case_id: CASE, client_message_id: DEV, kind: 'media', task_id: TASK, items: [item] });
    assert.deepEqual(r.body, { ok: true, message_id: 'msg-1' });
    assert.equal(calls[0].args.p_kind, 'media');
    assert.equal(calls[0].args.p_reply_to, null);
    assert.deepEqual(calls[0].args.p_items, [item]);
  });
  it('wrong secret is 401 and nothing secret is logged', async () => {
    const { gw, logs } = fakeGateway({ drain_status: { data: null, error: { code: '42501', hint: 'device_unknown' } } });
    const r = await post(gw, { action: 'status', device_id: DEV, secret: SECRET });
    assert.equal(r.status, 401);
    const { gw: gw2, logs: logs2 } = fakeGateway({ drain_finish: { data: null, error: { code: 'XX000', message: 'boom' } } });
    assert.equal((await post(gw2, { action: 'finish', device_id: DEV, secret: SECRET })).status, 500);
    assert.ok(logs2.length === 1 && !logs2[0].includes(SECRET));
    assert.equal(logs.length, 0);
  });
  it('finish tells the app to wipe; outbox is forwarded', async () => {
    const { gw, calls } = fakeGateway({ drain_finish: { data: null, error: null }, drain_report_outbox: { data: null, error: null } });
    assert.deepEqual((await post(gw, { action: 'finish', device_id: DEV, secret: SECRET, discarded_count: 2 })).body, { ok: true, wipe: true });
    assert.equal(calls[0].args.p_discarded_count, 2);
    assert.equal((await post(gw, { action: 'outbox', device_id: DEV, secret: SECRET, pending_count: 3, pending_bytes: 9 })).status, 200);
    assert.deepEqual(calls[1].args, { p_device_id: DEV, p_secret: SECRET, p_pending_count: 3, p_pending_bytes: 9, p_oldest_pending_at: null });
  });
});

describe('rate limits', () => {
  it('clamps Retry-After', () => {
    assert.equal(rateLimited('rate_limited', 0).retryAfter, 60);
    assert.equal(rateLimited('rate_limited', 12.2).retryAfter, 13);
    assert.equal(rateLimited('device_locked', 9_999_999).retryAfter, 86_400);
    assert.equal(rateLimited('device_locked', null).retryAfter, 3600);
  });
  it('checks first and maps a lock to 429 with Retry-After, doing nothing else', async () => {
    const { gw, calls, checks } = fakeGateway({ drain_check: { data: [{ result: 'device_locked', retry_after_seconds: 3600 }], error: null } });
    const r = await post(gw, { action: 'status', device_id: DEV, secret: SECRET });
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, 3600);
    assert.deepEqual((r.body.error as { code: string }).code, 'device_locked');
    assert.equal(calls.length, 0);
    assert.equal(checks[0].args.p_action, 'status');
  });
  it('maps the call / file cap to 429 and passes the action', async () => {
    const { gw, calls, checks } = fakeGateway({ drain_check: { data: [{ result: 'rate_limited', retry_after_seconds: 42 }], error: null } });
    const r = await post(gw, { action: 'presign', device_id: DEV, secret: SECRET, task_id: TASK, sha256: SHA, ext: 'jpg', device_captured_at: '2026-11-13T10:00:00Z' });
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, 42);
    assert.equal((r.body.error as { code: string }).code, 'rate_limited');
    assert.equal(calls.length, 0);
    assert.equal(checks[0].args.p_action, 'presign');
  });
  it('a bad secret from the check is a 401 and stops there', async () => {
    const { gw, calls, checks } = fakeGateway({ drain_check: { data: [{ result: 'device_unknown', retry_after_seconds: null }], error: null } });
    const r = await post(gw, { action: 'status', device_id: DEV, secret: SECRET });
    assert.equal(r.status, 401);
    assert.equal(r.retryAfter, undefined);
    assert.equal(calls.length, 0);
  });
  it('an unexpected check result or error fails closed', async () => {
    const a = fakeGateway({ drain_check: { data: [], error: null } });
    assert.equal((await post(a.gw, { action: 'status', device_id: DEV, secret: SECRET })).status, 500);
    const b = fakeGateway({ drain_check: { data: null, error: { code: 'XX000' } } });
    const r = await post(b.gw, { action: 'status', device_id: DEV, secret: SECRET });
    assert.equal(r.status, 500);
    assert.equal(b.calls.length, 0);
    assert.equal(b.checks.length, 1);
  });
});
