// Pure logic of the `admin-users` function (M2 T5, docs/08 §2.1.5): validation and normalisation,
// temporary passwords, the authorise decision and error mapping. No I/O, no npm imports:
// runs in Deno (edge function) and in Node's type stripping (services/intake/test/admin-users.test.ts).

export type Role = 'admin' | 'orchestrator' | 'office' | 'field';
export const ROLES: readonly Role[] = ['admin', 'orchestrator', 'office', 'field'];

/** How field operators sign in (K4). Function secret `FIELD_SIGN_IN`; mirrors `lib/auth-config.ts`. */
export type FieldSignIn = 'mobile_password' | 'mobile_otp' | 'email_password';
export function parseFieldSignIn(v: string | undefined | null): FieldSignIn {
  return v === 'mobile_otp' || v === 'email_password' ? v : 'mobile_password';
}

export type ErrorCode =
  | 'method_not_allowed'
  | 'invalid_body'
  | 'invalid_action'
  | 'invalid_input'
  | 'unauthenticated'
  | 'forbidden'
  | 'self_deactivate'
  | 'not_found'
  | 'password_not_used'
  | 'duplicate'
  | 'last_admin'
  | 'sign_in_block_failed'
  | 'auth_failed'
  | 'internal';

export interface ApiError {
  code: ErrorCode;
  message: string;
  field?: string;
}
export interface Failure {
  status: number;
  error: ApiError;
}
export function fail(status: number, code: ErrorCode, message: string, field?: string): Failure {
  return { status, error: field ? { code, message, field } : { code, message } };
}

// ---------------------------------------------------------------------
// Field normalisation (same rules as the Add user form, docs/08 §2.1.2)
// ---------------------------------------------------------------------

export const PHONE_MESSAGE = 'Enter a 10-digit Indian mobile number.';

/** Indian mobile → E.164 `+91XXXXXXXXXX`, or null if invalid. Accepts spaces, dashes, dots,
 *  brackets, a leading 0, `91` or `+91`. */
export function normalisePhone(raw: string): string | null {
  let d = raw.trim().replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) {
    if (!d.startsWith('+91')) return null;
    d = d.slice(3);
  } else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

/** Forms of one number as auth may store it (GoTrue drops the `+`). */
export function phoneVariants(e164: string): string[] {
  return [e164, e164.replace(/^\+/, '')];
}

export function normaliseEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e) ? e : null;
}

