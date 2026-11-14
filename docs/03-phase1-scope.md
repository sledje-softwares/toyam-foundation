# 03 — Phase 1 Scope (revised 2026-11-13)

The revised workflow (D14–D26 in `07-decisions-and-open-questions.md`) replaces the earlier "intake → orchestrator assigns → Word upload" flow. Full scope is kept.

## Objective

Replace copy-paste intake, manual routing and WhatsApp evidence sharing with one system: insurer emails fill the right template automatically, cases route themselves to office staff, field operators work in a familiar chat-style app, every file is read and labelled, and office staff build the report section by section with the relevant images beside them — then send it on the insurer's own email thread.

## The flow

```
Insurer email (shared Gmail)
  → insurer + claim type + variant detected (sender domain, subject pattern)
  → that template's intake fields filled by rules (AI only as fallback)          [M3]
  → case created; automatically assigned to an office employee                   [M4]
      orchestrator reassigns when needed; notified when nobody is available
  → office employee assigns field work to an operator (checklist attached)       [M4]
  → operator works in the case thread: camera, gallery, share-from-any-app,      [M5]
      text, voice; office replies in the same thread; re-investigation = request
  → every file: text extraction / OCR, labels by evidence category               [M6]
  → office fills the report: each section shows its relevant images;            [M7]
      tap an image → OCR text → tap to fill; suggested values to accept
  → approval (per template) → report generated as PDF and/or Word                [M8]
  → sent as a reply on the insurer's thread (or portal pack)                     [M8]
```

## Success measures (pilot)

- New case visible and assigned within minutes of the insurer's email, with intake fields pre-filled.
- Field evidence reaches the office in near real time; 100% of pilot cases without WhatsApp.
- Office staff find the image for any report field without scrolling a chat.
- Zero duplicate cases; every file traceable to case, sender, time and (for in-app captures) location.
- No paid per-report service in the default path (D25).

## In scope

| Area | Included |
|---|---|
| Intake | Gmail relay, insurer/template detection, rule-based field fill, AI fallback, review queue for uncertain cases, duplicate and follow-up matching, insurer attachments stored as case evidence |
| Routing | Assignment rules (insurer / claim type pools, least-loaded or round-robin), availability and case caps, automatic assignment, reassignment with reason, escalation notifications |
| Field work | Field tasks with checklists (by office staff), re-investigation requests in the thread |
| Field app (Android) | Open / Completed case lists, chat thread per case, in-app camera, gallery and document picker, share target, offline queue with delivery ticks, voice notes, pinned checklist with one-tap tags, withdraw, push notifications |
| Processing | Job queue; PDF text layer; vision-model labelling of every file (D30, D34); on-device OCR + server OCR where needed; field suggestions; office label corrections |
| Report workspace | Template sections and fields, relevant images per section, OCR viewer with tap-to-fill, suggestions, annexure selection, generated report (PDF / Word option) |
| Approval & sending | Approval per template, reply on the insurer thread with allowed formats, portal pack, submission record |
| Oversight | Dashboard, notifications, audit log, archive and purge (D13) |

## Out of scope (later phases)

AI-drafted narrative sections; transcription of statements; portal automation; billing and payouts; cross-case fraud analytics (entities are captured now); letter generation for reminder letters (Q16).

## Roles

| Role | Responsibilities |
|---|---|
| Admin | Users, insurers, templates and categories (config), assignment rules, settings, audit log |
| Orchestrator | Oversees routing; reassigns cases; approves reports where required; receives escalations |
| Office | Owns assigned cases: confirms uncertain intake, assigns field work, talks to operators in the thread, fills and sends the report |
| Field | Works assigned cases in the app: captures and shares files, messages the office, completes tasks |

## Case lifecycle (no new statuses — rule 1)

| Status | Meaning in the revised flow | Moved by |
|---|---|---|
| `received` | Case created, not yet assigned to an office employee | intake |
| `assigned` | Office employee assigned (auto or manual) | assignment |
| `field_in_progress` | At least one field task is open | creating a field task / request |
| `office_review` | All field tasks done; report being prepared (also after "changes requested") | last task completed |
| `orchestrator_review` | Approval requested | approval request |
| `submitted` | Report sent | submission |
| `closed` / `cancelled` | Finished / withdrawn by the insurer | staff |

