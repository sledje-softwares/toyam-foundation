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
2. **Evidence is immutable.** Core evidence fields cannot be updated and evidence cannot be deleted (enforced by trigger). Only `is_flagged` / `flag_reason` may change.
3. **Trusted time and integrity.** `server_received_at` is always set by the database. Every file carries a SHA-256 hash computed on the device and re-verified on upload.
4. **Least privilege.** Field operators see only cases on which they hold a task; they never see emails, extractions, reports or submissions. Enforced by row-level security — do not bypass it with service-role keys in client apps.
5. **Human confirms, AI suggests.** AI extraction never creates a case without staff confirmation. The investigative conclusion always remains with a person.
6. **No duplicates.** `(insurer_id, insurer_claim_no)` is unique; incoming emails are idempotent on `gmail_message_id`.
7. **Minimise personal data.** Do not add columns for government ID numbers; ID documents are stored as evidence files.

## Conventions

- Database changes only through new files in `supabase/migrations/` (timestamp-prefixed). Never edit an applied migration.
- Enum and column names are `snake_case`; tables are plural.
- Client-facing documents (proposals, one-pagers) are business-oriented and do not name the technology stack.

## Current status

- Planning for Phase 1 complete (scope, build plan, architecture, data model).
- Phase 1 schema drafted and smoke-tested on local PostgreSQL 16 with a stubbed `auth` schema: duplicate prevention, RLS for field users, evidence immutability, gallery auto-flagging, status history and audit log verified.
- No application code yet.

## Next steps

1. Resolve the open questions in `docs/07-decisions-and-open-questions.md` (Workspace vs @gmail.com is the most urgent).
2. M0 Discovery: collect sample emails, report formats and checklists from the client.
3. M1 Foundation: create Supabase dev/prod projects (Mumbai region), apply the migration, scaffold `apps/web`.
4. Design the email intake flow in detail (classification, extraction fields, review screen) before building M3.
