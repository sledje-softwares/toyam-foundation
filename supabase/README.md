# supabase/

Database schema, auth config, storage buckets, dev seed and pgTAP tests for the local Supabase stack.

CLI: there is no global install; use `npx -y supabase@3.1.0 …` (the version this was built and tested with). Docker must be running.

## Commands (from the repo root)

```bash
npx -y supabase@3.1.0 start      # start the local stack (first run pulls images)
npx -y supabase@3.1.0 status     # URLs and keys (API URL, anon/publishable key, service-role key)
npx -y supabase@3.1.0 db reset   # drop the local DB, re-apply all migrations, load seed.sql
npx -y supabase@3.1.0 test db    # run the pgTAP tests in supabase/tests/
npx -y supabase@3.1.0 db lint    # plpgsql / schema lint
npx -y supabase@3.1.0 db advisors   # security / performance advisors (splinter)
npx -y supabase@3.1.0 stop       # stop (data volumes are kept)
```

Local URLs: API `http://127.0.0.1:54321`, DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, Studio `http://127.0.0.1:54323`, Mailpit (auth emails) `http://127.0.0.1:54324`.

Client apps use the **anon / publishable key** only. The service-role key is for server-side jobs (intake, R2 presigner, archive job) and never ships in a client.

## Dev logins (seed.sql, local only)

| Role | Login | Secret |
|---|---|---|
| Admin | `admin@example.com` | `DevPassw0rd!` |
| Orchestrator | `orchestrator@example.com` | `DevPassw0rd!` |
| Office | `office@example.com` | `DevPassw0rd!` |
| Field 1 (Pune) | phone `+919800000001` | OTP `123456` |
| Field 2 (Mumbai) | phone `+919800000002` | OTP `123456` |

Field OTPs come from `[auth.sms.test_otp]` in `config.toml`; no SMS is sent. Field 1 holds the tasks on the two seeded field cases; Field 2 has none (useful for checking isolation).

## Auth model

- Self-signup is disabled. Admins create users via the admin API with `app_metadata.role` (`admin` | `orchestrator` | `office` | `field`), and optionally `app_metadata.full_name` / `region`.
- A trigger on `auth.users` creates the `profiles` row. Role is read from **app_metadata only** (users can edit their own user_metadata). Missing/invalid role → `field` + `is_active = false`, i.e. no access until an admin activates the user.
- After creation, `profiles` is the source of truth for role and `is_active`. An inactive profile gets no data (the user can still read their own profile row so the app can say "not active").

## Files

- Evidence **files** live in Cloudflare R2 (key `cases/{case_id}/tasks/{task_id}/{sha256}.{ext}`), uploaded with short-lived presigned PUT URLs from a server-side function that first calls `public.can_upload_evidence(task_id)` with the user's JWT. The `evidence` table records the key in `storage_path`.
- Supabase Storage holds only `email-raw` (service role writes, staff read) and `reports` (staff read/write). Field users cannot access either bucket.
- Evidence archive columns (`archived_at`, `archive_location`, `archive_sha256_verified`, `cloud_purged_at`) are set once, by the service role only. `public.evidence_purge_candidates(p_days)` (service role only) lists evidence safe to remove from the cloud.

## Migration rules

- Change the schema only by adding a new file in `migrations/` named `YYYYMMDDHHMMSS_description.sql`. Never edit a migration that has been applied anywhere.
- Check every change with `db reset` and then `test db` before committing. Add a pgTAP test for any new RLS policy or trigger.
- Security-definer helpers go in the `private` schema (not exposed by the API) with `set search_path = ''`. Revoke `execute` from `anon` on new functions.
- `seed.sql` is for local development only. Never run it against a hosted project.

## Known advisor warnings (accepted)

- `multiple_permissive_policies`: staff and field policies are separate on purpose (readability); negligible at this data volume.
- `extension_in_public` (citext): left in `public` so case-insensitive comparison keeps working in functions with `search_path = ''`.
