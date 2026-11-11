# 02 — Automation Analysis (all phases)

Step-by-step view of what can be automated, what remains human, and in which phase it is delivered.

## Summary

| Step | Automation potential | Phase |
|---|---|---|
| 1. Case intake by email | High | 1 |
| 2. Manual data entry | Eliminated | 1 |
| 3. Triage and assignment | Medium–High (decision support) | 1 (manual assign), 3 (scoring & recommendation) |
| 4. Field collection | Very high | 1 |
| 5. Office review and report writing | High | 1 (pre-filled template), 2 (AI draft) |
| 6. Orchestrator review and re-investigation | Medium (coordination) | 1 |
| 7. Submission to insurer | High | 1 (email, portal pack), 3 (portal automation) |

## Step detail

### 1. Case intake by email
- Monitor the shared inbox; classify emails as new case, reminder, additional documents or query.
- Extract fields from body and attachments (OCR for scans) with per-field confidence.
- Detect duplicates by claim/policy number; attach follow-up emails to the existing case.
- Auto-acknowledge and start the insurer's turnaround clock.
- **Human:** confirms the pre-filled case; low-confidence fields are highlighted.
- **Edge cases:** poor scans, missing fields, cases split across several emails.

### 2. Manual data entry
- Removed entirely; replaced by the intake review screen.

### 3. Triage and assignment
- Red-flag indicators (early claim after inception, high amount, repeat entities, inconsistencies). *(Phase 3)*
- Suggested checklist per claim type — health, motor, death, etc. *(Phase 1 via templates)*
- Investigator recommendation by location, workload and experience. *(Phase 3)*
- **Human:** the orchestrator decides.

### 4. Field collection
- Mobile app with assigned tasks and checklists.
- Photos auto-tagged with case, checklist item, GPS, time and file hash.
- Recorded statements (with consent); document scanning.
- Offline capture with automatic upload.
- Visit verification via location; expense logging. *(Expenses: later phase)*

### 5. Office review and report writing
- Evidence organised by checklist item; completeness view. *(Phase 1)*
- Pre-filled insurer report template. *(Phase 1)*
- Cross-verification of dates, names, amounts; transcription and summaries; AI-drafted report with evidence references; gap list. *(Phase 2)*
- **Human:** edits and owns the conclusion.

### 6. Orchestrator review and re-investigation
- Review screen with flags and gaps.
- "Request more information" creates a specific follow-up task.
- Report versioning; re-investigation rounds tracked.

### 7. Submission
- Report pack compiled to insurer format; sent on the original email thread.
- Portal pack for the portal insurer; submission reference recorded.
- Portal automation *(Phase 3)*; invoicing and payment follow-up *(Phase 3)*.

## Cross-cutting concerns

| Concern | Approach |
|---|---|
| Dynamic flows | Case + task model rather than a rigid linear workflow |
| Data protection | Sensitive personal and health data (DPDP Act, 2023): role-based access, audit trail, retention policy, Indian hosting. Client to confirm legal specifics. |
| Audit trail | Who collected, changed or submitted what, and when |
| Management visibility | Dashboard: turnaround, ageing, workload, rework rate |
| Fraud intelligence | Recurring hospitals, garages, doctors and agents across cases *(Phase 3)* |
| Billing and payouts | Per-case invoicing and operator payouts *(Phase 3)* |

## Phasing

1. **Phase 1 — Foundation:** email intake, case management, field app, report upload, submission tracking.
2. **Phase 2 — Intelligence:** AI-drafted reports, cross-verification, transcription, gap checklist.
3. **Phase 3 — Optimisation:** risk scoring, investigator recommendation, fraud analytics, portal automation, billing.

Throughout, field interviews, the investigative conclusion and final sign-off remain human.
