/** Pure parts of the admin-users wrapper: types and error mapping (no server imports, unit-testable). */
export type AdminUserRole = "admin" | "orchestrator" | "office" | "field";

export type AdminUsersBody =
  | { action: "create"; full_name: string; role: AdminUserRole; region?: string; email?: string; phone?: string }
  | { action: "update_login"; user_id: string; email?: string; phone?: string }
  | { action: "reset_password"; user_id: string }
  | { action: "set_active"; user_id: string; active: boolean };

export type AdminUsersFailure = { ok: false; code: string; message: string; field?: string };
export type AdminUsersResult<T> = ({ ok: true } & T) | AdminUsersFailure;

export type CreateResult = { user_id: string; temporary_password?: string };
export type UpdateLoginResult = { user_id: string; email?: string; phone?: string };
export type ResetResult = { user_id: string; temporary_password: string };
export type SetActiveResult = { user_id: string; active: boolean };

export const GENERIC_FAILURE = "Nothing was saved. Try again.";

/** Wording by code where the function's own message is not the best text for this screen. */
const OVERRIDES: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  invalid_body: "Reload the page and try again.",
  invalid_action: "Reload the page and try again.",
  method_not_allowed: "Reload the page and try again.",
  password_not_used: "Field operators sign in with a code, so there is no password to reset.",
  sign_in_block_failed: "Access removed, but sign-in block failed. Try again.",
  auth_failed: GENERIC_FAILURE,
  internal: GENERIC_FAILURE,
};

const FIELDS = new Set(["full_name", "role", "region", "email", "phone", "user_id", "active"]);

/** Turns a function error body (or anything unexpected) into a readable message plus an optional form field. */
export function mapAdminUsersError(error: unknown): AdminUsersFailure {
  const e = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof e.code === "string" ? e.code : "internal";
  const given = typeof e.message === "string" && e.message.trim() ? e.message.trim() : null;
  const message = OVERRIDES[code] ?? given ?? GENERIC_FAILURE;
  const field = typeof e.field === "string" && FIELDS.has(e.field) ? e.field : undefined;
  return field ? { ok: false, code, message, field } : { ok: false, code, message };
}

/** Reads `{ ok, error }` from a parsed response body; success bodies are returned as they are. */
export function parseAdminUsersBody<T>(body: unknown): AdminUsersResult<T> {
  if (typeof body !== "object" || body === null) return mapAdminUsersError(null);
  const b = body as Record<string, unknown>;
  if (b.ok === true) return b as AdminUsersResult<T>;
  return mapAdminUsersError(b.error);
}

/** A non-2xx reply arrives as an error whose `context` is the Response; its JSON body has the real error. */
export async function readInvokeError(error: unknown): Promise<AdminUsersFailure> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      const body: unknown = await (ctx as Response).json();
      const r = parseAdminUsersBody<object>(body);
      if (!r.ok) return r;
    } catch {
      // not JSON: fall through
    }
  }
  return mapAdminUsersError(null);
}

