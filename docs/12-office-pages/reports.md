# Office pages — Reports (M7 workspace structure, 8.1 approval, 8.5 submissions)

Routes: `/reports` (list), `/reports/[caseRef]` (workspace), `/submissions` (sent reports). Pure helpers in `apps/web/lib/reports.ts` and `lib/submissions.ts` (unit-tested); server actions in `app/(app)/reports/[caseRef]/actions.ts` and `app/(app)/submissions/actions.ts`; data loading in `app/(app)/reports/[caseRef]/load.ts`. Database rules: `supabase/migrations/20261115800000_report_guards.sql`, pgTAP `supabase/tests/19_report_guards.test.sql`.

## Purpose

One template drives a case (D20): the workspace shows the template version's report sections in order, the intake values already filled, and beside the open section the files whose labels fall in that section's evidence categories. Office staff fill the sections, mark files relevant or not and correct labels; a generated version (7.7) is sent for approval (8.1) and then to the insurer (8.2), or recorded as delivered on a portal (8.5). The list and the workspace never add case statuses (rule 1): the report stage is derived from the case status and the approvals.

## Who does what (D44, D45)

`private.can_manage_case(case)`: admin and orchestrator on every case, office on the cases they own (`cases.office_owner_id`). Office users only see their own cases at all (D44, RLS). Field users never reach these pages (and RLS hides reports, approvals and submissions from them).

| Action | admin | orchestrator | office (owner) |
|---|---|---|---|
| Open list / workspace / submissions | ✓ | ✓ | ✓ (own cases only) |
| Edit report values (D45: orchestrators too) | ✓ | ✓ | ✓ |
| Relevance, label correction | ✓ | ✓ | ✓ |
| Request approval | ✓ | — (G9 open, UI hides) | ✓ |
| Approve / request changes | ✓ | ✓ | — |
| Record acknowledgement / portal or other submission / reopen | ✓ | ✓ | ✓ |

## Report stages and editable statuses

| Stage | Case status | Values editable |
|---|---|---|
| In progress | `received`, `intake_confirmed`, `assigned`, `field_in_progress`, `office_review` | yes (`private.report_editable_status`) |
| Awaiting approval / Approved | `orchestrator_review` (split by the latest approval) | no |
| Sent | `submitted`, `closed` | no; `submitted` can be reopened |
| (not listed) | `cancelled` | no |

Editable = every status before approval is requested (docs/06: "Approval requested → orchestrator_review"; "Changes requested → office_review" unlocks; "Submission recorded → submitted"). Field work may still be open while values are filled; approval needs it closed.

## `/reports` — list

```
Reports                                                                        [Mine] [All]
[Search ref / claim no. / insured] [Stage: In progress ▾] [Insurer ▾] [Owner ▾]  Clear  18 results
┌────────────────┬─────────┬────────────┬──────────────┬────────────────┬────────────┬──────────┬──────────┐
│ Case ref       │ Insurer │ Claim no.  │ Insured      │ Stage          │ Required   │ Owner    │ Due      │
│ INV-2026-000123│ IGI     │ CL/77/2026 │ R. Sharma    │ In progress    │ 14 / 21    │ N Office │ 2 d left │
└────────────────┴─────────┴────────────┴──────────────┴────────────────┴────────────┴──────────┴──────────┘
```

Data: `cases` (statuses of `LISTED_STATUSES`) + insurer + owner + `report_approvals(decision, requested_at)` + `reports(version)`; progress from `v_report_progress` summed per case (`sumProgress`); insured name from `case_field_values` of field `insured_name`. Empty: "No reports yet" / "No results for these filters". Error: `ErrorState`.

## `/reports/[caseRef]` — workspace (sized for 1366×768)

Two columns at `lg` (≥ 1024 px): sections take the rest, files panel 25 rem (400 px), sticky with its own scroll. At 1366×768 about 900 px remain for the section form (two field columns) and the files panel shows ~3 thumbnails without scrolling. Below `lg` the panel drops under the sections.

```
Reports / INV-2026-000123                                                        [Generate report] (7.7)
INV-2026-000123 [In progress] [Office review]
IGI General · Claim CL/77/2026 · IGI Motor OD v3 · Owner N Office · Due 18 Nov (2 days left)
┌ Report versions and approval  v2 [Awaiting approval] ────────────────────────────────────────────────┐
│ The latest version is waiting for an orchestrator. Formats allowed: PDF, DOCX.  [Request changes…] [Approve…] │
│ ▸ Versions (2)                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Sections        14 / 21 required · 40 / 72 filled ─────────┐ ┌ Files for "Driver details" ────────────┐
│ ✓ Claim                                    8/8             │ │ Categories: DL                          │
│ ▾ Driver details                    3/6  [2 required]      │ │ ┌────┐ dl_front.jpg  DL 0.94 (AI)       │
│   Last change 15 Nov 10:05                                 │ │ │img │ Relevant ▾  Labels…  Open        │
│   Driver name *     [Ramesh K      ]  Licence no. [      ] │ │ └────┘                                  │
│   DL valid till     [2027-12-01    ]  Vehicle cl. [LMV ▾ ] │ │ Unlabelled (2) ▸                        │
│   ⚠ Saved meanwhile by N Orch at 15 Nov 10:07: Ramesh Kumar│ │ Not relevant (1) ▸                      │
│   Unsaved changes                    [Discard] [Save section]│ └─────────────────────────────────────────┘
│   Suggested values (7.4) …                                 │
│ ▸ Garage                                   0/9 [4 required]│
└────────────────────────────────────────────────────────────┘
```

