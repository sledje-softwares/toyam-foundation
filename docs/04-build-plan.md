# 04 — Phase 1 Build Plan (revised 2026-11-13)

**Basis:** single developer working with Claude; 10 insurers; ~300 cases/month; 10 field operators; revised workflow D14–D26; **full scope** kept.

Piece IDs (e.g. `5.4`) are stable references for issues, branches and commits. The module list was renumbered for the revised flow on 2026-11-13; old → new: M4 → M4 (routing) + part of M5, M5 → M5, M6 → M7, M7 → M8, M8 → M9, M9 → M10 (old 9.6/9.7 are now 10.6/10.7), M10 → M11. M0–M3 keep their numbers; M2 pieces 2.1–2.4 (design `08-m2-admin-design.md`) are unchanged.

Status legend: ✅ done · 🟡 in progress · 🗄 database layer done (migration `20261113000100_revised_flow.sql`, tests `07_revised_flow.test.sql`) · ⬜ not started

## 1. Module overview

| ID | Module | Purpose | Days | Status |
|---|---|---|---|---|
| M0 | Discovery & Template Definition | Client inputs; templates and categories per insurer | 5 | 🟡 samples for 2 insurers received |
| M1 | Platform Foundation | Database, auth, roles, storage, deployment | 4 | ✅ (hosted `toyam-dev` partially migrated) |
| M2 | Administration & Template Configuration | Users, availability, insurers, checklists, template loader | 4 | 🟡 DB done; UI pending |
| M3 | Email Intake & Auto-fill | Gmail relay → template detection → rule-based field fill | 8 | 🟡 built and tested; review screen and live Gmail test pending |
| M4 | Routing & Assignment | Auto-assign to office, reassign, office → field tasks, escalation | 4 | 🗄 / ⬜ UI |
| M5 | Field App (chat style, Android) | Threads, camera, gallery, share target, offline, ticks | 16 | 🗄 / ⬜ app |
| M6 | Processing Pipeline | Queue, OCR, labelling, suggestions, corrections | 6 | 🗄 / ⬜ workers |
| M7 | Report Workspace | Sections, relevant images, tap-to-fill, generation (PDF/Word) | 10 | 🗄 / ⬜ UI + generator |
| M8 | Approval, Sending & Tracking | Approval, reply on thread, portal pack, submission records | 4 | 🗄 / ⬜ sender |
| M9 | Dashboard & Alerts | Workload, ageing, turnaround, escalations | 3 | ⬜ |
| M10 | Security, Audit & Compliance | Access tests, devices, backups, archive, retention | 2 | 🟡 RLS tested; archive jobs pending |
| M11 | Testing, Pilot & Rollout | UAT, training, two-week pilot, go-live | 10 | ⬜ |
| | **Total** | | **≈ 76 working days (≈ 15 weeks)** | |

## 2. Module breakdown

### M0 — Discovery & Template Definition (5 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 0.1 | Collect sample emails | 20–30 per insurer, with attachments, incl. follow-ups | 🟡 IGI (Reliance) ×4, ICICI ×1 |
| 0.2 | Collect report formats | Each insurer's format (Word layout) and 2–3 completed samples | 🟡 IGI, ICICI |
| 0.3 | Define categories and checklists | Evidence categories and field checklist per claim type | 🟡 `config/templates/_categories.yaml` drafted |
| 0.4 | Write templates | One YAML per insurer × claim type × variant | 🟡 `igi-motor-od.yaml`, `icl-motor-od.yaml` drafted |
| 0.5 | Confirm open items | Q2–Q18 in `07` | ⬜ |
| 0.6 | Environments | Dev/prod projects, repository, domain, Android signing keys | 🟡 |

**Exit:** templates for all pilot insurers loaded and signed off.

### M1 — Platform Foundation (4 days) ✅

| # | Piece | Output |
|---|---|---|
| 1.1 | Database | Schema + migrations workflow ✅ |
| 1.2 | Authentication | Email login for staff; mobile + password for field (K4) ✅ |
| 1.3 | Roles & access | RLS verified for all four roles ✅ |
| 1.4 | File storage | R2 for evidence (presigned via server function); Supabase buckets for raw emails, reports, report templates ✅ |
| 1.5 | Web app shell | Layout, navigation, role menus ✅ |
| 1.6 | Deployment | Cloudflare Workers (OpenNext) ✅; error monitoring ⬜ |

### M2 — Administration & Template Configuration (4 days)

