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

## Current status (2026-11-14, end of session 4)

- Decisions up to D38. New: **D37: Haiku 5.5 labels each file on arrival (one image, cached prompt); low confidence goes straight to Sonnet 5.5 on the standard API (no Batch API), ~$20 a month; fallback Sonnet on 6×6 collages. D38: one always-on container in a Mumbai region runs `services/pipeline` (Dockerfile, provider-neutral, service-role key server-side).** Earlier: labelling and OCR models (D34) — each image labelled on its own at ~384 px by a small vision model (no collages), label **before** OCR, server OCR (dedicated OCR model) only where `ocr_wanted()`, numbers from OCR + rules with the vision model as second opinion, model chosen by bake-off. **D35: one LLM call per image returns labels, matched report fields (→ sections) and a description only where needed; no cross-encoder, no embedding classifier; per-template prompt must be cached.** **D36: the bake-off compares Haiku 5.5 and Sonnet 5.5 on single images and on numbered 6×6 collages; collages adopted only if they meet the same pass marks.** Earlier: D30 LLM labels, D31 orchestrator live view, D32 staff-only messages, D33 push intake.
- Database: migrations up to `20261114200100_intake_retry.sql` (D39 queued intake retry). pgTAP suite **431 assertions passing** (01–11) on PostgreSQL 16 with a Supabase-compatible stub and seed. **Confirm locally with `npx -y supabase@3.1.0 db reset && npx -y supabase@3.1.0 test db` (PG 17).** `03_rls_staff` test 24 depends on seed data.
- M3 email intake built: push handler `services/intake/worker/email.ts` (Email Routing → `email()`), hourly IMAP safety net (`relay.ts`, `ONLY_FROM` filter), edge function `supabase/functions/intake`, rule parser `supabase/functions/_shared/intake`. Node tests: 48 passing. D39 queued retry: Worker `*/10` cron (`retry.ts`) → `?retry=<email id>`; stuck alerts in-app + one Gmail SMTP email.
- M6 labeller groundwork: `services/labeller` — per-template prompt (categories + fields) and answer parser (labels, field matches, optional description), adapters (Anthropic, Google, OpenAI, OpenRouter, DeepSeek, self-hosted vLLM), scoring incl. field precision / recall, `npm run bakeoff --template`, collage arm `--layouts single,6x6` (numbered cells, per-cell parsing). 35 Node tests passing; strict `tsc` clean. Categories now carry `description` (for the prompt) and `ocr` flags.
- Not deployed anywhere. Push needs DNS for `toyaminvestigation.in` (Q14); until then the poll alone works (set the cron back to every few minutes if push is not ready at go-live).
- Templates: `config/templates/_categories.yaml` (25), `igi-motor-od.yaml`, `icl-motor-od.yaml`.
- Hosted `toyam-dev` still partially migrated (initial schema only) — needs user approval.
- UI not started for: M2 T2–T16, intake review (3.9), failed mail (3.10), staff notes (4.7), orchestrator live view (7.8).
- Real sample PDFs (personal data) still committed at the repo root — Q18.

## Next steps

1. Locally: `db reset` + `test db`; regenerate `database.types.ts`; `npm test -w services/intake`.
2. Client: DNS owner for `toyaminvestigation.in` (Q14); raw `.eml` samples (Q19); Q11–Q17.
3. Deploy M3 to a dev project (runbook `services/intake/README.md`), first with the safety-net poll, then push once DNS is set.
4. Client: approval to send case images to an external AI provider, and which regions (Q21). Then the office labels ≥ 5 real cases and the bake-off runs (`services/labeller/README.md`); record the model in Q20.
5. Pipeline worker (D37/D38) in `services/pipeline` with a Dockerfile: `label` stage (Haiku 5.5, Sonnet 5.5 on low confidence; labels + field matches + optional description, cached per-template prompt), PaddleOCR for `ocr` where `ocr_wanted()`, field value rules + second opinion; plus model cost recording and monthly budget alert (6.10).
6. Web: intake review + failed mail (3.9/3.10), then staff notes and the orchestrator live view inside the M2 shell.
7. Developer: Q18 (remove sample data from git and history).
