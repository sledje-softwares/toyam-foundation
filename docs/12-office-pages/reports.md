# Office pages — Reports (M7 workspace structure, 8.1 approval, 8.2 send to insurer, 8.5 submissions)

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
| Request approval | — | — | ✓ |
| Approve report (one step, D47) | ✓ | ✓ | — |
| Approve / request changes (on an office request) | ✓ | ✓ | — |
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
| Versions and approval | `reports` (version, origin, created, `field_values` snapshot) + `report_files` (format, size) + `report_approvals` (requester / decider names); `approvalModel()` decides what is offered |
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
| Request approval (office) | `requestApproval` → `insert report_approvals` (`report_approvals_guard`) |
| Approve report (orchestrator / admin, D47) | `approveOwnReport` → `approve_own_report(p_report_id, p_comment)`: in one transaction the request (same `report_approvals_guard` rules: case in `assigned` / `office_review`, no open field task, every required field filled; latest version only) and the approval by the same person (`requested_by = decided_by`); the "waiting for approval" notifications are withdrawn; staff-only thread event "Report version n approved by …"; the case owner is notified (`report_approved`) when someone else approved |
| Approve / request changes | `decideApproval` → `update report_approvals set decision` (once; changes → `office_review`, requester notified) |
| Send to insurer (8.2) | `requestSend` → `request_report_send(...)`, then the `report-send` function is asked to deliver it (see below) |
| Retry / Send now / Settle… (8.2) | `retrySend` → `retry_report_send(p_id)`; `sendNow` (queued, sender not reached); `settleSend` → `resolve_report_send(p_id, p_was_sent)` (orchestrator / admin) |
| Download a version file | `reportFileLink` → 60 s signed URL, bucket `reports` |
| Open a file | `evidenceLink` → `evidence-view` function (caller's JWT, RLS decides) |

**Saving** (`save_case_field_values`, security definer). Caller must pass `can_manage_case`; the case must be in an editable status (else `55000` with the reason); keys are template field keys of the case's version (unknown → `22023`); values are text or null (blank clears; CRLF → LF; ≤ 20 000 characters). The case row is locked for the save, then per field the stored value is compared with `p_expected` (the value the form loaded, ignoring surrounding white space and line endings): equal → written with source `office` (confidence / evidence reference cleared, `updated_by` / `updated_at` stamped by the validate trigger, history through the audit log → `case_field_history`); different → not written and returned as `conflicts[key] = {value, source, updated_at, updated_by, updated_by_name}`. Other fields of the same save are still written. Direct staff insert / update / delete on `case_field_values` is revoked; intake (`intake_ingest`, `confirm_intake`) writes through definer functions.

The form posts every rendered field (`p:` present, `f:` value, `o:` value as loaded) and the action sends only the changed ones. On conflicts the form keeps what was typed, shows "Saved N fields. A field was changed by someone else…" and under each conflicting field "Saved meanwhile by ‹name› at ‹time›: ‹value›"; its `o:` becomes the newer value, so saving again replaces it deliberately.

**Claim and policy number (G6).** `insurer_claim_no` and `policy_no` are editable in the workspace; trigger `case_field_values_sync_case` copies them onto `cases` (the claim no. is the key follow-up mail is matched on, so a wrong parse must be correctable). A claim no. already used by another case of the same insurer is refused (`23505`, "Another case of this insurer already has claim number …", shown under the field); the claim no. cannot be cleared (`23514`, also checked in the form). Clients can no longer change those two case columns directly when the template carries the field (`cases_mirror_guard`). Chosen over read-only fields because only the workspace shows the source email beside the value, and keeping the case copy in step in the database covers every writer.

**Approval request (G5).** `report_approvals_guard` on insert: caller must pass `can_manage_case` (system jobs without a user are allowed); case in `assigned` (desk-only case) or `office_review`, with no open task (`Field work is still open`, `55000`); every required field of the template filled (`23514`, "2 required fields are empty: Insured name, Odometer"). The UI shows the same reasons on the disabled button (`approvalModel`).

## Send to insurer (8.2, D50)

A card under "Report versions and approval" (`components/reports/send-card.tsx`, pure rules in
`lib/report-send-core.ts`, actions in `app/(app)/reports/[caseRef]/send-actions.ts`). Function contract:
`supabase/functions/report-send/README.md`.

```
┌ Send to insurer ─────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠ Test mode: report emails go to dev@… only, never to the insurer, with [TEST] in the subject …       │
│ ▾ Send a test email                                                                                   │
│   To *       [claims@insurer.example                               ]                                  │
│   Cc         [boss@insurer.example, toyaminvestigation@gmail.com   ]                                  │
│   Subject *  [Re: OD Investigation Case No - MOT… // MH… // …      ]                                  │
│   Message *  [Dear Sir/Madam, …                                    ]                                  │
│   File name *[MOT…_IR      ]   Formats * [x] PDF [ ] DOCX                                             │
│   [Send test email]  Test mode: the email goes to dev@… only.                                         │
│ Requested        Status            To / Cc                  Formats  Details                         │
│ 19 Nov 10:02     [Test run]        claims@… Cc boss@…       PDF      Went to dev@… only. Sent 10:02.  │
│ 18 Nov 17:40     [Failed]          claims@…                 PDF      AUTH: 535 …          [Retry…]     │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Rule | Where |
|---|---|
| Form shown to people who manage the case (D44) when the latest version is approved (or the template needs no approval), the case is in `assigned` / `office_review` / `orchestrator_review`, there is an insurer mail to reply to, a generated file exists in an allowed format, and no send of that version is open (`queued` / `sending` / `unknown`) | `sendModel()`; again in `request_report_send` |
| To = the insurer's sender, Cc = the original recipients (`report_send_target`; none when the template's `report_email.cc_from_original` is false); subject from `report_email.subject` (default `Re: {{original_subject}}`, one `Re:` only); file name from `report_email.attachment_name` (default `{{insurer_claim_no}}_IR`, ASCII, `<case ref>_IR` when empty); message from `report_email.body` or a default naming the claim no. and insured; formats = the template default among the generated ones | `sendDefaults()` |
| Addresses: commas, semicolons, spaces or line breaks; lower-cased, de-duplicated; ≤ 30 in all | `SendInput` (zod); `private.clean_addresses` |
| After queueing, the server action calls the function with the user's session (`{ action: "send" }`); the page refreshes every 5 s while a send is queued / sending (up to 3 min). If the function cannot be reached, the Worker sweep sends it within 10 minutes | `kickReportSend()`, `SendAutoRefresh` |
| Test mode notice from `{ action: "mode" }` (asked only when this user could send or has an open send) | `reportSenderMode()` |
| Row actions: **Retry…** on a failed send of the latest version; **Send now** on a queued one; **Settle…** on an unknown outcome for orchestrator / admin (the database lets anyone who manages the case settle; the UI asks for the person who checks the shared Sent folder) | `rowActions()` |
| Statuses: Queued, Sending, Sent (submission recorded, case `submitted`), Failed (nothing left, may be retried), Outcome unknown (check the Sent folder, never resent by itself), Test run (went to the test address only, nothing recorded) | `SEND_STATUSES` |

## Generating a version (7.7, D51)

The edge function `report-generate` runs with the staff user's JWT: (1) `prepare_report_version(p_case_id)`, (2) renders the insurer layout as PDF and/or DOCX, using the 1600 px copy (`evidence_derivatives`, made by the field app) of each chosen photo, or the original when there is none (insurer attachments, a phone that failed to make one), (3) picks `report_id` (uuid v4) and uploads `{case_id}/{report_id}/report.pdf` / `.docx` to bucket `reports` (no upsert), (4) `create_report_version(...)`. A changed value between (1) and (4) fails with `RV409`: prepare again and regenerate. Both functions refuse a case outside the editable statuses (`55000`) exactly like saving values.

Function contract (request, preview mode, photo fallbacks, error codes, Browser Rendering): `supabase/functions/report-generate/README.md`.

`prepare_report_version(p_case_id uuid) returns jsonb`:

```json
{
  "prepared_at": "timestamptz", "prepared_by": {"id": "uuid", "name": "text"},
  "case": {"id", "case_ref", "status", "claim_type", "insurer_claim_no", "policy_no", "claim_amount", "incident_date",
           "received_at", "due_at", "created_at",
           "insurer": {"id", "code", "name"},
           "office_owner": {"id", "name"} | null, "orchestrator": {"id", "name"} | null},
  "template": {"id", "key", "name", "version", "variant", "claim_type", "requires_approval",
               "output_formats": ["pdf", "docx"], "default_output_format", "docx_template_path"},
  "report_layout": {} | null,
  "values_token": "v1:<md5>",
  "next_version": 1,
  "latest_version": {"report_id", "version", "origin", "created_at", "values_token"} | null,
  "sections": [{"key", "title", "position", "guidance",
                "categories": [{"code", "name", "position"}],
                "fields": [{"key", "label", "type", "required", "options", "help_text", "position",
                            "field_source": "intake|office",
                            "value": "text|null", "source": "email_parser|llm|office|suggestion|null", "updated_at"}]}],
  "photos": [{"evidence_id", "section_key", "position", "caption", "category_code", "category_name", "label_description",
              <file>}],
  "unplaced_photos": [{"evidence_id", <file>}],
  "annexure_files": [{"evidence_id", "section_key|null", "category_code|null", "category_name|null", <file>}]
}
<file> = "evidence_type", "mime_type", "original_filename", "capture_source", "storage_backend", "storage_path", "sha256",
         "size_bytes", "server_received_at", "device_captured_at", "latitude", "longitude", "relevance",
         "labels": ["<category code>"],
         "derivatives": [{"width": 384|1600, "storage_path", "sha256", "size_bytes", "pixel_width", "pixel_height"}]   (empty when the phone made none; storage_path = `derived/{case_id}/{original_sha256}/w{width}-{copy_sha256}.jpg`, content-addressed so a re-upload can never overwrite a recorded copy)
```

`template.key` is the config file name (`icl-motor-od`), else `<insurer code>-<claim type>-<variant>` in lower case. Values follow O1 (boolean `Yes` / `No`, multi_choice a JSON array string). **Default photo selection:** image (`photo`) evidence of the case, not withdrawn, relevance not `not_relevant`, placed in the first section (by position) whose categories contain one of its active labels; within a section ordered by that category's position, then `server_received_at`; `position` 1, 2, … per section; caption = the label's description if any, else the category name. Images with no matching label are `unplaced_photos`; documents, audio and video are `annexure_files` (same placement for `section_key`).

`create_report_version(p_case_id uuid, p_report_id uuid, p_values_token text, p_files jsonb, p_photos jsonb, p_notes text default null) returns jsonb`:

```json
p_files:  [{"format": "pdf", "storage_path": "{case_id}/{report_id}/report.pdf", "sha256": "<64 hex>", "size_bytes": 123456}]
p_photos: [{"evidence_id": "uuid", "section_key": "vehicle", "position": 1, "caption": "text (optional, ≤ 500)"}]
returns   {"report_id": "uuid", "version": 2, "created": true}
```

Files: 1–2, distinct formats the template allows, exact path, the object must exist in `reports` with that size. Photos: ≤ 500, each once, image or document of the case, not withdrawn / not relevant, `section_key` a section of the template, `position` integer ≥ 1 and unique per section. Notes ≤ 2000. Errcodes: `42501` not allowed, `P0002` case not found, `55000` status, `RV409` values changed, `22023` invalid input, `23505` the report id belongs to another case. Calling again with a recorded `report_id` returns `created: false` (safe retry). The version is `origin = generated`, `storage_path` the PDF (else the DOCX), `uploaded_by` the caller; audit `REPORT_GENERATED`; staff-only thread event "Report version n generated by …". Generated versions, their files and annexures cannot be changed or deleted through the API.

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
| — | A new task on an `orchestrator_review` case moves it to field work while an approval may be pending |
| — | Policy `p_subs_staff_i` still lets staff insert a `submissions` row with channel `email` directly (pgTAP 07 relies on it); only `record_manual_submission` refuses email. Tighten so email submissions come only from the sender (8.2) |

G9 (self-approval) is closed by D47 (`20261115900000_submitted_case_rules`): orchestrators and admins approve their own reports in one step (`approve_own_report`); office reports still need an orchestrator's or admin's decision; no four-eyes rule. Re-investigation on a submitted case is closed by D46 (same migration): no field work on a submitted case until it is reopened from Submissions on the insurer's request.

G3 (staff view of R2 files) is closed by the `evidence-view` function.

G1 (nothing creates versions) and G2 (no value snapshot per version) are closed by `20261117000000_report_versions` (pgTAP `23_report_versions`): `prepare_report_version` / `create_report_version` below; each generated version keeps the field values it was made from in `reports.field_values` and its `values_token`.

## Answered

| # | Answer |
|---|---|
| O1 | Kept (D51): boolean values are stored as `Yes` / `No`, multi_choice as a JSON array of strings (e.g. `["Front","Rear"]`). The generator, the intake parser and the workspace rely on these forms |

## Open questions

| # | Question |
|---|---|
| O3 | Should "Record portal / other submission" also accept emails sent outside the system? (The sender exists since 8.2; still useful when a report goes out by hand from Gmail.) |
| O5 | Should settling an unknown send be limited to orchestrators / admins in the database too (today only the UI limits it)? |
| O4 | Does reopening require a new approval even when only the insurer's query is answered without changing the report? (Today: yes, the case returns to office review.) |