Build order (2026-11-14): UI foundation (T2-T4), then 3.9/3.10 intake review and failed mail, then users (2.1), insurers (2.2), checklists (2.3), then 2.6; see `08-m2-admin-design.md`, Session 5 decisions.

| # | Piece | Output | Status |
|---|---|---|---|
| 2.1 | User management | Per `08-m2-admin-design.md` | 🗄 / ⬜ UI |
| 2.2 | Insurer configuration | Domains, TAT, submission channel, report template | 🗄 / ⬜ UI |
| 2.3 | Checklist editor | Items gain an evidence category | 🗄 / ⬜ UI |
| 2.4 | Seed / master data session | Real insurers, staff, checklists | ⬜ |
| 2.5 | Template loader | Script: YAML → JSON → `load_evidence_categories()` / `load_case_template()`; validation report; run in CI against the local stack | ✅ `services/intake/scripts/load-templates.ts` |
| 2.6 | Availability & assignment rules screens | Staff availability, leave-until, case cap; rules and pools | 🗄 / ⬜ UI |

### M3 — Email Intake & Auto-fill (8 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 3.1 | Gmail relay | **Push (D33):** Gmail filter forwards insurer mail → Email Routing → Worker `email()` → function. **Safety net:** hourly IMAP poll, insurer senders only. Idempotent | ✅ `services/intake/worker` (push handler and poll tested in Node; live run pending, DNS Q14) |
| 3.2 | Email storage | Raw `.eml` + attachments in `email-raw`; hashes | ✅ edge function `intake` |
| 3.3 | Insurer & template detection | Sender domain → insurer; `intake_rules.subject_pattern` → variant + claim no; firm's own addresses = internal (Q15) | ✅ |
| 3.4 | Classification | New case / follow-up / reminder / additional documents / query (subject + thread + existing case) | ✅ |
| 3.5 | Rule-based field fill | Two-column label/value table parser; `extract.labels` aliases; investigation-points block | ✅ (HTML path to confirm on real `.eml`, Q19) |
| 3.6 | AI fallback | Only when required fields are missing; output goes to the review queue (D26) | ⬜ deferred until real mails show a need (D25) |
| 3.7 | Case creation & matching | Create case (`template_id`, `case_field_values`) when complete; attach follow-ups by thread / claim no. | ✅ `intake_ingest()` |
| 3.8 | Insurer attachments → evidence | `capture_source = email_attachment`; labelled by file-name rules | ✅ (labelling runs in M6) |
| 3.9 | Intake review screen | Uncertain cases only; highlight missing / low-confidence fields | 🗄 `confirm_intake()` / `reject_intake()`; ✅ UI (`/intake`, `/intake/[id]`, nav badge) |
| 3.10 | Error handling | Failed emails visible with retry | 🗄 `intake_record_failure()`, queued retry (D39): `request_intake_retry()` → Worker */10 cron → `?retry=<email id>`, stuck alerts in-app + one email; ✅ failed-mail list; ✅ UI wiring of the queued retry (retry button, stuck banner, nav badge) |

**Exit:** sample emails of the pilot insurers become complete cases without review; follow-ups attach to the right case.

### M4 — Routing & Assignment (4 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 4.1 | Automatic office assignment | Rules, least-loaded / round-robin, availability, caps; on case creation | 🗄 |
| 4.2 | Reassignment | Orchestrator action with reason; history; notification | 🗄 / ⬜ UI |
| 4.3 | Field task assignment | Office picks operator, checklist, due date, location (`create_field_task`) | 🗄 / ⬜ UI |
| 4.4 | Re-investigation request | Request in the thread → linked task; case back to field work | 🗄 / ⬜ UI |
| 4.5 | Escalation | `escalate_unattended_cases()` every 10–15 min (pg_cron or Worker cron) | 🗄 / ⬜ schedule |
| 4.6 | Case list & detail | Filters, search, thread, evidence, history | ⬜ |
| 4.7 | Staff notes | Staff-only messages in the case thread (D32) | 🗄 / ⬜ UI |

### M5 — Field App, chat style (16 days)

Detailed UX: `docs/11-field-app.md`.

