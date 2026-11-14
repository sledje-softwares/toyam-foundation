import { describe, expect, it } from 'vitest';
import { ensureRegisteredDevice, loadDevice, type SecretStore } from './device';
import { drainServer, type FetchLike } from './drainServer';
import { classifyDrainError, classifyPgError } from './server';
import { sha256Hex, uuidV4 } from './sha256';
import { signedInServer } from './signedInServer';

describe('error classification', () => {
  it('maps PostgREST errors', () => {
    expect(classifyPgError({ code: '42501', hint: 'upload_window_closed' }).kind).toBe('window_closed');
    expect(classifyPgError({ code: '42501' }).kind).toBe('rejected');
    expect(classifyPgError({ code: '22023' }).kind).toBe('rejected');
    expect(classifyPgError({ code: 'PGRST301' }).kind).toBe('auth');
    expect(classifyPgError({ status: 401 }).kind).toBe('auth');
    expect(classifyPgError({ code: '57014' }).kind).toBe('transient');
    expect(classifyPgError({}).kind).toBe('transient');
  });
  it('maps field-drain errors', () => {
    expect(classifyDrainError(422, 'upload_window_closed').kind).toBe('window_closed');
    expect(classifyDrainError(409, 'not_deactivated').kind).toBe('reactivated');
    expect(classifyDrainError(410, 'drain_window_closed').kind).toBe('drain_closed');
    expect(classifyDrainError(401, 'device_unknown').kind).toBe('drain_closed');
    expect(classifyDrainError(400, 'invalid_input').kind).toBe('rejected');
    expect(classifyDrainError(503, undefined).kind).toBe('transient');
  });
});

const noFunctions = { functions: { invoke: async () => ({ data: null, error: new Error('unused') }) } };
const REQ = {
  case_id: 'c', task_id: 't', sha256: 'a'.repeat(64), ext: 'jpg', device_captured_at: '2026-11-14T00:00:00Z',
  size_bytes: 812_000, mime_type: 'image/jpeg',
};
/** FunctionsHttpError-like: `context` is the Response. */
const httpError = (status: number, body: unknown) => ({ name: 'FunctionsHttpError', context: { status, json: async () => body } });