### Data sources per panel

| Panel | Source |
|---|---|
| Header | `cases` + `insurers` + owner `profiles` + `case_templates` (name, version, `is_active`, `requires_approval`, `output_formats`); last `submissions` row |
| Versions and approval | `reports` (version, origin, created) + `report_files` (format, size) + `report_approvals` (requester / decider names); `approvalModel()` decides what is offered |
| Sections | `case_template_sections`, `case_template_fields` of the case's template version, `case_field_values` (value, source, updated_at) → `buildWorkspace()`; focus = `?section=` else first section with a required gap |
| Field controls | by `template_field_type`: text, long_text (textarea), number / currency (normalised, `₹` and commas removed), date (stored `yyyy-mm-dd`, dd/mm/yyyy accepted), datetime (`yyyy-mm-ddThh:mm`), choice / boolean (select; boolean stored `Yes` / `No`), multi_choice (checkboxes; JSON array). A stored value the native input cannot show is rendered as text so nothing is lost |
| Source badge | `case_field_values.source`: From email / Entered / Suggestion / AI |
| Files | `evidence` of the case (not withdrawn, not notes) + active `evidence_labels`; section categories from `case_template_section_categories`; `evidence_field_matches` (score ≥ 0.5) for the focused section's fields; `v_evidence_processing.state`; thumbnails and Open links from the `evidence-view` function (R2 and Storage, 300 s links; `lib/evidence-view.ts`) |
| Suggestions note | count of pending `field_suggestions` for the focused section (7.4 not built) |

### Actions

