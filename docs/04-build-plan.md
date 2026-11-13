# 04 — Phase 1 Build Plan

**Basis:** single developer working with Claude; 10 insurers; ~300 cases/month; 10 field operators.

Piece IDs (e.g. `3.6`) are stable references for issues, branches and commits.

## 1. Module overview

| ID | Module | Purpose | Est. (days) |
|---|---|---|---|
| M0 | Discovery & Setup | Client inputs; environments | 4 |
| M1 | Platform Foundation | Database, authentication, roles, storage, deployment | 4 |
| M2 | Administration & Master Data | Users, insurers, checklist templates | 3 |
| M3 | Email Intake | Incoming emails → confirmed cases | 9 |
| M4 | Case & Task Management | Lifecycle, assignment, re-investigation | 7 |
| M5 | Field App (Android) | Task checklist and evidence capture | 12 |
| M6 | Office Review & Reports | Evidence review, pre-filled report, versions | 6 |
| M7 | Submission & Tracking | Email submission, portal pack, acknowledgements | 3 |
| M8 | Dashboard & Notifications | Status overview, deadline alerts | 3 |
| M9 | Security, Audit & Compliance | Access verification, retention, backups | 2 |
| M10 | Testing, Pilot & Rollout | UAT, training, pilot, go-live | 10 |
| | **Total** | | **≈ 63 working days (≈ 12–13 weeks)** |

## 2. Module breakdown

### M0 — Discovery & Setup (4 days)

| # | Piece | Output |
|---|---|---|
| 0.1 | Collect sample emails | 20–30 per insurer, with attachments |
| 0.2 | Collect report formats | Each insurer's format and 2–3 completed samples |
| 0.3 | Define checklists | Checklist per claim type, agreed with orchestrator |
| 0.4 | Map current process | One case walked end-to-end; exceptions noted |
| 0.5 | Confirm open items | Workspace vs Gmail, phones, data residency, portal, pilot insurer |
| 0.6 | Set up environments | Dev/prod projects, repository, domain, Android signing keys |

**Exit:** all inputs received; checklists and field list signed off by the client.

### M1 — Platform Foundation (4 days)

| # | Piece | Output |
|---|---|---|
| 1.1 | Database | Schema deployed; migrations workflow *(schema drafted)* |
| 1.2 | Authentication | Email login for staff; OTP login for field operators |
| 1.3 | Roles & access | RLS verified for all four roles |
| 1.4 | File storage | R2 bucket for evidence (presigned upload/download via server function); Supabase buckets for raw emails and reports; per-case folder structure |
| 1.5 | Web app shell | Layout, navigation, role-based menus |
| 1.6 | Deployment | Automatic deploys to dev/prod; error monitoring |

**Exit:** each role logs in and sees only what it is permitted to see.

### M2 — Administration & Master Data (3 days)

| # | Piece | Output |
|---|---|---|
| 2.1 | User management | Create, deactivate, assign role and region |
| 2.2 | Insurer configuration | Sender domains, TAT days, submission channel, report template |
| 2.3 | Checklist template editor | Add, reorder, mandatory and camera-only flags |
| 2.4 | Seed data | 10 insurers and agreed checklists loaded |

**Exit:** the admin configures a new insurer and its checklist without developer help.

### M3 — Email Intake (9 days)

| # | Piece | Output |
|---|---|---|
| 3.1 | Gmail connection | Cloudflare Worker polls Gmail (IMAP, 1-min cron) and relays raw messages to Supabase; Email Routing handler added once a domain exists; idempotent ingestion |
| 3.2 | Email storage | Raw email and attachments stored; hashes recorded |
| 3.3 | Insurer identification | Sender-domain match; unknown senders to review queue |
| 3.4 | Classification | New case / reminder / additional documents / query |
| 3.5 | OCR | Text extracted from scanned PDFs and images |
| 3.6 | AI field extraction | Fields with confidence scores; per-insurer hints |
| 3.7 | Case matching | Link by claim/policy no.; attach follow-up emails |
| 3.8 | Intake review screen | Pre-filled form, low-confidence highlights, confirm → case |
| 3.9 | Acknowledgement | Optional automatic reply to the insurer |
| 3.10 | Error handling | Failed emails visible with retry; nothing lost silently |

**Exit:** >95% of sample emails correctly classified; a case confirmed in under 2 minutes; duplicates rejected.

### M4 — Case & Task Management (7 days)

| # | Piece | Output |
|---|---|---|
| 4.1 | Case list | Filters (status, insurer, due date); search (ref, claim no., name) |
| 4.2 | Case detail | Overview, parties, entities, emails, tasks, evidence, history |
| 4.3 | Parties & entities | Add/edit parties; link hospitals, garages, doctors (de-duplicated) |
| 4.4 | Task creation | Select template → copy checklist → edit per case |
| 4.5 | Assignment | Assign operator, due date, visit location |
| 4.6 | Re-investigation | "Request more information" → linked task with reason |
| 4.7 | Status transitions | Controlled transitions with history and reason |

**Exit:** the orchestrator takes a case from intake through assignment and re-investigation entirely in the system.

### M5 — Field App, Android (12 days)

