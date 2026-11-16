# 06 — Data Model (Phase 1)

Source of truth: all files in `supabase/migrations/` applied in order. Tests: `supabase/tests/`.

| Migration | Adds |
|---|---|
| `20261111000000_phase1_initial_schema` | Core tables, triggers, RLS |
| `20261111100000_security_hardening` | Private schema helpers, fixed search paths, stricter field rules, no anon |
| `20261111110000_auth_profiles` | `auth.users` → `profiles` from app_metadata |
| `20261111120000_storage` | `email-raw`, `reports` buckets |
| `20261111130000_evidence_r2_archive` | R2 storage backend, archive / purge columns |
| `20261112000000_m2_admin` | Admin user list, last-admin guard, insurer rules, `report-templates` bucket, checklist editor RPCs |
| `20261113000000_revised_flow_enums` | `capture_source = 'share'` |
| `20261113000100_revised_flow` | Templates, assignment, thread, processing, approvals (below) |
| `20261113000200_intake` | Email intake: `intake_config()`, `intake_ingest()`, review queue actions, failure / retry (below) |
| `20261114000000_staff_notes_progress` | Staff-only messages, report progress view, field history, LLM label descriptions, field matches, realtime (below) |
| `20261114100000_label_first` | Stage order label → OCR, `needs_ocr` categories, label `needs_detail` / `model`, `ocr_wanted()` (D34, below) |
| `20261115800000_report_guards` | `save_case_field_values()`, claim / policy no. sync, approval request rules, submission records, acknowledgement, manual submission, reopen (D44/D45, below) |

## Core entities

| Table | Purpose | Key points |
|---|---|---|
| `profiles` | Users | Role ∈ admin, orchestrator, office, field; `availability`, `availability_until`, `max_open_cases` |
| `insurers` | Insurer configuration | Code, sender domains (unique across insurers), TAT, submission channel |
| `cases` | Investigation case | `case_ref` auto; `due_at` from TAT; unique `(insurer_id, insurer_claim_no)`; `template_id`; `office_owner_id` + `assignment_method` |
| `parties`, `entities`, `case_entities` | People and organisations on a case | Entities kept for Phase 3 pattern analysis |
| `case_status_history` | Status changes | Basis for per-stage turnaround |
| `emails`, `email_attachments`, `intake_extractions` | Intake record and review queue | Idempotent on message id |
| `tasks`, `task_checklist_items` | Field work | Checklist copied from a template; items carry an evidence `category_id` |
| `evidence` | Files and notes | Immutable core; GPS, device/server time, SHA-256, `capture_source`, `message_id`, withdraw, relevance, archive columns |
| `reports`, `report_files`, `report_annexures` | Report versions, generated files (pdf/docx), chosen images | |
| `report_approvals` | Approval per report version | Decided once by orchestrator/admin |
| `submissions` | Delivery to insurer | Formats, recipients, sent message / thread ids |
| `audit_log` | Change history | Insert/update/delete on core tables |

## Revised workflow additions (`20261113000100_revised_flow.sql`)

### Templates and categories (D20)

| Table | Purpose |
|---|---|
| `evidence_categories` | One taxonomy (`code`), with `filename_patterns` and `text_patterns` for the free labeller |
| `case_templates` | Insurer × claim type × variant, versioned; `requires_approval`, `output_formats`, `default_output_format`, `docx_template_path`, `intake_rules`, `report_email` |
| `case_template_sections` | Ordered report sections |
| `case_template_fields` | Fields per section; `source` intake / office; `extract` rules; unique key per template |
| `case_template_section_categories` | Which evidence categories are relevant to each section (drives the image panel) |
| `case_template_checklists` | Default field checklist(s) for the template. Linked by name at load; `activate_checklist_template()` moves links from the checklist it replaces to the new one, audited (D42) |
| `case_field_values` | One value per case × field, with source (email_parser / llm / office / suggestion), confidence and evidence reference |

Load from config: `load_evidence_categories(jsonb)`, `load_case_template(jsonb, source_file, activate)` (admin or service role). Identical config → no new version; changed config → new version; one active version per insurer × claim type × variant; cases keep their version.