describe('signedInServer', () => {
  it('calls post_thread_message and report_outbox_status with p_ arguments', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const s = signedInServer({
      ...noFunctions,
      rpc: async (fn, args) => {
        calls.push([fn, args]);
        return { data: fn === 'post_thread_message' ? 'm-1' : null, error: null };
      },
    });
    const id = await s.postMessage({ case_id: 'c', client_message_id: 'u', kind: 'media', body: null, task_id: 't', reply_to: null, items: [] });
    await s.reportOutbox({ device_id: 'd', pending_count: 2, pending_bytes: 9, oldest_pending_at: null });
    expect(id).toBe('m-1');
    expect(calls[0]).toEqual(['post_thread_message', {
      p_case_id: 'c', p_client_message_id: 'u', p_kind: 'media', p_body: null, p_task_id: 't', p_reply_to: null, p_items: [],
    }]);
    expect(calls[1]).toEqual(['report_outbox_status', { p_device_id: 'd', p_pending_count: 2, p_pending_bytes: 9, p_oldest_pending_at: null }]);
  });
  it('turns thrown network errors and rpc errors into ServerError', async () => {
    const s = signedInServer({ ...noFunctions, rpc: async () => ({ data: null, error: { code: '42501', hint: 'upload_window_closed' } }) });
    await expect(s.reportOutbox({ device_id: 'd', pending_count: 0, pending_bytes: 0, oldest_pending_at: null })).rejects.toMatchObject({ kind: 'window_closed' });
    const t = signedInServer({ ...noFunctions, rpc: () => Promise.reject(new Error('offline')) });
    await expect(t.reportOutbox({ device_id: 'd', pending_count: 0, pending_bytes: 0, oldest_pending_at: null })).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('evidence-upload presigner', () => {
  const rpc = async () => ({ data: null, error: null });
  const withReply = (reply: () => Promise<{ data: unknown; error: unknown }>) => {
    const sent: [string, Record<string, unknown>][] = [];
    const server = signedInServer({
      rpc,
      functions: { invoke: (fn, opts) => (sent.push([fn, opts.body]), reply()) },
    });
    return { server, sent };
  };

  it('invokes evidence-upload with one file and returns the signed PUT', async () => {
    const { server, sent } = withReply(async () => ({
      data: {
        ok: true, case_id: 'c',
        files: [{ sha256: REQ.sha256, status: 'upload', storage_path: `cases/c/tasks/t/${REQ.sha256}.jpg`, method: 'PUT',
                  url: 'https://acct.r2.cloudflarestorage.com/x', headers: { 'x-amz-content-sha256': REQ.sha256 }, expires_in: 600 }],
      },
      error: null,
    }));
    const p = await server.presign(REQ);
    expect(sent).toEqual([['evidence-upload', {
      task_id: 't', case_id: 'c',
      files: [{ sha256: REQ.sha256, size: 812_000, mime: 'image/jpeg', device_captured_at: '2026-11-14T00:00:00Z' }],
    }]]);
    expect(p).toEqual({
      storage_path: `cases/c/tasks/t/${REQ.sha256}.jpg`, url: 'https://acct.r2.cloudflarestorage.com/x',
      headers: { 'x-amz-content-sha256': REQ.sha256 },
    });
  });
  it('already_stored: no URL, the outbox skips the PUT', async () => {
    const { server } = withReply(async () => ({
      data: { ok: true, case_id: 'c', files: [{ sha256: REQ.sha256, status: 'already_stored', storage_path: 'cases/c/tasks/t/x.jpg' }] },
      error: null,
    }));
    expect(await server.presign(REQ)).toEqual({ storage_path: 'cases/c/tasks/t/x.jpg', url: '', headers: {}, already_stored: true });
  });
  it('maps HTTP errors to the outbox classes', async () => {
    const cases: [unknown, string, string][] = [
      [httpError(403, { ok: false, error: { code: 'upload_window_closed' } }), 'window_closed', 'upload_window_closed'],
      [httpError(401, { ok: false, error: { code: 'unauthorized' } }), 'auth', 'unauthorized'],
      [httpError(401, 'not json'), 'auth', 'unauthorized'],
      [httpError(403, { ok: false, error: { code: 'forbidden' } }), 'rejected', 'forbidden'],
      [httpError(400, { ok: false, error: { code: 'unsupported_type' } }), 'rejected', 'unsupported_type'],
      [httpError(413, { ok: false, error: { code: 'file_too_large' } }), 'rejected', 'file_too_large'],
      [httpError(502, { ok: false, error: { code: 'upstream_error' } }), 'transient', 'upstream_error'],
      [httpError(503, { ok: false, error: { code: 'storage_not_configured' } }), 'transient', 'storage_not_configured'],
      [{ name: 'FunctionsHttpError', context: { status: 500, json: () => Promise.reject(new Error('x')) } }, 'transient', 'http_500'],
      [{ name: 'FunctionsFetchError', context: new Error('offline') }, 'transient', 'network'],
    ];
    for (const [error, kind, code] of cases) {
      const { server } = withReply(async () => ({ data: null, error }));
      await expect(server.presign(REQ)).rejects.toMatchObject({ kind, code });
    }
  });
  it('a thrown invoke or a malformed reply is transient', async () => {
    await expect(withReply(() => Promise.reject(new Error('socket'))).server.presign(REQ)).rejects.toMatchObject({ kind: 'transient', code: 'network' });
    await expect(withReply(async () => ({ data: { ok: true, files: [] }, error: null })).server.presign(REQ))
      .rejects.toMatchObject({ kind: 'transient', code: 'bad_reply' });
    await expect(withReply(async () => ({ data: { ok: true, files: [{ sha256: REQ.sha256, status: 'upload', storage_path: 'p' }] }, error: null })).server.presign(REQ))
      .rejects.toMatchObject({ kind: 'transient', code: 'bad_reply' });
  });
  it('an explicit presigner still wins', async () => {
    const s = signedInServer({ ...noFunctions, rpc }, async () => ({ storage_path: 'p', url: 'u', headers: {} }));
    expect((await s.presign(REQ)).url).toBe('u');
  });
});

describe('drainServer', () => {
  it('posts the contract body without Authorization and maps replies', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const replies: [number, unknown][] = [
      [200, { ok: true, state: 'drain', deactivated_at: 'x', drain_until: 'y' }],
      [200, { ok: true, case_id: 'c', storage_path: 'cases/c/tasks/t/a.jpg', method: 'PUT', url: 'https://r2', headers: { 'x-amz-content-sha256': 'a' }, expires_in: 600 }],
      [422, { ok: false, error: { code: 'upload_window_closed', message: '' } }],
    ];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const [status, body] = replies.shift()!;
      return { status, json: async () => body };
    };
    const s = drainServer({ baseUrl: 'https://x.supabase.co', anonKey: 'anon', deviceId: 'd', secret: 'f'.repeat(64), fetch });
    expect(await s.status()).toEqual({ state: 'drain', deactivated_at: 'x', drain_until: 'y' });
    const p = await s.presign({ case_id: 'c', task_id: 't', sha256: 'a', ext: 'jpg', device_captured_at: '2026-11-14T00:00:00Z', size_bytes: 1, mime_type: 'image/jpeg' });
    expect(p.storage_path).toBe('cases/c/tasks/t/a.jpg');
    await expect(s.postMessage({ case_id: 'c', client_message_id: 'u', kind: 'media', body: null, task_id: 't', reply_to: null, items: [] }))
      .rejects.toMatchObject({ kind: 'window_closed' });
    await expect(s.postMessage({ case_id: 'c', client_message_id: 'u', kind: 'text', body: 'hi', task_id: null, reply_to: null, items: [] }))
      .rejects.toMatchObject({ kind: 'rejected' });
    expect(sent[0]!.url).toBe('https://x.supabase.co/functions/v1/field-drain');
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(sent[1]!.body).toEqual({ action: 'presign', device_id: 'd', secret: 'f'.repeat(64), task_id: 't', sha256: 'a', ext: 'jpg', device_captured_at: '2026-11-14T00:00:00Z' });
    expect(sent).toHaveLength(3);
  });
});

describe('device identity', () => {
  it('sha256 and uuid helpers', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(uuidV4(new Uint8Array(16).fill(255))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('creates once, stores the secret locally and registers only its hash', async () => {
    const mem = new Map<string, string>();
    const store: SecretStore = {
      getItem: async (k) => mem.get(k) ?? null,
      setItem: async (k, v) => void mem.set(k, v),
      deleteItem: async (k) => void mem.delete(k),
    };
    const calls: Record<string, unknown>[] = [];
    const client = { rpc: async (_fn: string, a: Record<string, unknown>) => (calls.push(a), { data: null, error: null }) };
    let b = 0;
    const rnd = (k: number) => Uint8Array.from({ length: k }, () => b++ & 255);
    const d1 = await ensureRegisteredDevice(store, client, rnd);
    const d2 = await ensureRegisteredDevice(store, client, rnd);
    expect(d2).toEqual(d1);
    expect(await loadDevice(store)).toEqual(d1);
    expect(calls[0]).toEqual({ p_device_id: d1.device_id, p_secret_sha256: sha256Hex(d1.secret), p_platform: 'android' });
    expect(JSON.stringify(calls)).not.toContain(d1.secret);
  });
});
