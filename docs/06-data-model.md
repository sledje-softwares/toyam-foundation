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
| `20261117300000_device_derivative_target` | `device_derivative_target()`: presign check for the shrunk copies the field app uploads (below) |
| `20261117000000_report_versions` | Report versions from the generator (7.7, D51): `case_templates.report_layout`, `evidence_derivatives` (shrunk image copies), `prepare_report_version()`, `create_report_version()`, value snapshot per version, generated versions as records, `reports` bucket scheme for generated files (below) |

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
| `evidence_field_matches` | Report fields a file is evidence for, from the label call; `score` = the model's confidence (D35; pipeline output; staff read only). Since `20261119500000` also rows with `model = 'category_map'` derived from the file's labels and the template map (below) |
| Realtime | `case_messages`, `case_field_values`, `evidence_labels`, `notifications` in the `supabase_realtime` publication (RLS applies) |

### Category → field map (`20261119500000_category_field_map.sql`, docs/14 gap 26)

| Object | Purpose |
|---|---|
| `case_template_category_fields` | `(template_id, category_id, field_id, score)`, primary key on the three ids; the field must belong to the same template version (FK on `case_template_fields (id, template_id)`); score in (0, 1]. Staff read, admin write; filled by `load_case_template()` from the config's `category_fields` (unknown category or field key fails the load). Source: `config/templates/maps/*.yaml` (docs/09) |
| `evidence_field_matches.category_id` | Category whose map produced a `category_map` row; null for model rows (check: set exactly when `model = 'category_map'`) |
| `private.derive_category_field_matches(evidence)` | Recomputes the file's `category_map` rows (`pipeline_version 'map-v1'`): score = map score × label confidence (null → 1), best per field; labels from `operator` / `filename_rule` / `text_rule` / `human` always, `llm` / `model` labels only while the file has no model match; stale map rows deleted; model rows never touched |
| `trg_evidence_labels_category_map` | AFTER INSERT / UPDATE OF `is_active` on `evidence_labels`: derive (never fails the write) |
| `trg_field_matches_model` | AFTER INSERT on `evidence_field_matches` for non-`category_map` rows: derive, so model fields replace the LLM-label fallback |
| `backfill_category_field_matches(limit)` | Service role only: derives files that have a mapped, counting label and no map rows yet; returns the number of files filled |

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

### Report versions and shrunk copies (`20261117000000_report_versions.sql`, 7.7, D51)

| Object | Purpose |
|---|---|
| `case_templates.report_layout` | jsonb (object or null): structured copy of the insurer's report layout per template version; format and loading belong to the template loader |
| `evidence_derivatives` | Shrunk JPEG copies the **field app** made of its own photos, PK `(evidence_id, width)`, width 384 (labelling) or 1600 (reports); `storage_path` = `derived/{case_id}/{original_sha256}/w{width}-{copy_sha256}.jpg` (content-addressed: another upload with other bytes gets another key and can never overwrite a recorded copy), `sha256` (required), `size_bytes`, `pixel_width`, `pixel_height`, `created_at`. No server-side shrinking: insurer attachments and photos without a copy are used as the original. Not evidence (rule 2 does not cover them), but set once: trigger `evidence_derivatives_guard` refuses update and delete for every writer and holds the path scheme and image-only rule. Staff read on cases they manage (`can_manage_evidence`); field users nothing; no direct writes for API roles |
| `device_derivative_target(task, original_sha256[])` (`20261117300000`) | Field operator, used by `evidence-upload` to presign copies: `{case_id, allowed, originals: {sha256: [widths already recorded]}}`; lists only photos on the task's case captured by the caller and not withdrawn; `allowed` = the rule of `record_device_derivative` (`private.field_derivative_access`). Staff and operators without the task: `42501` |
| `record_device_derivative(case, original_sha256, width, storage_path, sha256, size_bytes, pixel_width, pixel_height)` | Field operator: the 384 and 1600 copies the app uploaded next to its own photo (captured by the caller, `photo`, not withdrawn). Allowed while the operator still sees the case (assignee of a task on it) or within the D43 late window of a task they held there (`held_until` + `late_upload_grace_hours`); a deactivated operator's phone does not record copies. Idempotent: a copy already recorded for (photo, width) is returned unchanged. Returns `{evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height, recorded}` |
| `reports.field_values`, `reports.values_token` | G2: the values a generated version was made from (`{key: {value, source, updated_at}}`) and the token it was prepared with |
| `prepare_report_version(case)` | Staff (`can_manage_case`), editable status only (same rules and messages as `save_case_field_values`; submitted → D46 message). Everything the generator needs: case header, template, `report_layout`, sections with fields and values, `values_token`, `next_version`, `latest_version`, default photo selection per section, unplaced photos, annexure files (shape in `docs/12-office-pages/reports.md`) |
| `create_report_version(case, report_id, values_token, files, photos, notes)` | Staff; the caller (edge function `report-generate`, staff JWT) chose `report_id` and uploaded `{case_id}/{report_id}/report.{pdf|docx}` to bucket `reports` first. Checks scope, editable status, values token (else `RV409`), files (1–2, formats of the template, exact path, uploaded with that size), photos (files of the case, image or document, not withdrawn / not relevant, template section, unique position per section). Case row locked; version = max + 1; origin `generated`; `storage_path` = the PDF (else DOCX), `uploaded_by` = caller; `report_files`, `report_annexures`, value snapshot; audit `REPORT_GENERATED`; staff-only thread event "Report version n generated by …". A retry with the same `report_id` returns it (`created: false`) |
| `generated_reports_guard` | API roles cannot insert a `generated` version directly, nor update / delete a generated version, its files or annexures. Uploaded versions are unchanged |
| Storage `reports` | Office users may also write `{case_id}/{report_id}/report.{pdf|docx}` on cases they manage; nobody overwrites such an object through the API (update policy excludes the scheme; no delete policy, and Storage blocks direct deletes) |