| # | Piece | Output | Status |
|---|---|---|---|
| 5.1 | Sign-in & session | Mobile + password; persistent; remote sign-out = send what was captured before deactivation, then wipe (D43: `register_field_device()`, edge function `field-drain`); sign-out blocked while files wait | 🗄 / ⬜ |
| 5.2 | Case list | Open / Completed tabs, last message, unread badge (`field_case_list()`) | 🗄 / ⬜ |
| 5.3 | Case thread | Messages, system events, requests, replies; read pointer | 🗄 / ⬜ |
| 5.4 | In-app camera | Compression, GPS, time, SHA-256, burst capture | ⬜ |
| 5.5 | Gallery & document picker | Multi-select; EXIF kept | ⬜ |
| 5.6 | Android share target | "Share → Toyam" → pick case thread → send (needs a custom dev build) | ⬜ |
| 5.7 | Offline queue & ticks | 🕓 saved on this phone → ✓ stored → ✓✓ processed → blue ✓✓ seen by office; idempotent resend (`client_message_id`). D43 offline experience (docs/11): amber offline bar, Outbox screen, WorkManager background upload, freshness labels, hollow pending ticks, "All N files sent ✓", low-storage warning; late uploads after a task closes (72 h); `report_outbox_status()` → office sees files waiting on a phone (`case_outbox_status()`) | 🗄 / ⬜ |
| 5.8 | Pinned checklist & tags | Progress from `v_case_checklist`; optional one-tap category on send | 🗄 / ⬜ |
| 5.9 | Voice notes & text | Recorded statements with consent prompt | ⬜ |
| 5.10 | Withdraw | Within the window (D19) | 🗄 / ⬜ |
| 5.11 | On-device OCR | ML Kit text recognition sent with the file | 🗄 / ⬜ |
| 5.12 | Push notifications | FCM; `device_tokens`; local notifications for "All N files sent ✓" and the 6 h gentle prompt (D43) | 🗄 / ⬜ |
| 5.13 | Build & distribution | Signed APK / Play internal track; low-end device testing | ⬜ |

**Exit:** a full visit works offline; files appear in the office thread within minutes of reconnecting; share-from-gallery works from WhatsApp, Files and Gallery.

### M6 — Processing Pipeline (6 days)

Contract: `docs/10-processing-pipeline.md`.

| # | Piece | Output | Status |
|---|---|---|---|
| 6.1 | Queue | Jobs per evidence and stage; claim / complete / retry with back-off. Worker: one always-on container in a Mumbai region running `services/pipeline`, Dockerfile, provider-neutral (D38) | 🗄 |
| 6.2 | Text extraction | PDF text layer (no OCR when present) | ⬜ |
| 6.3 | OCR | Device OCR accepted; server OCR (dedicated OCR model, PaddleOCR family) on the fixed-cost worker **only where `ocr_wanted()`** — runs after labelling (D34) | 🗄 / ⬜ |
| 6.4 | Labelling | **LLM vision labels** (template categories + description) as the main path; file-name rules for insurer attachments and operator tags first (D30); results fast enough to tick the field checklist on site. One image per call at ~384 px, `needs_detail` flag, Haiku 5.5 first, low-confidence escalation to Sonnet 5.5 on the standard API (D37), model stored per label (D34). Prompt, parser and provider adapters in `services/labeller/src` | 🗄 / ⬜ (adapters ✅) |
| 6.5 | Field matching & suggestions | Field matches come from the **label call** (`evidence_field_matches`, D35); pattern rules on OCR text suggest values (dates, numbers, DL / RC / policy no.) | 🗄 / ⬜ |
| 6.6 | Corrections & metrics | `set_evidence_labels()`; accuracy per label source; reprocessing by version | 🗄 / ⬜ |
| 6.7 | Model bake-off | `npm run bakeoff -w services/labeller` on ≥ 5 real cases labelled by the office: label accuracy (documents / photos), field-match precision / recall, "needs detail" recall, description rate, confidence routing, cost per case and month, latency (D34, D35). Arms: Haiku 5.5 and Sonnet 5.5 × single images and numbered 6×6 collages (`--layouts single,6x6`, D36) | ✅ script / ⬜ run (needs Q21) |
| 6.9 | Ground-truth labelling tool | Offline single HTML file `services/labeller/tools/truth-labeller.html`; the office labels real cases and exports `truth.csv` for the bake-off | ✅ |
| 6.10 | Model cost recording | Tokens and cost per processing job; monthly budget with an alert at 80 %; shown in M9 | ⬜ |

