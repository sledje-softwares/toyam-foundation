// Request flow of the `admin-users` function (M2 T5, docs/08 §2.1.5) against an injected gateway,
// so the whole flow is tested from Node with fakes. The Deno entry point (../../admin-users/index.ts)
// wires the gateway to supabase-js: caller-scoped client for the JWT, is_admin() and profiles;
// service client only for the auth admin API and audit_log, and only after authorisation.
import {
  type AdminRequest,
  type AuthErrorLike,
  authorize,
  type DbErrorLike,
  type Failure,
  type FieldSignIn,
  fail,
  generateTemporaryPassword,
  loginRequirements,
  mapAuthError,
  mapDbError,
  parseRequest,
  type Role,
} from './logic.ts';

export interface ProfileRow {
  id: string;
  full_name: string;
  role: Role;
  is_active: boolean;
}

export interface AuthAttrs {
  email?: string;
  email_confirm?: boolean;
  phone?: string;
  phone_confirm?: boolean;
  password?: string;
  ban_duration?: string;
  app_metadata?: Record<string, unknown>;
}

export interface AuditRow {
  actor_id: string;
  action: 'ADMIN_CREATE_USER' | 'ADMIN_UPDATE_LOGIN' | 'ADMIN_RESET_PASSWORD' | 'ADMIN_SET_ACTIVE';
  table_name: 'auth.users';
  record_id: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown>;
}

export interface Gateway {
  /** Verify the caller's JWT with the auth server; caller's user id or null. */
  verifyCaller(): Promise<string | null>;
  /** `rpc('is_admin')` with the caller's client (true only for an active admin). */
  callerIsActiveAdmin(): Promise<boolean>;
  /** Caller's client (RLS: admins read every profile). */
  getProfile(id: string): Promise<ProfileRow | null>;
  /** Full name of the profile holding this number (any stored form), for the duplicate message. */
  findPhoneOwner(variants: string[]): Promise<string | null>;
  /** Caller's client: `update profiles set is_active` returning the rows changed (audited with actor). */
  setProfileActive(id: string, active: boolean): Promise<{ rows: number; error: DbErrorLike | null }>;
  /** Service client, auth admin API. */
  createAuthUser(attrs: AuthAttrs): Promise<{ id: string | null; error: AuthErrorLike | null }>;
  updateAuthUser(id: string, attrs: AuthAttrs): Promise<{ error: AuthErrorLike | null }>;
  getAuthUser(id: string): Promise<{ email: string | null; phone: string | null } | null>;
  /** Service client insert into audit_log. Must never receive a password. */
  writeAudit(row: AuditRow): Promise<{ error: unknown }>;
  /** Error log without secrets (code / ids only). */
  logError(msg: string): void;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const BAN_FOREVER = '876000h';
const ok = (data: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...data } });
const err = (f: Failure): Reply => ({ status: f.status, body: { ok: false, error: f.error } });

export async function handleAdminUsers(
  method: string,
  hasAuthHeader: boolean,
  bodyText: string,
  gw: Gateway,
  fieldSignIn: FieldSignIn,
): Promise<Reply> {
  if (method !== 'POST') return err(fail(405, 'method_not_allowed', 'Use POST.'));
  if (!hasAuthHeader) return err(fail(401, 'unauthenticated', 'Sign in again.'));

  // 1. Caller: verified JWT + active admin, before any service-role call.
  const callerId = await gw.verifyCaller();
  if (!callerId) return err(authorize(null, false, null)!);
  const isAdmin = await gw.callerIsActiveAdmin();
  const denied = authorize(callerId, isAdmin, null);
  if (denied) return err(denied);

  // 2. Validate.
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return err(fail(400, 'invalid_body', 'Send a JSON object.'));
  }
  const parsed = parseRequest(body, fieldSignIn);
  if (!parsed.ok) return err(parsed.failure);
  const req = parsed.value;
  const selfDenied = authorize(callerId, isAdmin, req);
  if (selfDenied) return err(selfDenied);

  return run(req, callerId, gw, fieldSignIn);
}

async function audit(gw: Gateway, row: AuditRow): Promise<void> {
  const { error } = await gw.writeAudit(row);
  if (error) gw.logError(`audit_log insert failed for ${row.action} ${row.record_id}`);
}

async function authFailure(gw: Gateway, e: AuthErrorLike, phone: string | undefined | null): Promise<Reply> {
  let owner: string | null = null;
  const f0 = mapAuthError(e);
  if (f0.error.field === 'phone' && f0.error.code === 'duplicate' && phone) {
    owner = await gw.findPhoneOwner([phone, phone.replace(/^\+/, '')]);
  }
  const f = mapAuthError(e, owner);
  if (f.status >= 500) gw.logError(`auth admin error: ${e.code ?? e.status ?? 'unknown'}`);
  return err(f);
}