| # | Piece | Output |
|---|---|---|
| 5.1 | Login & session | OTP login, persistent session, remote sign-out |
| 5.2 | Task list | "My tasks" and "Today"; case summary and location |
| 5.3 | Task detail & checklist | Item progress; mandatory items enforced before completion |
| 5.4 | Photo capture | In-app camera; compression; GPS, time and hash |
| 5.5 | Document capture | Scan mode with edge crop |
| 5.6 | Audio & notes | Recorded statements with consent prompt; text notes |
| 5.7 | Offline queue | Capture offline; automatic upload with retry; progress shown |
| 5.8 | Task status | Start and complete; mark item "not available" with reason |
| 5.9 | Notifications | New task and re-investigation alerts |
| 5.10 | Build & distribution | Signed APK / Play internal track; testing on low-end devices |

**Exit:** a full visit completed offline; all evidence reaches the case within minutes of reconnecting, with complete metadata.

### M6 — Office Review & Reports (6 days)

| # | Piece | Output |
|---|---|---|
| 6.1 | Evidence viewer | Grouped by task and checklist item; gallery, map, timestamps, audio |
| 6.2 | Completeness view | Missing mandatory items and flagged evidence highlighted |
| 6.3 | Evidence flagging | Office flags or clears evidence with reason |
| 6.4 | Pre-filled Word report | Insurer template populated with case data and annexure index |
| 6.5 | Report upload | Versioned upload; draft/final; notes |
| 6.6 | Review hand-off | Send to orchestrator review; return with comments |

**Exit:** office staff prepare a report without leaving the system; the pre-filled report matches each insurer's format.

### M7 — Submission & Tracking (3 days)

| # | Piece | Output |
|---|---|---|
| 7.1 | Email submission | Final report and annexures sent on the original email thread |
| 7.2 | Portal pack | Download named and ordered for the portal insurer |
| 7.3 | Submission record | Channel, date, portal reference, acknowledgement date |
| 7.4 | Case closure | Close after submission; reopen on insurer query |

**Exit:** every submitted case has a recorded submission traceable to the report version sent.

### M8 — Dashboard & Notifications (3 days)

| # | Piece | Output |
|---|---|---|
| 8.1 | Overview | Cases by status and insurer; overdue and due-soon lists |
| 8.2 | Workload | Open tasks per operator |
| 8.3 | Turnaround | Average days per stage and per insurer |
| 8.4 | Alerts | Due-soon and overdue alerts; daily summary email |

### M9 — Security, Audit & Compliance (2 days)

| # | Piece | Output |
|---|---|---|
| 9.1 | Access testing | RLS tests per role, including cross-operator access attempts |
| 9.2 | Audit log viewer | Admin view of the audit log |
| 9.3 | Backups | Backup and restore test |
| 9.4 | Retention | File retention and archive policy as agreed with the client |
| 9.5 | Privacy | Consent wording for statements; staff privacy note |
| 9.6 | Archive sync (admin PC) | Daily download of new evidence, emails and reports per case; SHA-256 re-check; manifest; database backup; catch-up after missed days; restore to cloud on reopen |
| 9.7 | Cloud purge job | Removes cloud copies of evidence only after verified archive and ≥7 days after submission; records stay |

### M10 — Testing, Pilot & Rollout (10 days)

| # | Piece | Output |
|---|---|---|
| 10.1 | Acceptance testing | End-to-end with client staff on sample cases |
| 10.2 | Training | Short guides and in-person sessions for each role |
| 10.3 | Pilot | One insurer, 2–3 operators, parallel run for two weeks |
| 10.4 | Pilot fixes | Feedback-driven corrections |
| 10.5 | Go-live | All insurers and operators; WhatsApp retired for case evidence |

**Exit:** pilot cases completed fully in the system; client sign-off for go-live.

## 3. Sequence and milestones

| Week | Work | Milestone |
|---|---|---|
| 1 | M0, M1 | — |
| 2 | M1, M2 | **MS1** Platform ready; insurers and checklists configured |
| 3–4 | M3 | **MS2** Emails become confirmed cases automatically |
| 5 | M4 | **MS3** Cases assigned and tracked in the system |
| 6–8 | M5 | **MS4** Field evidence captured end-to-end |
| 9 | M6, M7 | **MS5** Report and submission completed in the system |
| 10 | M8, M9, UAT | **MS6** Ready for pilot |
| 11–12 | Pilot, fixes | **MS7** Pilot sign-off |
| 13 | Go-live | **MS8** Full rollout |

**Dependencies:** M3 and M4 require M1–M2; M5 requires M4; M6 requires M5; M7 requires M6.

## 4. Client inputs and timing

| By | Input |
|---|---|
| Week 1 | Sample emails, report formats, checklist sign-off, Gmail access, portal details |
| Week 2 | Staff list with roles and phone numbers |
| Week 6 | Two field operators available for app testing |
| Week 10 | Pilot insurer and participants confirmed; training slots |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Delayed inputs in week 1 | Run M1–M2 in parallel; stub M3 with available samples |
| Field app overrun (largest module) | Build the offline queue first; minimal interface |
| Greater variation in insurer formats | Per-insurer extraction hints; review screen as safety net |
| Field operator resistance | Involve two operators from week 6; accept evidence only via the app after the pilot |
