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

## Revised workflow objects (20261113000100)

- Templates: load `config/templates/*.yaml` (as JSON) with `public.load_evidence_categories()` and `public.load_case_template()` — admin or service role. See `docs/09-template-model.md`.
- Field app: `post_thread_message()` (idempotent on `client_message_id`), `withdraw_message()`, `mark_thread_read()`, `case_thread_state()`, `field_case_list()`.
- Office: `create_field_task()`, `set_evidence_labels()`, `set_availability()`; orchestrator: `reassign_case()`, `retry_auto_assign()`.
- Service role only: `claim_processing_jobs()`, `complete_processing_job()`, `enqueue_reprocessing()`, `escalate_unattended_cases()` (schedule every 10–15 min).
- Settings in `public.app_settings` (`withdraw_window_minutes`, `escalate_unassigned_minutes`, `escalate_no_field_task_hours`).

## Email intake (20261113000200, M3)

- Edge function `functions/intake` (Deno) + shared parser `functions/_shared/intake`; `verify_jwt = false`, protected by the `INTAKE_SECRET` header. Local: `npx -y supabase@3.1.0 functions serve intake --env-file supabase/functions/.env`.
- Service role only: `intake_config()`, `intake_ingest(jsonb)`, `intake_record_failure(...)`. Staff: `confirm_intake()`, `reject_intake()`, `intake_retry()`.
- Insurer attachments are evidence in the `email-raw` bucket (`storage_backend = supabase`).
- Deployment steps: `services/intake/README.md`.

## Staff notes and report progress (20261114000000, D30–D32)

- `case_messages.visibility` (`all` / `staff`); `post_staff_note()` for orchestrator ↔ office notes; field users never see `staff` messages or their files.
- `v_report_progress` and `case_field_history(case)` for the orchestrator's live view; Realtime publication covers `case_messages`, `case_field_values`, `evidence_labels`, `notifications` (the local stack needs `wal_level = logical`, which the Supabase image already sets).
- `evidence_labels.description` and `evidence_field_matches` for LLM labelling and cross-encoder field matching (written by the pipeline with the service role).

## Seed data (office demo)

`seed.sql` also loads the evidence categories and the two templates in `config/templates` (inlined; regenerate the two marked blocks with `npm run seed:templates -w services/intake`, which resolves each template's report layout and embeds its assets like `templates:load`; `npm run seed:check -w services/intake` fails when they are out of date) and eight demo cases for the office pages. All names, phones, vehicles and claim numbers are invented. No files exist in any bucket, so open / download links on seeded evidence, reports and email attachments do not work; processing jobs for them are marked `skipped`.

Extra logins (password `DevPassw0rd!`): `office2@example.com` (Neel Office); Field 1 / 2 / 3 (`+919800000001`, `…02`, `…03`, Feroz Field, Nashik) also sign in with phone + password. Insurers `IGI` and `ICL` match the templates.

| Case ref | Insurer | Status | Owner | Shows |
|---|---|---|---|---|
| INV-2026-000004 | IGI | received | none | Unassigned queue, orchestrator alert, intake values only |
| INV-2026-000005 | ICL | assigned | Uma | No field work yet; staff-only notes |
| INV-2026-000006 | IGI | field_in_progress | Neel | Due today; operator Fatima mid-visit, operator and LLM labels, gallery photo, office task, suggested odometer |
| INV-2026-000007 | ICL | field_in_progress | Uma | Overdue; reassigned by orchestrator; completed task plus open re-investigation (linked to parent); DL with OCR and pending suggestions |
| INV-2026-000008 | IGI | office_review | Uma | Report half written (required fields empty), FIR / DL documents, label correction, relevance marks |
| INV-2026-000009 | ICL | orchestrator_review | Neel | All required fields filled, draft report, pending approval |
| INV-2026-000010 | IGI | submitted | Neel | Approved report, submission by email |
| INV-2026-000011 | ICL | closed | Uma | Acknowledged submission, closed |

Cases `INV-2026-000001..3` (insurers SGI / DHI / TLA, no template) are the older seed rows. Fixed ids: cases `d0000000-0000-4000-8000-000000000101..108`, tasks `e0000000-0000-4000-8000-000000000103..114`, reports `91000000-0000-4000-8000-000000000106..108`. Case refs follow the sequence and are stable after `db reset`.
