# 03 — Phase 1 Scope

## Objective

Replace email-to-Word copy-paste and WhatsApp evidence sharing with a single system that receives cases automatically, lets the orchestrator assign and track work, and lets field operators submit structured, verifiable evidence against each case.

## Success measures (pilot)

- Intake time per case reduced to minutes.
- Field evidence available to the office in near real time.
- 100% of pilot cases handled without WhatsApp.
- Zero duplicate cases.
- Every evidence item traceable to case, person, time and location.

## In scope

- Email intake with AI extraction and human review.
- Case and task management with flexible, addable tasks.
- Orchestrator assignment of cases and tasks.
- Android field app: checklist, photo/document/audio capture, GPS and time stamping, offline support.
- Office evidence view grouped by checklist item.
- Re-investigation requests as linked tasks.
- Pre-filled insurer report template (Word); manual report writing and versioned upload.
- Submission by email; portal pack for the portal insurer; submission tracking.
- Basic dashboard and deadline alerts.
- Roles, row-level access control, audit log.

## Out of scope (later phases)

AI-drafted reports; cross-verification; transcription; red-flag scoring; investigator recommendation; portal automation; billing and payouts; fraud analytics. Hospitals, garages, doctors and agents are **captured** in Phase 1 for later use.

## Roles

| Role | Responsibilities |
|---|---|
| Admin | Users, insurers, checklist templates, audit log |
| Orchestrator | Confirms intake, assigns, requests re-investigation, approves submission |
| Office | Confirms extracted data, reviews evidence, prepares and uploads reports |
| Field | Views assigned tasks, captures evidence, completes checklist items (mobile only) |

## Case lifecycle

```
received → intake_confirmed → assigned → field_in_progress
        → office_review → orchestrator_review → submitted → closed
(cancelled is available from any open state)
```

Re-investigation does not introduce a new status: the orchestrator creates a `re_investigation` task and the case returns to `field_in_progress`. History is retained in `case_status_history`.

## Workload sizing

| Metric | Estimate |
|---|---|
| Cases per working day | ~14 |
| Evidence storage | ~15–25 GB/month (~200–300 GB/year), assuming 30–50 items per case after on-device compression |
| AI extraction cost | Negligible at this volume |

The operational bottleneck is office review and the review loop, not field capture.