### M7 — Report Workspace (10 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 7.1 | Section form | Template sections and fields; intake values pre-filled | 🗄 / ⬜ |
| 7.2 | Relevant images panel | Images whose active label is in the section's categories; plus unlabelled | 🗄 / ⬜ |
| 7.3 | OCR viewer & tap-to-fill | Highlighted blocks; tap to copy into the focused field | 🗄 / ⬜ |
| 7.4 | Suggestions | Accept / reject suggested values with source reference | 🗄 / ⬜ |
| 7.5 | Relevance & labels | Mark not relevant; correct labels | 🗄 / ⬜ |
| 7.6 | Annexures | Choose and order images per section | 🗄 / ⬜ |
| 7.7 | Generation | Word from the insurer layout (`docx_template_path`) and/or PDF; versioned `reports` + `report_files` | 🗄 / ⬜ |
| 7.8 | Orchestrator live view | Read-only report in progress: section progress, value sources, change history, live updates; staff notes alongside (D31) | 🗄 / ⬜ UI |

### M8 — Approval, Sending & Tracking (4 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 8.1 | Approval | Request, approve / request changes (per template) | 🗄 / ⬜ UI |
| 8.2 | Send on thread | Reply on the original thread with CC; formats allowed by template; Gmail SMTP | 🗄 / ⬜ sender |
| 8.3 | Size handling | Compressed annexures; secure link when over the limit | ⬜ |
| 8.4 | Portal pack | Files named and ordered for the portal insurer | ⬜ |
| 8.5 | Submission & reopen | Record; acknowledgement; reopen on insurer query | 🗄 / ⬜ |

### M9 — Dashboard & Alerts (3 days) ⬜

Workload per office employee and operator; ageing vs. TAT; turnaround per stage (`case_status_history`); escalations; daily summary; model cost against the monthly budget (6.10).

### M10 — Security, Audit & Compliance (2 days)

| # | Piece | Output | Status |
|---|---|---|---|
| 10.1 | Access testing | pgTAP per role (07 suite covers the revised flow) | ✅ |
| 10.2 | Audit log viewer | Admin screen | ⬜ |
| 10.3 | Backups | Backup and restore test | ⬜ |
| 10.4 | Retention | As agreed (Q4) | ⬜ |
| 10.5 | Privacy | Consent wording; staff note; sample data out of git (Q18) | ⬜ |
| 10.6 | Archive sync (admin PC) | Daily download + SHA-256 re-check + manifest + DB backup; catch-up; restore on reopen | ⬜ |
| 10.7 | Cloud purge job | Only after verified archive and ≥7 days after submission; records stay | 🗄 |

### M11 — Testing, Pilot & Rollout (10 days) ⬜

Acceptance testing; training; two-week pilot (one insurer, 2–3 operators) in parallel with WhatsApp; fixes; go-live.

## 3. Sequence and milestones

| Weeks | Work | Milestone |
|---|---|---|
| 1–2 | M0 (templates for pilot insurers), M2 UI, 2.5 loader | **MS1** Admin and templates ready |
| 3–4 | M3 intake, M4 routing | **MS2** Emails become assigned cases automatically |
| 5–8 | M5 field app | **MS3** Field thread end-to-end incl. share target and offline |
| 9 | M6 pipeline (on real pilot files) | **MS4** Files labelled and readable |
| 10–11 | M7 report workspace | **MS5** Report built and generated in the system |
| 12 | M8, M9, M10 | **MS6** Ready for pilot |
| 13–14 | Pilot, fixes | **MS7** Pilot sign-off |
| 15 | Go-live | **MS8** Full rollout |

Dependencies: M3/M4 need M2 templates; M5 needs M4 tasks; M6 is tuned on M5 data; M7 needs M6; M8 needs M7.

## 4. Client inputs and timing

| By | Input |
|---|---|
| Week 1 | Samples and report formats for the remaining insurers (Q17); domain/DNS owner (Q14); approval policy (Q11); case reference format (Q13) |
| Week 2 | Staff list with roles, phones, regions; assignment pools (Q12) |
| Week 5 | Two operators for app testing; their phone models (Q3) |
| Week 12 | Pilot insurer and participants (Q6); training slots |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Field app (largest module) overruns | Offline queue and thread first; voice notes and withdraw last |
| Share target behaves differently per Android version / OEM | Test on operators' actual phones from week 5 |
| Insurer formats drift | Parser rules in templates; AI fallback to review queue; failed-parse alerts |
| Operators keep using WhatsApp | Familiar chat UI; evidence accepted only through the app after the pilot |
| Real personal data in the repository | Move samples out of git (Q18) |