async function run(req: AdminRequest, callerId: string, gw: Gateway, fieldSignIn: FieldSignIn): Promise<Reply> {
  switch (req.action) {
    case 'create': {
      const needsPassword = loginRequirements(req.role, fieldSignIn).password;
      const password = needsPassword ? generateTemporaryPassword() : undefined;
      const attrs: AuthAttrs = {
        app_metadata: { role: req.role, full_name: req.full_name, ...(req.region ? { region: req.region } : {}) },
      };
      if (req.email) Object.assign(attrs, { email: req.email, email_confirm: true });
      if (req.phone) Object.assign(attrs, { phone: req.phone, phone_confirm: true });
      if (password) attrs.password = password;
      const { id, error } = await gw.createAuthUser(attrs);
      if (error || !id) return authFailure(gw, error ?? {}, req.phone);
      await audit(gw, {
        actor_id: callerId,
        action: 'ADMIN_CREATE_USER',
        table_name: 'auth.users',
        record_id: id,
        old_data: null,
        new_data: {
          full_name: req.full_name, role: req.role, region: req.region,
          email: req.email, phone: req.phone, temporary_password_issued: !!password,
        },
      });
      return ok(password ? { user_id: id, temporary_password: password } : { user_id: id });
    }

    case 'update_login': {
      const profile = await gw.getProfile(req.user_id);
      if (!profile) return err(fail(404, 'not_found', 'User not found.'));
      const before = await gw.getAuthUser(req.user_id);
      const attrs: AuthAttrs = {};
      if (req.email) Object.assign(attrs, { email: req.email, email_confirm: true });
      if (req.phone) Object.assign(attrs, { phone: req.phone, phone_confirm: true });
      const { error } = await gw.updateAuthUser(req.user_id, attrs);
      if (error) return authFailure(gw, error, req.phone);
      const changed: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      if (req.email) { changed.email = req.email; previous.email = before?.email ?? null; }
      if (req.phone) { changed.phone = req.phone; previous.phone = before?.phone ?? null; }
      await audit(gw, {
        actor_id: callerId, action: 'ADMIN_UPDATE_LOGIN', table_name: 'auth.users',
        record_id: req.user_id, old_data: previous, new_data: changed,
      });
      return ok({ user_id: req.user_id, ...changed });
    }

    case 'reset_password': {
      const profile = await gw.getProfile(req.user_id);
      if (!profile) return err(fail(404, 'not_found', 'User not found.'));
      if (!loginRequirements(profile.role, fieldSignIn).password) {
        return err(fail(400, 'password_not_used', 'Field operators sign in with a one-time code; there is no password to reset.'));
      }
      const password = generateTemporaryPassword();
      const { error } = await gw.updateAuthUser(req.user_id, { password });
      if (error) return authFailure(gw, error, null);
      await audit(gw, {
        actor_id: callerId, action: 'ADMIN_RESET_PASSWORD', table_name: 'auth.users',
        record_id: req.user_id, old_data: null, new_data: { temporary_password_issued: true },
      });
      return ok({ user_id: req.user_id, temporary_password: password });
    }

    case 'set_active': {
      // Step 1: profile with the caller's client (RLS as admin; DB2 last-admin trigger; row audit with actor).
      const r = await gw.setProfileActive(req.user_id, req.active);
      if (r.error) {
        const f = mapDbError(r.error);
        if (f.status >= 500) gw.logError(`profiles update failed: ${r.error.code ?? 'unknown'}`);
        return err(f);
      }
      if (r.rows === 0) return err(fail(404, 'not_found', 'User not found.'));
      // Step 2: sign-in block (ends session refresh = remote sign-out). Idempotent; safe to retry.
      const { error } = await gw.updateAuthUser(req.user_id, { ban_duration: req.active ? 'none' : BAN_FOREVER });
      await audit(gw, {
        actor_id: callerId, action: 'ADMIN_SET_ACTIVE', table_name: 'auth.users', record_id: req.user_id,
        old_data: null,
        new_data: { is_active: req.active, sign_in_blocked: error ? 'failed' : !req.active },
      });
      if (error) {
        gw.logError(`ban update failed: ${error.code ?? error.status ?? 'unknown'}`);
        return err(fail(502, 'sign_in_block_failed', req.active
          ? 'Access restored, but sign-in could not be unblocked. Try again.'
          : 'Access removed, but sign-in block failed. Try again.'));
      }
      return ok({ user_id: req.user_id, active: req.active });
    }
  }
}