### Assignment (D15, D16)

| Object | Purpose |
|---|---|
| `assignment_rules`, `assignment_rule_members` | Pools per insurer / claim type (null = any), strategy, priority |
| `case_assignments` | History of every assignment (auto / manual, reason) |
| Trigger on `cases` insert | Auto-assigns when no owner; most specific rule first; skips unavailable staff and full caps; fallback to all available office staff; else orchestrators notified |
| `reassign_case(case, user, reason)`, `retry_auto_assign(case)` | Orchestrator / admin only |
| Owner guard | `office_owner_id` changes only through these functions (or system jobs) |
| `set_availability(user, availability, until)` | Self, orchestrator or admin |
| `create_field_task(...)` | Office staff assign field work (copies checklist) |

### Thread (D17, D19)

| Object | Purpose |
|---|---|
| `case_messages` | Kinds text / media / voice / system / request; `client_message_id` for offline idempotency; no edit, no delete; withdraw only |
| `case_thread_reads` | Read pointer per user per case (ticks, unread counts) |
| `post_thread_message(case, client_id, kind, body, task, reply_to, items)` | Runs as the caller (RLS decides); stores files as evidence with operator tag and device OCR; first upload starts the field task |
| `withdraw_message(id)` | Sender only, within `withdraw_window_minutes`; hides message and files |
| `mark_thread_read(case)`, `case_thread_state(case)` | Read state for ticks |
| `field_case_list()` | Field app home: Open / Completed, last message, unread |

### Processing (D21)

| Object | Purpose |
|---|---|
| `processing_jobs` | One row per evidence × stage × pipeline version; queued / running / done / failed / skipped; back-off retries |
| `evidence_ocr` | Text + blocks (bbox, confidence) per page and engine; newest is current |
| `evidence_labels` | Category labels with source (operator / filename_rule / text_rule / model / llm / human); corrections deactivate, never delete |
| `field_suggestions` | Proposed field values from OCR with block reference; accepted / rejected |
| `claim_processing_jobs`, `complete_processing_job`, `enqueue_reprocessing` | Worker API, service role only |
| `set_evidence_labels(evidence, categories[])` | Office correction → human labels |
| `private.apply_filename_labels(evidence)`, trigger `trg_evidence_filename_label`, `backfill_filename_labels(limit)` | File-name rule labels for email attachments at arrival (docs/10); backfill is service-role only |
| `v_evidence_processing`, `v_case_checklist` | Read models for ticks and checklist progress |

### Approval, sending, notifications

| Object | Purpose |
|---|---|
| `report_approvals` | Request (office) → approve / changes requested (orchestrator, admin) |
| Submission guard | Refuses unapproved reports where the template requires approval, and formats the template does not allow |
| `notifications`, `device_tokens` | In-app notifications (de-duplicated), push tokens |
| `escalate_unattended_cases()` | Service role, scheduled; unassigned cases and assigned cases without field work |
| `app_settings` | Withdraw window, escalation thresholds |

### Email intake (`20261113000200_intake.sql`, M3)

| Object | Purpose |
|---|---|
| `emails` additions | `in_reply_to`, `references_ids`, `cc_addresses`, `from_name`, `is_internal`, `raw_sha256`, `template_id`, `parser_version`, `parse_notes`; `gmail_message_id` holds the Message-ID header (idempotency key) |
| `email_attachments` additions | `content_id`, `is_inline`, `is_evidence` |
| `intake_extractions` additions | `template_id`, `missing_required`, `parser_action`, `reject_reason` |
| `intake_config()` | Service role: insurers + domains, active templates with intake fields, firm addresses |
| `intake_ingest(decision)` | Service role, one transaction: idempotent on Message-ID → internal / unmatched / follow-up (Gmail thread, reply chain, then insurer + claim no.) / new case (rules complete) / review queue |
| `confirm_intake(extraction, template, values)` / `reject_intake(extraction, reason)` | Office: review queue |
| `intake_record_failure(...)` / `intake_retry(email)` | Undecodable mail kept visible; staff retry |
| `app_settings` | `internal_email_domains`, `internal_email_addresses` |

