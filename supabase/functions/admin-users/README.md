# `admin-users` edge function (M2 T5)

Sign-in-level user administration (docs/08 §2.1.5, K2–K5). Profile-only edits (name, role, region) are
**not** here: they are plain RLS updates on `profiles` from the web app.

- Code: `index.ts` (Deno wiring), `../_shared/admin-users/logic.ts` (validation, passwords, error mapping,
  authorise decision), `../_shared/admin-users/handler.ts` (request flow against an injected gateway).
- Tests (Node): `services/intake/test/admin-users.test.ts` — `npm test -w services/intake`.
- Config: `[functions.admin-users] verify_jwt = true` in `supabase/config.toml`. Secret `FIELD_SIGN_IN`
  = `mobile_password` (default, also for unknown values) | `mobile_otp` | `email_password`; keep it equal
  to `lib/auth-config.ts` in the web app. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  come from the platform.

## Calling it

From a Next.js server action with the signed-in user's session:
`supabase.functions.invoke('admin-users', { body })` (attaches `Authorization: Bearer <access token>`).
`POST` only, JSON body `{ action, ... }`. Every response is JSON:

- success: `200 { ok: true, ...result }`
- failure: `<status> { ok: false, error: { code, message, field? } }` — `message` is user-facing (docs/08
  wording); `field` names the form field to show it at.

Order of checks: method → `Authorization` present → JWT verified (`auth.getUser`) → caller is an
**active admin** (`rpc('is_admin')` with the caller's own client) → body parsed and validated →
self-deactivation check → action. No service-role call happens before the caller is authorised.

## Operations

Strings are trimmed; empty strings count as omitted. Mobile: 10-digit Indian mobile (spaces, dashes,
leading `0`, `91` or `+91` accepted), stored as E.164 `+91XXXXXXXXXX` on the auth record (auth may return it
without `+`). Email: lower-cased. Region: trimmed, title case, ≤ 60 chars.

| Action | Body | Success (`200`, besides `ok: true`) |
|---|---|---|
| `create` | `full_name` (2–80), `role` (`admin` \| `orchestrator` \| `office` \| `field`), `region?`, `email?`, `phone?` | `{ user_id, temporary_password? }` |
| `update_login` | `user_id`, `email?`, `phone?` (at least one) | `{ user_id, email?, phone? }` (the values set, normalised) |
| `reset_password` | `user_id` | `{ user_id, temporary_password }` |
| `set_active` | `user_id`, `active` (boolean) | `{ user_id, active }` |

- `create` requirements: staff — `email` required, `phone` optional, password issued. Field operator —
  `region` and `phone` required; `email` optional, but required when `FIELD_SIGN_IN = email_password`;
  password issued unless `mobile_otp`. Email and phone are created confirmed; `app_metadata` carries
  `role`, `full_name`, `region`, from which the existing trigger creates an **active** profile in the same
  transaction (create is all-or-nothing). Field operators sign in with the auth **phone + password**
  (K4), so no synthetic email is created.
- `update_login`: omitted / `null` / `""` = unchanged; removing an email or mobile is not supported.
  Both are set confirmed; a phone change syncs `profiles.phone` (existing trigger).
- `reset_password`: the old password stops working at once. Refused for field users under `mobile_otp`.
- `set_active`: step 1 updates `profiles.is_active` **with the caller's client** (RLS as admin, row audit
  with the admin as actor, DB2 last-admin trigger); step 2 sets the sign-in block
  (`ban_duration` `876000h` / `none`), which ends session refresh (remote sign-out). Idempotent: on
  `sign_in_block_failed` just call it again.
- `temporary_password`: 12 characters from an unambiguous alphabet (no `0 O 1 l I`), at least one upper,
  lower and digit, formatted `xxxx-xxxx-xxxx` (the hyphens are part of the password). Returned once, in
  this response only; never logged, never stored outside auth. Show it in the one-time dialog.

## Error codes

| Status | `code` | When | `field` |
|---|---|---|---|
| 400 | `invalid_body` | body not a JSON object | — |
| 400 | `invalid_action` | unknown `action` | — |
| 400 | `invalid_input` | validation failed (message per field, e.g. "Enter a 10-digit Indian mobile number.") | `full_name` \| `role` \| `region` \| `email` \| `phone` \| `user_id` \| `active` (absent for "give a new email and/or mobile number") |
| 400 | `password_not_used` | `reset_password` on a field user while `FIELD_SIGN_IN = mobile_otp` | — |
| 401 | `unauthenticated` | no / invalid / expired token | — |
| 403 | `forbidden` | caller is not an active admin ("Only an active admin can do this.") | — |
| 403 | `self_deactivate` | `set_active(false)` on the caller's own id | — |
| 404 | `not_found` | `user_id` has no profile / auth user | — |
| 405 | `method_not_allowed` | not `POST` | — |
| 409 | `duplicate` | email or mobile already used ("This mobile number is already used by Vijay More." / "This email is already used by another user.") | `email` \| `phone` |
| 409 | `last_admin` | DB2 trigger: change would leave no active admin ("There must be at least one active admin.") | — |
| 502 | `sign_in_block_failed` | `set_active`: access changed, sign-in block not — retry | — |
| 502 | `auth_failed` | other auth admin API error (nothing saved) | — |
| 502 | `internal` | other database error from the profile update | — |
| 500 | `internal` | unexpected exception | — |

## Audit

One explicit `audit_log` row per successful action (and per `set_active`, also when step 2 fails), written
by the service client: `actor_id` = caller, `table_name = 'auth.users'`, `record_id` = target user,
`action` = `ADMIN_CREATE_USER` (`new_data`: name, role, region, email, phone, `temporary_password_issued`)
| `ADMIN_UPDATE_LOGIN` (`old_data` / `new_data`: previous and new email / phone) | `ADMIN_RESET_PASSWORD`
(`new_data`: `temporary_password_issued: true`) | `ADMIN_SET_ACTIVE` (`new_data`: `is_active`,
`sign_in_blocked` true / false / `"failed"`). Never a password. An audit insert failure is logged (ids
only) and does not fail the request, because the change has already happened.

## Not covered here (deferred)

- Scripted calls against the local stack with seeded admin / office tokens (T5 acceptance) and the
  web wrapper `lib/admin-users.ts` — with the web work (T8/T9).
- T6 spike: phone + password sign-in on the hosted plan without an SMS provider; `FIELD_SIGN_IN` follows it.