Approval, `approve_own_report`, `request_report_send`, `request_portal_pack` and `record_manual_submission` read the latest version as before and work unchanged with generated versions.

### Completing field work and closing a case (`20261119100000_task_complete_case_close.sql`)

| Object | Purpose |
|---|---|
| `complete_field_task(task, note)` | Security definer. The **assigned, active field operator** on their own task, or **staff who manage the case** (`can_manage_case`, D44; orchestrator / admin all). Task pending / in progress; case not `submitted` (left-over work there is cancelled, D46), `closed` or `cancelled`. Only `tasks.status` changes; the triggers set `completed_at` (server time), post the thread event, notify the owner, end the hold (the D43 late-upload window starts) and move the case `field_in_progress` → `office_review` when no open task is left. Optional note ≤ 1000: a system message visible on the case when the operator wrote it, staff-only when staff did (D32). Staff completion notifies the operator (`task_completed`). Audit `TASK_COMPLETED` (`by`: operator / office) |
| `tasks_after_change` (changed) | The completion event names who acted: "&lt;operator&gt; marked field work complete: …" or "Field work marked complete by the office: …"; the owner is not notified of their own action |
| `tasks_field_guard` (changed) | Field users cannot complete a task with a direct `UPDATE` (API roles); completion goes through `complete_field_task`. Starting a task (pending → in progress, `post_thread_message`) is unchanged, so `p_tasks_field_u` stays |
| `close_case(case, note)` | Security definer; owner / orchestrator / admin. Only from `submitted`, no open field task, and the **latest submission acknowledged** (`record_submission_ack`). Orchestrator / admin may close without an acknowledgement with a reason of 3–500 characters (P7); office staff record the acknowledgement first. Status `closed` (history row and `closed_at` by the status trigger), note in the history ("Closed: …" / "Closed without acknowledgement: …"), staff-only thread event, owner notified `case_closed` when someone else closed, audit `CASE_CLOSED`. A closed case is final: `reopen_case` still accepts only `submitted` |
| `cases_closed_guard` | API roles cannot move a case into or out of `closed` with a direct `UPDATE` (the staff case policy allows status writes); `close_case` and system jobs are not affected |

## Case status automation

| Event | Status change |
|---|---|
| Case created | `received` |
| Office employee assigned | `received` → `assigned` |
| Field task / request created | `assigned`, `office_review`, `orchestrator_review` → `field_in_progress` |
| Last open task completed (`complete_field_task`, operator or office) or cancelled | `field_in_progress` → `office_review` |
| Approval requested (no open task, required fields filled) | `assigned`, `office_review` → `orchestrator_review` |
| Changes requested | `orchestrator_review` → `office_review` |
| Submission recorded | → `submitted` |
| Case reopened on an insurer query (`reopen_case`) | `submitted` → `office_review` |
| Case closed after the insurer's acknowledgement (`close_case`) | `submitted` → `closed` (final) |

Every change is written to `case_status_history` and shown in the thread as a system message where relevant.

## Rules enforced in the database

| Rule | Mechanism |
|---|---|
| No duplicate cases / emails / evidence | Unique `(insurer_id, insurer_claim_no)`, message id, `(case_id, sha256)` |
| Evidence immutable | `evidence_guard`: only flag, relevance (staff), withdraw (via function, once), archive (archive job, once) may change; no delete |
| Trusted time | `server_received_at`, `created_at` set by the database; messages stamped on insert |
| Files from gallery / share accepted, unmarked (D18) | `evidence_autoflag` no longer flags; origin kept in `capture_source` |
| Thread consistency | Evidence message must be in the same case and sent by the uploader; replies and tasks in the same case |
| Field users update task status only; completion only through `complete_field_task` | `tasks_field_guard` |
| A case is closed only through `close_case` and stays closed | `cases_closed_guard` |
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
