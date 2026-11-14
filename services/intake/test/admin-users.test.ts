// admin-users edge function (M2 T5): pure logic + request flow against a fake gateway.
// Lives here because this workspace runs the Node tests for supabase/functions/_shared.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authorize, generateTemporaryPassword, mapAuthError, mapDbError, normaliseEmail, normalisePhone,
  normaliseRegion, PASSWORD_ALPHABET, parseFieldSignIn, parseRequest,
} from '../../../supabase/functions/_shared/admin-users/logic.ts';
import { type AuditRow, type AuthAttrs, type Gateway, handleAdminUsers, type ProfileRow } from '../../../supabase/functions/_shared/admin-users/handler.ts';

const ADMIN = 'a0000000-0000-4000-8000-000000000001';
const OFFICE = 'a0000000-0000-4000-8000-000000000003';
const FIELD = 'a0000000-0000-4000-8000-000000000004';
const NEW = 'b0000000-0000-4000-8000-000000000009';

describe('normalisation', () => {
  it('normalises Indian mobiles to +91 E.164', () => {
    for (const raw of ['98000 00001', '+91 98000-00001', '919800000001', '09800000001', '(98000) 00001']) {
      assert.equal(normalisePhone(raw), '+919800000001', raw);
    }
    for (const raw of ['5800000001', '98000', '+1 9800000001', '980000000123', 'abc']) {
      assert.equal(normalisePhone(raw), null, raw);
    }
  });
  it('lower-cases email, rejects malformed', () => {
    assert.equal(normaliseEmail('  Asha@Firm.IN '), 'asha@firm.in');
    assert.equal(normaliseEmail('asha@firm'), null);
    assert.equal(normaliseEmail('a b@firm.in'), null);
  });
  it('title-cases region', () => {
    assert.equal(normaliseRegion('  pune   city '), 'Pune City');
    assert.equal(normaliseRegion('NAVI-mumbai'), 'Navi-Mumbai');
  });
  it('FIELD_SIGN_IN defaults to mobile_password', () => {
    assert.equal(parseFieldSignIn(undefined), 'mobile_password');
    assert.equal(parseFieldSignIn('bogus'), 'mobile_password');
    assert.equal(parseFieldSignIn('mobile_otp'), 'mobile_otp');
  });
});

describe('parseRequest', () => {
  const field = { action: 'create', full_name: ' Farid Khan ', role: 'field', region: 'pune', phone: '98000 00001' };
  it('create field operator: phone required, email optional (mobile_password)', () => {
    const r = parseRequest(field, 'mobile_password');
    assert.ok(r.ok);
    assert.deepEqual(r.value, { action: 'create', full_name: 'Farid Khan', role: 'field', region: 'Pune', email: null, phone: '+919800000001' });
    const noPhone = parseRequest({ ...field, phone: '' }, 'mobile_password');
    assert.ok(!noPhone.ok && noPhone.failure.error.field === 'phone');
  });
  it('create field operator: email required under email_password', () => {
    const r = parseRequest(field, 'email_password');
    assert.ok(!r.ok && r.failure.error.field === 'email');
  });
  it('create: region required for field, email required for staff, role checked', () => {
    const r1 = parseRequest({ ...field, region: ' ' }, 'mobile_password');
    assert.ok(!r1.ok && r1.failure.error.field === 'region');
    const r2 = parseRequest({ action: 'create', full_name: 'Uma', role: 'office' }, 'mobile_password');
    assert.ok(!r2.ok && r2.failure.error.field === 'email' && r2.failure.status === 400);
    const r3 = parseRequest({ ...field, role: 'superuser' }, 'mobile_password');
    assert.ok(!r3.ok && r3.failure.error.field === 'role');
    const r4 = parseRequest({ ...field, full_name: 'F' }, 'mobile_password');
    assert.ok(!r4.ok && r4.failure.error.field === 'full_name');
    const r5 = parseRequest({ ...field, phone: '12345' }, 'mobile_password');
    assert.ok(!r5.ok && r5.failure.error.message === 'Enter a 10-digit Indian mobile number.');
  });
  it('update_login needs a valid user_id and at least one detail', () => {
    assert.ok(!parseRequest({ action: 'update_login', user_id: 'x', email: 'a@b.in' }, 'mobile_password').ok);
    const none = parseRequest({ action: 'update_login', user_id: FIELD }, 'mobile_password');
    assert.ok(!none.ok && none.failure.error.code === 'invalid_input');
    const r = parseRequest({ action: 'update_login', user_id: FIELD, phone: '9800000002' }, 'mobile_password');
    assert.ok(r.ok);
    assert.deepEqual(r.value, { action: 'update_login', user_id: FIELD, phone: '+919800000002' });
  });
  it('set_active needs a boolean; unknown action rejected', () => {
    assert.ok(!parseRequest({ action: 'set_active', user_id: FIELD, active: 'false' }, 'mobile_password').ok);
    const r = parseRequest({ action: 'delete', user_id: FIELD }, 'mobile_password');
    assert.ok(!r.ok && r.failure.error.code === 'invalid_action');
    const b = parseRequest([1], 'mobile_password');
    assert.ok(!b.ok && b.failure.error.code === 'invalid_body');
  });
});

