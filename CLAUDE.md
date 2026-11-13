# CLAUDE.md — working context

Read this file first in every session. Keep it current: update **Current status** and **Next steps** at the end of each working session.

## Project in one paragraph

An insurance-claims investigation firm receives doubtful claims from ~10 insurers by email (~300 cases/month). An orchestrator assigns each case to one of ~10 field operators (≈1 case per operator per day), who collect evidence on site. Office staff review the evidence and write the report (currently in MS Word); the orchestrator reviews it, may request further investigation, and the report is submitted to the insurer (by email; one insurer uses a portal). Today, intake is manual copy-paste and evidence is sent over WhatsApp. This repository builds the platform that replaces that workflow.

## Who is building it

A single freelance developer working with Claude. Plan work in small, independently shippable pieces. Prefer managed services over self-hosted infrastructure.

## Key documents

- Scope: `docs/03-phase1-scope.md`
- Build plan (modules M0–M10 and pieces): `docs/04-build-plan.md`
- Architecture: `docs/05-architecture.md`
- Data model rules: `docs/06-data-model.md`
- Decisions and open questions: `docs/07-decisions-and-open-questions.md`
- Schema: `supabase/migrations/20261111000000_phase1_initial_schema.sql`

## Non-negotiable design rules

1. **Flexibility through tasks, not statuses.** Case status stays a short, fixed list. Any extra investigation (including re-investigation) is a new `task` with its own checklist.
2. **Evidence is immutable.** Core evidence fields cannot be updated and evidence records cannot be deleted (enforced by trigger). Only `is_flagged` / `flag_reason` may change, plus set-once archive fields written by the archive job. Cloud copies of files may be purged only after a hash-verified archive exists (D13).
3. **Trusted time and integrity.** `server_received_at` is always set by the database. Every file carries a SHA-256 hash computed on the device and re-verified on upload.
4. **Least privilege.** Field operators see only cases on which they hold a task; they never see emails, extractions, reports or submissions. Enforced by row-level security — do not bypass it with service-role keys in client apps.
5. **Human confirms, AI suggests.** AI extraction never creates a case without staff confirmation. The investigative conclusion always remains with a person.
6. **No duplicates.** `(insurer_id, insurer_claim_no)` is unique; incoming emails are idempotent on `gmail_message_id`.
7. **Minimise personal data.** Do not add columns for government ID numbers; ID documents are stored as evidence files.

## Conventions

- Database changes only through new files in `supabase/migrations/` (timestamp-prefixed). Never edit an applied migration.
- Enum and column names are `snake_case`; tables are plural.
- Client-facing documents (proposals, one-pagers) are business-oriented and do not name the technology stack.

## Current status (2026-11-11, paused)

- Decisions D10–D13 recorded (Supabase free, Cloudflare Workers hosting, Cloudflare-based email intake, R2 + daily local archive). Paid-plan decision deferred to before go-live (P5).
- M1: local Supabase stack (CLI `npx -y supabase@3.1.0`) with 4 new migrations (security hardening, auth→profiles, storage, evidence R2/archive), seed data and 152 passing pgTAP tests. Web shell in `apps/web` (Next.js on Cloudflare via OpenNext) deployed to https://toyam-web.sledjesoftwares.workers.dev.
- Hosted `toyam-dev` (ref `ezycvkthddhqtwtqvmlg`) is **partially migrated**: only the initial schema; the security-hardening migration was declined; no admin user. Do not use it until the remaining 4 migrations are applied (needs user approval).
- M2 design done: `docs/08-m2-admin-design.md`. Implementation of T1–T5 was started and **stopped mid-way** — `supabase/migrations/20261112000000_m2_admin.sql`, `supabase/tests/06_m2_admin.test.sql`, `supabase/functions/` and new files in `apps/web` may be incomplete; review before continuing.
- Nothing committed since the initial commit (user instruction).

## Next steps

1. User decision on `toyam-dev`: apply remaining 4 migrations + create admin, or roll back.
2. Review the partial M2 T1–T5 work; finish T1–T5, then T7–T15 (Sonnet), per §5 of the design.
3. Answer M2 open questions (§6 of the design) and Q10 with the client; M0 inputs still outstanding.
4. Field sign-in default: mobile + password (no SMS cost) — confirm with the client.
