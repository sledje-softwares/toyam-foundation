# CLAUDE.md — working context

Read this file first in every session. Keep it current: update **Current status** and **Next steps** at the end of each working session.

## Project in one paragraph

An insurance-claims investigation firm (Toyam Investigation and Valuation Pvt. Ltd) receives doubtful claims from ~10 insurers by email (~300 cases/month). In the revised workflow (D14–D26) each email fills the template of its insurer × claim type × variant, the case is assigned automatically to an office employee (the orchestrator can reassign), the office employee assigns field work to one of ~10 operators, operators work in a chat-style Android app (camera, gallery, share from any app; two-way thread with the office), every file is OCR'd and labelled, office staff fill the report section by section with the relevant images beside each section, and the report is generated as PDF and/or Word and sent on the insurer's email thread after approval. This repository builds that platform.

## Who is building it

A single freelance developer working with Claude. Plan work in small, independently shippable pieces. Prefer managed services over self-hosted infrastructure. Keep per-report cost low: LLMs where they earn their cost (image labelling, D30/D34) and rules everywhere else (D25).

## Key documents

- Scope, revised flow, gaps: `docs/03-phase1-scope.md`
- Build plan (M0–M11, piece IDs, status): `docs/04-build-plan.md`
- Architecture: `docs/05-architecture.md`
- Data model and database rules: `docs/06-data-model.md`
- Decisions and open questions: `docs/07-decisions-and-open-questions.md`
- M2 admin design: `docs/08-m2-admin-design.md`
- Templates and categories: `docs/09-template-model.md`, `config/templates/`
- Processing pipeline contract: `docs/10-processing-pipeline.md`
- Field app: `docs/11-field-app.md`
- Schema: all files in `supabase/migrations/` (latest `20261114200100_intake_retry.sql`)
- Email intake (M3) runbook: `services/intake/README.md`
- Vision labeller and model bake-off (D34): `services/labeller/README.md`

## Non-negotiable design rules

1. **Flexibility through tasks, not statuses.** Case status stays a short, fixed list (mapping in `06`). Extra investigation, including re-investigation, is a new `task`, posted into the thread as a request.
2. **Evidence is immutable.** Core evidence fields cannot be updated and evidence records cannot be deleted (trigger). Only flag, relevance (staff), withdraw (via `withdraw_message`, once) and set-once archive fields may change. Cloud copies are purged only after a hash-verified archive (D13).
3. **Trusted time and integrity.** `server_received_at` / message `created_at` are set by the database. Every file carries a SHA-256 computed on the device.
4. **Least privilege.** Field operators see only cases on which they hold a task, and only files posted into those threads; never staff-only messages (D32), emails, extractions, OCR, field matches, templates, reports, approvals or submissions. Enforced by RLS — never use service-role keys in client apps.
5. **Rules first, AI suggests, humans decide.** The intake service may create a case without review only when the deterministic template parser filled all required fields (D26); AI output goes to the review queue. Investigative conclusions stay with people.
6. **No duplicates.** Unique `(insurer_id, insurer_claim_no)`; emails idempotent on message id; thread messages idempotent on `client_message_id`; evidence unique per `(case_id, sha256)`.
7. **Minimise personal data.** No columns for government ID numbers; ID documents are evidence files. Do not commit real case data to git (Q18).
8. **One template drives a case.** Intake fields, report sections, relevant evidence categories, checklist and output options come from the case's template version (D20). Change templates in `config/templates/` and reload; never edit loaded template rows by hand.
9. **Gallery / shared files are not marked or blocked** (D18); the origin stays in `capture_source` for audit only.

## Conventions

- Database changes only through new files in `supabase/migrations/` (timestamp-prefixed). Never edit an applied migration. New enum values go in their own migration before they are used.
- Security-definer helpers in `private` with `set search_path = ''`. Guard functions that call `private.is_archive_writer()` must be **security invoker** (a definer sees `postgres` as current_user).
- Every new policy / trigger gets a pgTAP test in `supabase/tests/`.
- Security-definer functions cannot check the caller with `current_user`; restrict them by `GRANT EXECUTE` (service-role functions) or by `public.is_staff()` / `private.current_user_role()` (which read `auth.uid()`).
- Shared TypeScript (`supabase/functions/_shared`, `services/*`) must run in Deno **and** in Node's type stripping: import with `.ts` extensions, `import type` for types, no enums, no constructor parameter properties, no npm imports inside `_shared` (pass decoded data in). Tests: `npm test -w services/intake`.
- Enum and column names are `snake_case`; tables are plural.
- Client-facing documents (proposals, one-pagers) are business-oriented and do not name the technology stack.

## Current status (2026-11-14, end of session 5)