Insurer files become `evidence` with `capture_source = email_attachment`, `storage_backend = supabase` (bucket `email-raw`), `captured_by` null; field users never see them.

### Staff notes, report progress, field matching (`20261114000000_staff_notes_progress.sql`, D30–D32)

| Object | Purpose |
|---|---|
| `case_messages.visibility` | `all` (default) or `staff`; immutable. Field users never read or write `staff` messages, nor files posted in them. Assignment / reassignment and "report sent" events are `staff` |
| `post_staff_note(case, client_id, body, reply_to)` | Staff-only note; notifies the case owner and the case orchestrator (not the author) |
| `v_report_progress` | Per case and section: fields / required total and filled, values from email / suggestions / entered, last change and by whom (staff only through RLS) |
| `case_field_history(case)` | Who changed which field from what to what (from the audit log; staff only) |
| `evidence_labels.description` | LLM's short description of a file, only where useful (D35) |
| `evidence_field_matches` | Report fields a file is evidence for, from the label call; `score` = the model's confidence (D35; pipeline output; staff read only) |
| Realtime | `case_messages`, `case_field_values`, `evidence_labels`, `notifications` in the `supabase_realtime` publication (RLS applies) |

### Label first (D34)

| Object | Purpose |
|---|---|
| `private.stage_rank(stage)` | Run order text_extract → label → ocr → field_suggest (the enum keeps its original order; claiming uses the rank) |
| `evidence_categories.needs_ocr` | Files of this category get server OCR; loaded from `ocr:` in `_categories.yaml` (default: documents) |
| `evidence_labels.needs_detail`, `detail_reason`, `model` | Labeller says the file must be read at full resolution, and why; model that produced the label |
| `ocr_wanted(evidence)` | Service role only: documents, unlabelled files, and files with an active label whose category needs OCR or that needs detail; never withdrawn files |

### Offline, late uploads and remote sign-out (`20261114400000_offline_drain.sql`, D43)

| Object | Purpose |
|---|---|
| `profiles.deactivated_at` | Server time of the last deactivation (trigger on `is_active`; cleared on reactivation; only the service role / owner may set it directly) |
| `task_holds` | Who held which task from when to when (server clock): opened on assignment, closed when the task is completed, cancelled or reassigned. Staff read; no client writes |
| `private.field_upload_allowed(task, profile, captured_at)` | The D43 window: device capture time within the hold, not in the future, before deactivation; server time within 72 h of the hold ending (`late_upload_grace_hours`) and within 7 days of deactivation (`drain_window_days`) |
| `post_thread_message()` (changed) | A field operator's files go through the late path when they hold no open task on the case; each late file is audited `LATE_UPLOAD` (duplicates skipped, `LATE_UPLOAD_DUPLICATE`) |
| `can_upload_evidence_at(task, device_captured_at)` | Presigner check incl. late uploads |
| `field_devices` | Per-phone drain secret, SHA-256 only, registered while active (`register_field_device()`); no client access |
| `drain_status / drain_authorize_upload / drain_post_message / drain_report_outbox / drain_finish` | Service role only (edge function `field-drain`): deactivated operator's phone sends files captured before deactivation, then finishes; audited `DRAIN_PRESIGN`, `DRAIN_UPLOAD`, `DRAIN_FINISHED` |
| `device_outbox_status` | Files waiting on each phone: `pending_count`, `pending_bytes`, `oldest_pending_at` (phone clock), `reported_at` (server clock). Written only by `report_outbox_status()` / `drain_report_outbox()`; staff read all rows, field users their own |
| `case_outbox_status(case)` | Thread header: operators who held a task on the case and what waits on their phones (staff; field users only their own) |

### Report guards (`20261115800000_report_guards.sql`, D44, D45)