`intake_confirmed` is no longer used (kept in the enum; treated like `received`). A re-investigation request moves the case back to `field_in_progress`.

## Gaps found in the revised plan and how the design closes them

| # | Gap | Resolution |
|---|---|---|
| G1 | No review before the email goes out | Approval per template (D23); DB refuses unapproved submissions |
| G2 | Re-investigation loop missing | Request = new task posted into the thread; case returns to field work |
| G3 | Gallery/shared files and integrity | Accepted without mark (D18); origin kept internally; in-app captures still carry GPS + hash |
| G4 | Chat UI loses structure | LLM labels every file within seconds (D30); the pinned checklist ticks itself, so the operator sees what is missing while still on site; optional one-tap tag |
| G5 | Nothing linked images to report sections | Evidence categories shared by checklist, labels and sections (D20) |
| G6 | Who maintains 40+ templates | YAML files under `config/templates/`, versioned on load |
| G7 | Picking the right template | Sender domain + subject pattern per template; uncertain → review queue |
| G8 | "Available" undefined | Availability + leave-until + case cap per user; escalation |
| G9 | One-way thread | Two-way (D17) |
| G10 | Accidental uploads vs. immutability | Withdraw window (D19) |
| G11 | Email size / format | PDF with compressed annexures; formats per template; link for oversize packs (M8) |
| G12 | Portal insurer | Portal pack + manual submission record |
| G13 | Handwritten / Hindi documents | OCR for printed text; zoom viewer for handwriting; expectations set |
| G14 | Several operators per case | One thread per case shared by all operators on it |
| G15 | When is a case "completed" for an operator | When the operator has no open task on it; a new request reopens it |
| G16 | Personal phones | App-private cache, no gallery save, remote sign-out (M2 K5) |
| G17 | Orchestrator comments on a report would reach field users through the shared thread | Staff-only messages (D32); orchestrator live view of the report (D31) |

### Further findings from the sample threads and reports (2026-11-13)

| # | Finding | Effect on the design |
|---|---|---|
| S1 | Insurer emails carry a stable two-column "Claim Intimation Details" table and a structured subject (`OD \|\| claim \|\| insured \|\| TWL`; `OD Investigation Case No - MOT… // vehicle // insured`) | Rule-based intake is enough for these insurers; AI is fallback only (D25, D26) |
| S2 | Each email lists **points to investigate** (RCU trigger / red flags) | Stored as an intake field; office can turn points into checklist items |
| S3 | One insurer sends **20+ attachments** (vehicle views, DL, Aadhaar, policy, estimate, e-claim) with descriptive file names | Stored as case evidence and labelled for free by file-name rules (all 11 sample names matched) |
| S4 | Threads continue after the first email: reassignment requests, "complete and re-submit", reminder letters, PODs, updated / rectified reports | Follow-ups attach to the case; report versions; reminder letters and PODs are evidence categories (Q16) |
| S5 | Insurer Reliance General now mails from **indusindinsurance.com**; reports address "IGICL" | Insurer identity by domain list; names confirmed in admin |
| S6 | Insurers write to both the Gmail and `gi@toyaminvestigation.in`; the firm replies from `gi@` | Intake reads one mailbox; firm's own addresses are internal (Q15). A domain exists (Q14) |
| S7 | Reports use the firm's reference (`TIVPL_ILGIC_10/2026`), "Compiled by", status (Repudiate / insurer discretion) and repudiation ground | Template fields; case reference format is Q13 |
| S8 | Variants differ within one insurer (OD vs THEFT) | Template key includes a variant |
| S9 | CCTV and videos are shared as Google Drive links in reports | Video category; large files via R2; links allowed in text fields |

## Workload sizing

| Metric | Estimate |
|---|---|
| Cases per working day | ~14 |
| Evidence per case | ~50–60 images in sample reports, plus insurer attachments (Q9) |
| Evidence storage | ~20–30 GB/month after on-device compression (≈0.5 MB/photo) |
| AI cost | Fallback only; negligible at this volume |

The bottleneck is office review and report writing — the report workspace (M7) carries the largest saving.