describe('authorize', () => {
  const deact = { action: 'set_active' as const, user_id: ADMIN, active: false };
  it('401 without a verified caller, 403 for non-admin, 403 self-deactivate', () => {
    assert.equal(authorize(null, false, null)?.status, 401);
    assert.equal(authorize(OFFICE, false, null)?.error.code, 'forbidden');
    assert.equal(authorize(ADMIN, true, deact)?.error.code, 'self_deactivate');
    assert.equal(authorize(ADMIN, true, { ...deact, active: true }), null);
    assert.equal(authorize(ADMIN, true, { ...deact, user_id: FIELD }), null);
  });
});

describe('temporary password', () => {
  it('xxxx-xxxx-xxxx, unambiguous alphabet, upper + lower + digit, meets auth policy', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      assert.match(p, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      assert.ok(!/[0O1lI]/.test(p));
      assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p));
      for (const ch of p.replace(/-/g, '')) assert.ok(PASSWORD_ALPHABET.includes(ch));
    }
  });
  it('rejects samples above the unbiased limit and retries missing classes', () => {
    let calls = 0;
    // First fill: all max (rejected) → second: only 'A' (no lower/digit) → then a mix.
    const p = generateTemporaryPassword((buf) => {
      calls++;
      buf.fill(calls === 1 ? 0xffffffff : calls === 2 ? 0 : 0);
      if (calls >= 3) for (let i = 0; i < buf.length; i++) buf[i] = [0, 24, 49][i % 3];
      return buf;
    });
    assert.equal(p, 'Aa2A-a2Aa-2Aa2');
    assert.ok(calls >= 3);
  });
});

describe('error mapping', () => {
  it('duplicates → 409 with field; phone message names the owner', () => {
    const ph = mapAuthError({ code: 'phone_exists', status: 422 }, 'Vijay More');
    assert.deepEqual(ph, { status: 409, error: { code: 'duplicate', message: 'This mobile number is already used by Vijay More.', field: 'phone' } });
    const em = mapAuthError({ status: 422, message: 'A user with this email address has already been registered' });
    assert.equal(em.error.field, 'email');
    assert.equal(mapAuthError({ code: 'user_not_found', status: 404 }).status, 404);
    assert.equal(mapAuthError({ code: 'unexpected_failure', status: 500 }).status, 502);
  });
  it('DB2 last-admin trigger → 409 last_admin; other 42501 → 403', () => {
    assert.equal(mapDbError({ code: '42501', message: 'There must be at least one active admin' }).error.code, 'last_admin');
    assert.equal(mapDbError({ code: '42501', message: 'permission denied' }).status, 403);
  });
});