| Action | Server action → database |
|---|---|
| Save section | `saveSection` → `save_case_field_values(p_case_id, p_values, p_expected)` |
| Relevance | `setRelevance` → `update evidence set relevance` (`evidence_guard` stamps who / when; D44 RLS limits office to own cases) |
| Correct labels | `correctLabels` → `set_evidence_labels(p_evidence_id, p_category_ids)` (checks `can_manage_case`) |
| Request approval | `requestApproval` → `insert report_approvals` (`report_approvals_guard`) |
| Approve / request changes | `decideApproval` → `update report_approvals set decision` (once; changes → `office_review`, requester notified) |
| Download a version file | `reportFileLink` → 60 s signed URL, bucket `reports` |
| Open a file | `evidenceLink` → `evidence-view` function (caller's JWT, RLS decides) |

**Saving** (`save_case_field_values`, security definer). Caller must pass `can_manage_case`; the case must be in an editable status (else `55000` with the reason); keys are template field keys of the case's version (unknown → `22023`); values are text or null (blank clears; CRLF → LF; ≤ 20 000 characters). The case row is locked for the save, then per field the stored value is compared with `p_expected` (the value the form loaded, ignoring surrounding white space and line endings): equal → written with source `office` (confidence / evidence reference cleared, `updated_by` / `updated_at` stamped by the validate trigger, history through the audit log → `case_field_history`); different → not written and returned as `conflicts[key] = {value, source, updated_at, updated_by, updated_by_name}`. Other fields of the same save are still written. Direct staff insert / update / delete on `case_field_values` is revoked; intake (`intake_ingest`, `confirm_intake`) writes through definer functions.

The form posts every rendered field (`p:` present, `f:` value, `o:` value as loaded) and the action sends only the changed ones. On conflicts the form keeps what was typed, shows "Saved N fields. A field was changed by someone else…" and under each conflicting field "Saved meanwhile by ‹name› at ‹time›: ‹value›"; its `o:` becomes the newer value, so saving again replaces it deliberately.

**Claim and policy number (G6).** `insurer_claim_no` and `policy_no` are editable in the workspace; trigger `case_field_values_sync_case` copies them onto `cases` (the claim no. is the key follow-up mail is matched on, so a wrong parse must be correctable). A claim no. already used by another case of the same insurer is refused (`23505`, "Another case of this insurer already has claim number …", shown under the field); the claim no. cannot be cleared (`23514`, also checked in the form). Clients can no longer change those two case columns directly when the template carries the field (`cases_mirror_guard`). Chosen over read-only fields because only the workspace shows the source email beside the value, and keeping the case copy in step in the database covers every writer.

**Approval request (G5).** `report_approvals_guard` on insert: caller must pass `can_manage_case` (system jobs without a user are allowed); case in `assigned` (desk-only case) or `office_review`, with no open task (`Field work is still open`, `55000`); every required field of the template filled (`23514`, "2 required fields are empty: Insured name, Odometer"). The UI shows the same reasons on the disabled button (`approvalModel`).

### Empty and error states

| Situation | Shown |
|---|---|
| Unknown case ref (or another office employee's case, D44) | 404 |
| Load failed | `ErrorState` "This report" |
| Case without template | warning "No template" (cases get their template at intake; ask an admin) |
| Template without sections | warning "Nothing to fill" |
| Not editable | "Read only" alert with the reason: waiting for approval / approved, sent (reopen from Submissions), closed, cancelled |
| Orchestrator / admin on someone else's case | info: changes are recorded under your name |
| No versions | "Versions appear here once the report is generated (7.7)"; Request approval disabled with the reason |
| No files for the section | panel says so; unlabelled files listed separately |
| Save error | inline alert in the section; field errors under the fields |

## `/submissions`

```
Submissions                                       Reports   [Record portal / other submission…]
[Search case ref / claim no.] [Channel ▾] [Insurer ▾] [Acknowledgement ▾]   Clear   9 results
┌───────────────┬────────────────┬───────────┬─────┬────────┬────────┬───────────┬─────┬────────┬──────────┬─────────┬───────────────────────┐
│ Sent          │ Case           │ Claim no. │ Ins.│ Channel│ Formats│ Recipients│ Ver.│ Sent by│ Ack.     │ State   │ Actions               │
│ 15 Nov 11:20  │ INV-2026-000123│ CL/77/2026│ IGI │ Portal │ PDF    │ —         │ v2  │ N Off. │ Awaiting │ Sent    │ [Record ack…][Reopen…]│
└───────────────┴────────────────┴───────────┴─────┴────────┴────────┴───────────┴─────┴────────┴──────────┴─────────┴───────────────────────┘
```

Data: `submissions` + case (ref, claim no., status, owner, insurer) + report version + sender; state from `submissionState()` (Superseded when a later submission exists; Reopened when `reopened_at` is set or the case is active again; else Sent). Actions are shown to `can_manage_case` users only and checked again in the database.

| Action | Dialog | Database |
|---|---|---|
| Record acknowledgement | acknowledged at (India time, empty = now), insurer reference (optional), note | `record_submission_ack(p_submission_id, p_ack_at, p_note, p_insurer_reference)`: once (`55000` after); not in the future, not more than a day before sending; reference set once; staff-only thread event |
| Record portal / other submission | case ref, channel (portal / other), formats, sent at, portal reference (required for portal), note (required for other) | `record_manual_submission(p_case_id, p_channel, p_formats, p_insurer_reference, p_note, p_submitted_at, p_report_id)`: latest report version; case in `assigned` / `office_review` / `orchestrator_review`; approval and formats checked by `submissions_guard`; case → `submitted`, staff-only thread event. Email is refused (the sender records it with message ids) |
| Reopen | reason (3–500) | `reopen_case(p_case_id, p_reason)`: `submitted` → `office_review`; reason in `case_status_history.note`; latest submission gets `reopened_at / by / reason`; staff-only thread event "Case reopened by …"; owner notified (`case_reopened`; orchestrators when unassigned) |

Submissions are records: no update / delete for API roles except the set-once columns (acknowledgement, insurer reference, sender message / thread ids, reopen marks) — trigger `submissions_record_guard`; staff insert only as themselves on cases they manage (policy `p_subs_staff_i`).

Empty: "Nothing sent yet". Errors from actions come back as a flash message on the list (filters kept).

## Remaining gaps

| # | Gap |
|---|---|
| G1 | Nothing creates `reports` versions yet (generator 7.7), so approval request and sending cannot be exercised end to end |
| G2 | Versions do not snapshot the field values they were generated from; an approved version and the current values can only be compared once 7.7 stores them |
| G9 | Self-approval: an orchestrator or admin can approve a version they requested (awaiting decision; UI hides "Request approval" from orchestrators) |
| — | Re-investigation on a submitted case (awaiting decision); today a new task on an `orchestrator_review` case moves it to field work while an approval may be pending |

G3 (staff view of R2 files) is closed by the `evidence-view` function.

## Open questions

| # | Question |
|---|---|
| O1 | Storage format for multi_choice (JSON array of strings today) and boolean (`Yes` / `No` today): confirm before the generator (7.7) and the intake parser rely on them, or switch to `true` / `false` and a delimiter list |
| O2 | Should orchestrators request approval on cases they edit (tied to G9)? |
| O3 | Should "Record portal / other submission" also accept emails sent outside the system until the sender (8.2) is built? |
| O4 | Does reopening require a new approval even when only the insurer's query is answered without changing the report? (Today: yes, the case returns to office review.) |