| Object | Purpose |
|---|---|
| `private.can_manage_case(case)` | Admin / orchestrator on every case, office on the cases they own (D44; created here only if missing) |
| `private.report_editable_status(status)` | Report values change only in `received`, `intake_confirmed`, `assigned`, `field_in_progress`, `office_review` |
| `save_case_field_values(case, values, expected)` | The only staff write path for values: `can_manage_case`, editable status, case row locked, compare-and-set per field against `expected`; conflicting fields returned with value, source, who and when, not written; source `office`. Direct staff insert / update / delete on `case_field_values` revoked; read stays D44-scoped (intake writes through definer functions) |
| `case_field_values_sync_case` trigger | Fields `insurer_claim_no` / `policy_no` are copied onto `cases`; a claim no. used by another case of the insurer is refused (`23505`), the claim no. cannot be cleared. `cases_mirror_guard`: clients cannot change those case columns directly when the template has the field |
| `report_approvals_guard` (changed) | Request needs `can_manage_case` (system jobs exempt), status `assigned` / `office_review` with no open task, and every required template field filled |
| `submissions` additions | `acknowledged_by`, `ack_note`, `reopened_at`, `reopened_by`, `reopen_reason`. Read and insert (only as themselves) on cases they manage (D44 scope kept); no update / delete for API roles except set-once acknowledgement, insurer reference, sender ids and reopen marks (`submissions_record_guard`) |
| `record_submission_ack(submission, at, note, insurer_reference)` | Once; not in the future; staff-only thread event |
| `record_manual_submission(case, channel, formats, insurer_reference, note, submitted_at, report)` | Portal (reference required) or other (note required); latest version; approval and formats checked by the submission guard |
| `reopen_case(case, reason)` | `submitted` → `office_review`; reason in the status history note; latest submission marked reopened; staff-only thread event; owner (else orchestrators) notified `case_reopened` |

## Case status automation

| Event | Status change |
|---|---|
| Case created | `received` |
| Office employee assigned | `received` → `assigned` |
| Field task / request created | `assigned`, `office_review`, `orchestrator_review` → `field_in_progress` |
| Last open task completed or cancelled | `field_in_progress` → `office_review` |
| Approval requested (no open task, required fields filled) | `assigned`, `office_review` → `orchestrator_review` |
| Changes requested | `orchestrator_review` → `office_review` |
| Submission recorded | → `submitted` |
| Case reopened on an insurer query (`reopen_case`) | `submitted` → `office_review` |

Every change is written to `case_status_history` and shown in the thread as a system message where relevant.

## Rules enforced in the database

| Rule | Mechanism |
|---|---|
| No duplicate cases / emails / evidence | Unique `(insurer_id, insurer_claim_no)`, message id, `(case_id, sha256)` |
| Evidence immutable | `evidence_guard`: only flag, relevance (staff), withdraw (via function, once), archive (archive job, once) may change; no delete |
| Trusted time | `server_received_at`, `created_at` set by the database; messages stamped on insert |
| Files from gallery / share accepted, unmarked (D18) | `evidence_autoflag` no longer flags; origin kept in `capture_source` |
| Thread consistency | Evidence message must be in the same case and sent by the uploader; replies and tasks in the same case |
| Field users update task status only | `tasks_field_guard` |
| Template consistency | Field values must belong to the case's template version |
| Annexures | Only non-withdrawn, not-irrelevant evidence of the same case |
| Approval before sending | Submission guard |
| Audit trail | `private.audit_row` on core and new tables |
| Late / drained files (D43) | Accepted only inside the server-clock window of `field_upload_allowed()`; every file audited with the hold and deactivation times |

## Access model (row-level security)

| Role | Access |
|---|---|
| Admin | Everything, incl. templates, categories, settings, audit log |
| Orchestrator | Operational read/write; assignment rules; reassign; approve |
| Office | Operational read/write; request approval; cannot change the case owner or decide approvals |
| Field | Cases where they hold a task; intake fields of those cases; thread messages except staff-only ones; own files plus files posted into those threads (not withdrawn, not staff-only); categories; own notifications; own outbox rows. Never emails, extractions, reports, approvals, submissions, OCR, field matches or templates |
| Service role | Intake, pipeline, sender, archive and escalation jobs |

## Deliberate omissions

- No government ID number columns; ID documents are evidence files (D8).
- No billing or scoring tables (later phases).
- `intake_confirmed` status unused in the revised flow (kept in the enum).
