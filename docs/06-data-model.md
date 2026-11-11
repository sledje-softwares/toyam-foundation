# 06 — Data Model (Phase 1)

Source of truth: `supabase/migrations/20261111000000_phase1_initial_schema.sql`.

## Entities

| Table | Purpose | Key points |
|---|---|---|
| `profiles` | Application users | Linked to `auth.users`; `role` ∈ admin, orchestrator, office, field |
| `insurers` | Insurer configuration | Sender domains, TAT days, submission channel, report template, extraction hints |
| `checklist_templates` / `checklist_template_items` | Reusable checklists | Per claim type, optional per-insurer override; mandatory and camera-only flags |
| `entities` | Hospitals, garages, doctors, agents, police stations | De-duplicated by type + name + city; for Phase 3 fraud patterns |
| `cases` | Investigation case | Auto `case_ref` (`INV-YYYY-NNNNNN`); `due_at` from insurer TAT; unique `(insurer_id, insurer_claim_no)` |
| `parties` | People on a case | Insured, patient, claimant, nominee, driver, witness |
| `case_entities` | Case ↔ entity links | With relation, e.g. `treating_hospital` |
| `case_status_history` | Status changes | Written by trigger; basis for per-stage turnaround |
| `emails` / `email_attachments` | Intake records | Idempotent on `gmail_message_id`; attachments hashed; OCR text |
| `intake_extractions` | AI extraction output | Values and per-field confidence; `pending_review` → `confirmed` / `rejected` |
| `tasks` | Units of investigation work | `initial`, `re_investigation`, `office`, `other`; `parent_task_id` links re-investigation |
| `task_checklist_items` | Per-task checklist | Copied from template via `apply_checklist_template()`; editable per case |
| `evidence` | Captured items | Photo, document, audio, video, note; GPS, device and server time, SHA-256, capture source, flags |
| `reports` | Report versions | Unique `(case_id, version)`; draft / final |
| `submissions` | Delivery to insurer | Channel, reference, acknowledgement |
| `audit_log` | Change history | Insert/update/delete on core tables with old and new data |

## Design rules enforced in the database

| Rule | Mechanism |
|---|---|
| No duplicate cases | Unique `(insurer_id, insurer_claim_no)` |
| No duplicate emails | Unique `gmail_message_id` |
| No duplicate evidence uploads | Unique `(case_id, sha256)` |
| Evidence immutable | `evidence_guard` trigger blocks updates to core fields and all deletes |
| Trusted server time | `evidence_autoflag` trigger overwrites `server_received_at` |
| Gallery uploads flagged | `evidence_autoflag` flags gallery capture on camera-only items |
| Field users update status only | `tasks_field_guard` trigger |
| Status history | `cases_status_history` trigger |
| Default deadline | `cases_before_insert` sets `due_at` from `insurers.tat_days` (default 15) |
| Audit trail | `audit_row` trigger on core tables |

## Access model (row-level security)

| Role | Access |
|---|---|
| Admin | Everything, including master data writes and the audit log |
| Orchestrator, Office | Full operational read/write; master data read-only; evidence read, insert, flag |
| Field | Cases and parties only where they hold a task; own tasks (status only); checklist items of own tasks; insert evidence on own open tasks; read own evidence. No access to emails, extractions, reports, submissions |

Helper functions: `current_user_role()`, `is_staff()`, `is_admin()`, `field_can_see_case()`.

## Dashboard view

`v_case_dashboard` — per case: insurer, status, due date, days remaining, overdue flag, orchestrator, open tasks, re-investigation rounds, active assignees. Uses `security_invoker` so RLS applies.

## Verification performed

Loaded on PostgreSQL 16 with a stubbed `auth` schema and smoke-tested: case reference and TAT defaults, duplicate rejection, checklist copy, field user isolation (sees only assigned case, no emails), gallery auto-flag, field task edit blocked, evidence tamper blocked, evidence delete blocked, flag update allowed, status history and audit entries written.

## Deliberate omissions

- No government ID number columns; ID documents are stored as evidence files.
- No billing, payout or scoring tables (later phases).