// ---------------------------------------------------------------------
// Flow with a fake gateway
// ---------------------------------------------------------------------

interface Fake extends Gateway {
  audits: AuditRow[];
  created: AuthAttrs[];
  updates: Array<{ id: string; attrs: AuthAttrs }>;
  serviceCalls: number;
  logs: string[];
}

function fake(opts: {
  caller?: string | null;
  admin?: boolean;
  profiles?: ProfileRow[];
  createError?: { code?: string; status?: number; message?: string };
  updateError?: { code?: string; status?: number };
  activeError?: { code?: string; message?: string };
} = {}): Fake {
  const profiles = opts.profiles ?? [
    { id: ADMIN, full_name: 'Asha Admin', role: 'admin', is_active: true },
    { id: FIELD, full_name: 'Vijay More', role: 'field', is_active: true },
  ];
  const g: Fake = {
    audits: [], created: [], updates: [], serviceCalls: 0, logs: [],
    verifyCaller: async () => (opts.caller === undefined ? ADMIN : opts.caller),
    callerIsActiveAdmin: async () => opts.admin ?? true,
    getProfile: async (id) => profiles.find((p) => p.id === id) ?? null,
    findPhoneOwner: async () => 'Vijay More',
    setProfileActive: async (id) =>
      opts.activeError ? { rows: 0, error: opts.activeError } : { rows: profiles.some((p) => p.id === id) ? 1 : 0, error: null },
    createAuthUser: async (attrs) => {
      g.serviceCalls++;
      g.created.push(attrs);
      return opts.createError ? { id: null, error: opts.createError } : { id: NEW, error: null };
    },
    updateAuthUser: async (id, attrs) => {
      g.serviceCalls++;
      g.updates.push({ id, attrs });
      return { error: opts.updateError ?? null };
    },
    getAuthUser: async () => { g.serviceCalls++; return { email: null, phone: '919800000001' }; },
    writeAudit: async (row) => { g.serviceCalls++; g.audits.push(row); return { error: null }; },
    logError: (m) => { g.logs.push(m); },
  };
  return g;
}

const call = (g: Gateway, body: unknown, fs: 'mobile_password' | 'mobile_otp' = 'mobile_password') =>
  handleAdminUsers('POST', true, JSON.stringify(body), g, fs);
const createField = { action: 'create', full_name: 'Farid Khan', role: 'field', region: 'Pune', phone: '98000 00005' };

