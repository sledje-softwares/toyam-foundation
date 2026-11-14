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

describe('signedInServer', () => {
  it('calls post_thread_message and report_outbox_status with p_ arguments', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const s = signedInServer({
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
    await expect(s.presign({ case_id: 'c', task_id: 't', sha256: 'a', ext: 'jpg', device_captured_at: '' })).rejects.toMatchObject({
      kind: 'transient', code: 'presigner_missing',
    });
  });
  it('turns thrown network errors and rpc errors into ServerError', async () => {
    const s = signedInServer({ rpc: async () => ({ data: null, error: { code: '42501', hint: 'upload_window_closed' } }) });
    await expect(s.reportOutbox({ device_id: 'd', pending_count: 0, pending_bytes: 0, oldest_pending_at: null })).rejects.toMatchObject({ kind: 'window_closed' });
    const t = signedInServer({ rpc: () => Promise.reject(new Error('offline')) });
    await expect(t.reportOutbox({ device_id: 'd', pending_count: 0, pending_bytes: 0, oldest_pending_at: null })).rejects.toMatchObject({ kind: 'transient' });
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
    const p = await s.presign({ case_id: 'c', task_id: 't', sha256: 'a', ext: 'jpg', device_captured_at: '2026-11-14T00:00:00Z' });
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