/** Trim, collapse spaces, title case ("pune city" → "Pune City"). */
export function normaliseRegion(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

export interface CreateRequest {
  action: 'create';
  full_name: string;
  role: Role;
  region: string | null;
  email: string | null;
  phone: string | null;
}
export interface UpdateLoginRequest {
  action: 'update_login';
  user_id: string;
  email?: string;
  phone?: string;
}
export interface ResetPasswordRequest {
  action: 'reset_password';
  user_id: string;
}
export interface SetActiveRequest {
  action: 'set_active';
  user_id: string;
  active: boolean;
}
export type AdminRequest = CreateRequest | UpdateLoginRequest | ResetPasswordRequest | SetActiveRequest;

type Parsed<T> = { ok: true; value: T } | { ok: false; failure: Failure };
const bad = (message: string, field?: string): { ok: false; failure: Failure } => ({
  ok: false,
  failure: fail(400, 'invalid_input', message, field),
});

function optString(body: Record<string, unknown>, key: string): string | null | undefined | false {
  const v = body[key];
  if (v === undefined || v === null) return v as undefined | null;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Whether a role needs a password / email / phone under the field sign-in method. */
export function loginRequirements(role: Role, fieldSignIn: FieldSignIn): {
  email: boolean;
  phone: boolean;
  password: boolean;
} {
  if (role !== 'field') return { email: true, phone: false, password: true };
  return { email: fieldSignIn === 'email_password', phone: true, password: fieldSignIn !== 'mobile_otp' };
}

export function parseRequest(body: unknown, fieldSignIn: FieldSignIn): Parsed<AdminRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  const action = b.action;

  const userId = (): Parsed<string> =>
    typeof b.user_id === 'string' && UUID.test(b.user_id)
      ? { ok: true, value: b.user_id.toLowerCase() }
      : bad('A valid user_id is required.', 'user_id');

  const email = (): Parsed<string | null | undefined> => {
    const v = optString(b, 'email');
    if (v === false) return bad('Enter a valid email address.', 'email');
    if (v == null) return { ok: true, value: v };
    const e = normaliseEmail(v);
    return e ? { ok: true, value: e } : bad('Enter a valid email address.', 'email');
  };
  const phone = (): Parsed<string | null | undefined> => {
    const v = optString(b, 'phone');
    if (v === false) return bad(PHONE_MESSAGE, 'phone');
    if (v == null) return { ok: true, value: v };
    const p = normalisePhone(v);
    return p ? { ok: true, value: p } : bad(PHONE_MESSAGE, 'phone');
  };

  switch (action) {
    case 'create': {
      const name = optString(b, 'full_name');
      if (!name || name.length < 2 || name.length > 80) {
        return bad('Enter a name of 2 to 80 characters.', 'full_name');
      }
      if (typeof b.role !== 'string' || !(ROLES as readonly string[]).includes(b.role)) {
        return bad('Choose a role.', 'role');
      }
      const role = b.role as Role;
      const rawRegion = optString(b, 'region');
      if (rawRegion === false) return bad('Region must be text.', 'region');
      const region = rawRegion ? normaliseRegion(rawRegion) : null;
      if (region && region.length > 60) return bad('Region can be at most 60 characters.', 'region');
      if (role === 'field' && !region) return bad('Region is required for a field operator.', 'region');
      const e = email();
      if (!e.ok) return e;
      const p = phone();
      if (!p.ok) return p;
      const need = loginRequirements(role, fieldSignIn);
      if (need.phone && !p.value) return bad('A mobile number is required for a field operator.', 'phone');
      if (need.email && !e.value) {
        return bad(role === 'field' ? 'An email is required for a field operator.' : 'An email is required for staff.', 'email');
      }
      return {
        ok: true,
        value: { action, full_name: name, role, region, email: e.value ?? null, phone: p.value ?? null },
      };
    }
    case 'update_login': {
      const id = userId();
      if (!id.ok) return id;
      const e = email();
      if (!e.ok) return e;
      const p = phone();
      if (!p.ok) return p;
      // Omitted / null / empty = unchanged. Removing a sign-in detail is not supported.
      if (!e.value && !p.value) return bad('Give a new email and/or mobile number.');
      const r: UpdateLoginRequest = { action, user_id: id.value };
      if (e.value) r.email = e.value;
      if (p.value) r.phone = p.value;
      return { ok: true, value: r };
    }
    case 'reset_password': {
      const id = userId();
      return id.ok ? { ok: true, value: { action, user_id: id.value } } : id;
    }
    case 'set_active': {
      const id = userId();
      if (!id.ok) return id;
      if (typeof b.active !== 'boolean') return bad('active must be true or false.', 'active');
      return { ok: true, value: { action, user_id: id.value, active: b.active } };
    }
    default:
      return {
        ok: false,
        failure: fail(400, 'invalid_action', 'action must be create, update_login, reset_password or set_active.'),
      };
  }
}

// ---------------------------------------------------------------------
// Authorise (after the JWT is verified and is_admin() is known)
// ---------------------------------------------------------------------

export function authorize(callerId: string | null, callerIsActiveAdmin: boolean, req: AdminRequest | null): Failure | null {
  if (!callerId) return fail(401, 'unauthenticated', 'Sign in again.');
  if (!callerIsActiveAdmin) return fail(403, 'forbidden', 'Only an active admin can do this.');
  if (req && req.action === 'set_active' && !req.active && req.user_id === callerId.toLowerCase()) {
    return fail(403, 'self_deactivate', "You can't deactivate yourself.");
  }
  return null;
}

// ---------------------------------------------------------------------
// Temporary passwords: 12 chars, unambiguous alphabet, >= 1 upper/lower/digit, shown as xxxx-xxxx-xxxx
// ---------------------------------------------------------------------

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const DIGITS = '23456789'; // no 0, 1
export const PASSWORD_ALPHABET = UPPER + LOWER + DIGITS;

export type RandomFill = (buf: Uint32Array) => Uint32Array;
const cryptoFill: RandomFill = (buf) => globalThis.crypto.getRandomValues(buf);

export function generateTemporaryPassword(fill: RandomFill = cryptoFill): string {
  const n = PASSWORD_ALPHABET.length;
  const limit = Math.floor(0x1_0000_0000 / n) * n; // rejection sampling: no modulo bias
  for (;;) {
    let out = '';
    const buf = new Uint32Array(32);
    while (out.length < 12) {
      fill(buf);
      for (const x of buf) {
        if (x < limit && out.length < 12) out += PASSWORD_ALPHABET[x % n];
      }
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /\d/.test(out)) {
      return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
    }
  }
}

// ---------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------

export interface AuthErrorLike {
  code?: string;
  status?: number;
  message?: string;
}

/** Map an auth admin API error. `phoneOwner` names the user already holding the number, if known. */
export function mapAuthError(err: AuthErrorLike, phoneOwner?: string | null): Failure {
  const code = err.code ?? '';
  const msg = (err.message ?? '').toLowerCase();
  // On admin updates GoTrue surfaces the raw unique violation: code 23505,
  // 'duplicate key value violates unique constraint "users_phone_key"' (or users_email_partial_key).
  const uniqueViolation = code === '23505' || /duplicate key/.test(msg);
  if (uniqueViolation && /phone/.test(msg)) {
    return fail(409, 'duplicate',
      phoneOwner ? `This mobile number is already used by ${phoneOwner}.` : 'This mobile number is already used by another user.',
      'phone');
  }
  if (uniqueViolation && /email/.test(msg)) {
    return fail(409, 'duplicate', 'This email is already used by another user.', 'email');
  }
  if (code === 'phone_exists' || (/phone/.test(msg) && /already|exists|registered/.test(msg))) {
    return fail(409, 'duplicate',
      phoneOwner ? `This mobile number is already used by ${phoneOwner}.` : 'This mobile number is already used by another user.',
      'phone');
  }
  if (code === 'email_exists' || (/email/.test(msg) && /already|exists|registered/.test(msg))) {
    return fail(409, 'duplicate', 'This email is already used by another user.', 'email');
  }
  if (code === 'user_not_found' || err.status === 404) return fail(404, 'not_found', 'User not found.');
  if (code === 'validation_failed' && /phone/.test(msg)) return fail(400, 'invalid_input', PHONE_MESSAGE, 'phone');
  if (code === 'email_address_invalid' || (code === 'validation_failed' && /email/.test(msg))) {
    return fail(400, 'invalid_input', 'Enter a valid email address.', 'email');
  }
  return fail(502, 'auth_failed', 'The sign-in service did not accept the change. Nothing was saved. Try again.');
}

export interface DbErrorLike {
  code?: string;
  message?: string;
}

/** Map a PostgREST error from the caller's client. DB2 raises 42501 'There must be at least one active admin'. */
export function mapDbError(err: DbErrorLike): Failure {
  if (/at least one active admin/i.test(err.message ?? '')) {
    return fail(409, 'last_admin', 'There must be at least one active admin.');
  }
  if (err.code === '42501') return fail(403, 'forbidden', 'Only an active admin can do this.');
  return fail(502, 'internal', 'The change was not saved. Try again.');
}