describe('handleAdminUsers', () => {
  it('405 / 401 / 403 before any service-role call', async () => {
    const g = fake();
    assert.equal((await handleAdminUsers('GET', true, '', g, 'mobile_password')).status, 405);
    assert.equal((await handleAdminUsers('POST', false, '{}', g, 'mobile_password')).status, 401);
    const bad = fake({ caller: null });
    assert.equal((await call(bad, createField)).status, 401);
    const office = fake({ caller: OFFICE, admin: false });
    const r = await call(office, createField);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, error: { code: 'forbidden', message: 'Only an active admin can do this.' } });
    assert.equal(office.serviceCalls + bad.serviceCalls + g.serviceCalls, 0);
  });

  it('create field operator: confirmed phone, app_metadata, password returned once, audit without password', async () => {
    const g = fake();
    const r = await call(g, createField);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.user_id, NEW);
    const pw = r.body.temporary_password as string;
    assert.match(pw, /^.{4}-.{4}-.{4}$/);
    assert.deepEqual(g.created[0], {
      app_metadata: { role: 'field', full_name: 'Farid Khan', region: 'Pune' },
      phone: '+919800000005', phone_confirm: true, password: pw,
    });
    assert.equal(g.audits.length, 1);
    assert.equal(g.audits[0].action, 'ADMIN_CREATE_USER');
    assert.equal(g.audits[0].actor_id, ADMIN);
    assert.equal(g.audits[0].record_id, NEW);
    assert.ok(!JSON.stringify(g.audits).includes(pw));
    assert.ok(!g.logs.join().includes(pw));
  });

  it('create field operator under mobile_otp: no password', async () => {
    const g = fake();
    const r = await call(g, createField, 'mobile_otp');
    assert.equal(r.status, 200);
    assert.equal(r.body.temporary_password, undefined);
    assert.equal(g.created[0].password, undefined);
  });

  it('duplicate mobile → 409 field phone naming the owner; nothing audited', async () => {
    const g = fake({ createError: { code: 'phone_exists', status: 422 } });
    const r = await call(g, createField);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error, { code: 'duplicate', message: 'This mobile number is already used by Vijay More.', field: 'phone' });
    assert.equal(g.audits.length, 0);
  });

  it('update_login: confirmed new phone, old values audited', async () => {
    const g = fake();
    const r = await call(g, { action: 'update_login', user_id: FIELD, phone: '9800000006' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, user_id: FIELD, phone: '+919800000006' });
    assert.deepEqual(g.updates[0], { id: FIELD, attrs: { phone: '+919800000006', phone_confirm: true } });
    assert.deepEqual(g.audits[0].old_data, { phone: '919800000001' });
    assert.equal((await call(fake(), { action: 'update_login', user_id: NEW, phone: '9800000006' })).status, 404);
  });

  it('reset_password: new password; 400 for a field user under mobile_otp', async () => {
    const g = fake();
    const r = await call(g, { action: 'reset_password', user_id: FIELD });
    assert.equal(r.status, 200);
    assert.equal(g.updates[0].attrs.password, r.body.temporary_password);
    assert.equal(g.audits[0].action, 'ADMIN_RESET_PASSWORD');
    assert.ok(!JSON.stringify(g.audits).includes(r.body.temporary_password as string));
    const otp = await call(fake(), { action: 'reset_password', user_id: FIELD }, 'mobile_otp');
    assert.equal(otp.status, 400);
    assert.equal((otp.body.error as { code: string }).code, 'password_not_used');
  });

  it('set_active: profile first, then ban / unban; audited', async () => {
    const g = fake();
    const off = await call(g, { action: 'set_active', user_id: FIELD, active: false });
    assert.deepEqual(off.body, { ok: true, user_id: FIELD, active: false });
    assert.deepEqual(g.updates[0].attrs, { ban_duration: '876000h' });
    await call(g, { action: 'set_active', user_id: FIELD, active: true });
    assert.deepEqual(g.updates[1].attrs, { ban_duration: 'none' });
    assert.deepEqual(g.audits.map((a) => a.new_data), [
      { is_active: false, sign_in_blocked: true }, { is_active: true, sign_in_blocked: false },
    ]);
  });

  it('set_active: self → 403, last admin → 409, unknown → 404, ban failure → 502', async () => {
    const self = fake();
    const r1 = await call(self, { action: 'set_active', user_id: ADMIN, active: false });
    assert.equal((r1.body.error as { code: string }).code, 'self_deactivate');
    assert.equal(self.serviceCalls, 0);
    const last = fake({ activeError: { code: '42501', message: 'There must be at least one active admin' } });
    const r2 = await call(last, { action: 'set_active', user_id: FIELD, active: false });
    assert.equal(r2.status, 409);
    assert.equal((r2.body.error as { code: string }).code, 'last_admin');
    assert.equal(last.updates.length, 0);
    assert.equal((await call(fake(), { action: 'set_active', user_id: NEW, active: false })).status, 404);
    const ban = fake({ updateError: { status: 500 } });
    const r3 = await call(ban, { action: 'set_active', user_id: FIELD, active: false });
    assert.equal(r3.status, 502);
    assert.equal((r3.body.error as { code: string }).code, 'sign_in_block_failed');
    assert.deepEqual(ban.audits[0].new_data, { is_active: false, sign_in_blocked: 'failed' });
  });

  it('invalid JSON → 400 invalid_body', async () => {
    const r = await handleAdminUsers('POST', true, '{', fake(), 'mobile_password');
    assert.equal(r.status, 400);
  });
});