- Branch `revised-workflow-plan` (not merged to `main`, not pushed).
- Decisions up to D39. **D37:** Haiku 5.5 labels each file on arrival (one image, cached prompt); low confidence goes straight to Sonnet 5.5 on the standard API (no Batch API), ~$20 a month; fallback Sonnet on 6×6 collages. **D38:** one always-on container in a Mumbai region runs `services/pipeline` (Dockerfile, provider-neutral, service-role key server-side). **D39:** failed-mail retry is queued (`request_intake_retry()`, nothing deleted, attempts counted); a 10-minute Worker cron reprocesses; retries stuck ≥ 1 h or failed again notify orchestrators/admins in-app and send one `[Toyam alert] Intake retry stuck` email to the shared inbox (Gmail SMTP, `ALERT_EMAIL=smtp|off`). Earlier: D30 LLM labels, D31 orchestrator live view, D32 staff-only messages, D33 push intake, D34–D36 labelling models and bake-off.
- Database: migrations up to `20261114200100_intake_retry.sql`. pgTAP **431 assertions passing** (01–11) on the local Supabase stack (PG 17): `npx -y supabase@3.1.0 db reset && npx -y supabase@3.1.0 test db`. `03_rls_staff` test 24 depends on seed data. `apps/web/lib/database.types.ts` is generated (`npx -y supabase@3.1.0 gen types typescript --local > apps/web/lib/database.types.ts`).
- **Node tests need a TypeScript-capable Node.** The system `/usr/bin/node` (Ubuntu package) is built without type stripping; run suites with `npx -y node@22.22.1 --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-reporter=spec "test/*.test.ts"` inside the package, or install an official Node ≥ 22.18. Intake 48 passing, labeller 37 passing. Run `npm ci` after a fresh clone.
- M3 email intake built: push handler `services/intake/worker/email.ts`, hourly IMAP safety net (`relay.ts`), D39 retry cron (`retry.ts`), edge function `supabase/functions/intake` (not yet type-checked with Deno — not installed here), rule parser `supabase/functions/_shared/intake`.
- M6 labeller: `services/labeller` (prompt, parser, adapters, scoring, `npm run bakeoff`, collage arm). **6.9 done:** offline ground-truth tool `services/labeller/tools/truth-labeller.html` (rebuild with `build:truth-labeller`; exports `truth.csv`; paths starting with `#` are skipped by the parser).
- Web (`apps/web`): shell + auth + role nav; **M2 foundation T2–T4** (`components/ui`, `DataTable`/`FilterBar`/`Pagination`, `lib/list-params.ts`, admin layout, audit log at `/admin/audit-log`, nav badges, `/dev/ui`); **3.9 intake review** (`/intake`, `/intake/[extractionId]`, `confirm_intake()` / `reject_intake()`); **3.10 failed mail** (`/intake/failed`, queued retry, stuck banner, red nav count). vitest 42 passing; typecheck, lint, build clean. Security review of the web diff: no high/medium findings; lows fixed except the flash cookie (read by the browser by design). Not clicked through against a running stack yet.
- M2 plan agreed (docs/08 "Session 5 decisions"): order users (T5–T10) → insurers (T11–T12) → checklist editor (T13–T15, kept, with an evidence-category select) → 2.6 availability / assignment rules (design in docs/08 §2.6, **awaiting user review**; lists "needs migration" items). Defaults O3/O9/O10/K9 accepted. Open: D20-O1 (template checklists live in `checklist_templates`, linked by name from the YAML — confirm before T13).
- Not deployed anywhere. Push intake needs DNS for `toyaminvestigation.in` (Q14). Hosted `toyam-dev` still partially migrated — needs user approval.
- Not built: notifications bell/list (the `intake_retry_stuck` rows exist), case pages (`/cases/[ref]`; intake confirm returns to `/intake`), attachment downloads in intake review, staff notes (4.7), orchestrator live view (7.8).
- Real sample PDFs (personal data) still committed at the repo root — Q18.

## Next steps

1. User: review the 2.6 design in docs/08 and answer D20-O1.
2. Click through `/intake`, `/intake/[id]` and `/intake/failed` against the local stack with seeded staff of each role; type-check `supabase/functions/intake` with Deno.
3. M2 batch B: `admin-users` edge function (T5) + users screens T7–T10; then insurers T11–T12; then the checklist editor T13–T15; then 2.6 with its migrations.
4. Client: DNS owner for `toyaminvestigation.in` (Q14); raw `.eml` samples (Q19); Q11–Q17; image provider approval (Q21) → office labels ≥ 5 cases with the truth labeller → bake-off → record model in Q20.
5. Deploy M3 to a dev project (runbook `services/intake/README.md`) with the safety-net poll and the 10-minute retry cron; push once DNS is set. Needs approval for the hosted project.
6. Pipeline worker (D37/D38) in `services/pipeline` with a Dockerfile, plus model cost recording and the 80 % budget alert (6.10).
7. Notifications bell, case list/detail (4.6), staff notes (4.7), orchestrator live view (7.8).
8. Developer: Q18 (remove sample data from git and history).
