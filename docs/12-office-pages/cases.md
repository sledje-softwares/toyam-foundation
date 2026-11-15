# Office pages — Cases (4.6 list & detail, 4.2 reassignment, 4.7 staff notes)

Routes follow docs/08 §1.3: `/cases`, `/cases/[caseRef]` with one case layout (header + tabs). No DB changes were needed: every read and action below already exists and is covered by pgTAP (03, 07, 09, 13).

## Who sees what

Roles are `admin`, `orchestrator`, `office` (staff, `STAFF_ROLES`) and `field`. Field users never reach the web app (the `(app)` layout sends them to `/login`); every page also calls `requireRole(STAFF_ROLES)`. RLS (D44, `20261115500000_office_case_scope`): orchestrator and admin read every case and everything on it; an `office` user reads only cases where `office_owner_id = auth.uid()` and their messages (incl. `visibility = 'staff'`), evidence, labels, tasks, assignments, status history, linked emails, reports and submissions (`private.can_manage_case(case_id)`). Unassigned cases are orchestrator / admin only. For office, `/cases` therefore has no owner filter, no "Show my cases" toggle and no Owner column; a case reassigned away from them disappears from their list and its page returns not-found.

| Action | admin | orchestrator | office |
|---|---|---|---|
| List / open any case | ✓ | ✓ | ✓ |
| Staff note (staff-only) / message to field | ✓ | ✓ | ✓ |
| Assign field task / request re-investigation (links to `/tasks/new?case=<ref>`, built elsewhere) | ✓ | ✓ | ✓ |
| Create a case directly (`/cases/new`, D49) | ✓ (any owner / auto) | ✓ (any owner / auto) | ✓ (owner = self) |
| Reassign office employee (with reason) | ✓ | ✓ | — (`reassign_case` refuses; button hidden) |
| Run automatic assignment on an unassigned case | ✓ | ✓ | — |

## `/cases` — list

```
Cases                                                    [Mine] [All]
[Search ref / claim no. / insured] [Status: Open ▾] [Insurer ▾] [Claim type ▾] [Owner ▾] [Due ▾]  Clear   42 results
┌────────────────┬─────────┬────────────┬──────────────┬───────┬────────────┬───────────┬──────────┬────────────────┐
│ Case ref       │ Insurer │ Claim no.  │ Insured      │ Type  │ Status     │ Owner     │ Received │ Due            │
│ INV-2026-000123│ IGI     │ CL/77/2026 │ R. Sharma    │ Motor │ In field   │ N Office  │ 12 Nov   │ Overdue 2 d ⚠ │
└────────────────┴─────────┴────────────┴──────────────┴───────┴────────────┴───────────┴──────────┴────────────────┘
                                                                              1–50 of 42   ‹ 1 ›
```

| URL param | Meaning |
|---|---|
| `status` | empty = **Open** (not submitted / closed / cancelled); a `case_status`; `all` |
| `insurer`, `claim_type` | exact match |
| `owner` | `me`, `none` (unassigned) or a staff profile id |
| `due` | `overdue` (open, `due_at` < now), `soon` (open, due within 2 days), `on_track`, `none` (no due date) |
| `q` | case ref or claim no. (`ilike`), or insured name (`case_field_values` of the template field `insured_name`, bounded lookup of 200 case ids) |
| `sort`, `dir`, `page` | sortable: `due_at` (default, ascending, no due last), `received_at`, `case_ref`; 50 rows a page |

Data: `cases` + `insurers(code,name)` + `profiles!cases_office_owner_id_fkey`; insured names for the page's rows from `case_field_values` × `case_template_fields(key = 'insured_name')`; owner options from `profiles` (staff roles). Due badge from `due_at` vs now (pure helper `dueState`, `lib/cases.ts`). Empty: "No cases yet" / filtered "No results for these filters". Error: `ErrorState`.

## `/cases/[caseRef]` — layout (header + tabs)

```
Cases / INV-2026-000123
INV-2026-000123  [In the field] [Overdue 2 d]            [Assign field task] [Request re-investigation]
IGI General · Motor OD standard v3 · Claim CL/77/2026 · Received 12 Nov · Due 14 Nov (TAT 5 d) · Owner N Office
─ Overview ─ Thread (12) ─ Evidence (31) ─ History ─
```

The two buttons are links to `/tasks/new?case=<ref>` and `/tasks/new?case=<ref>&kind=re_investigation` (the form is built in `/tasks`). Unknown ref → 404. Header data is loaded once per request (`cache()`), shared by layout and tab.

### Overview (default tab)

```
┌ Intake fields (template) ──────────────┐  ┌ Assignment ───────────────────────────────┐
│ Section: Claim                          │  │ Owner: N Office (since 12 Nov, auto)      │
│ Claim no.   CL/77/2026                  │  │ [Reassign…]  (orchestrator / admin)       │
│ Insured     R. Sharma                   │  │  ▸ dialog: new owner ▾ (availability,     │
│ …           —                           │  │    open cases) + reason (3–500) → confirm │
└─────────────────────────────────────────┘  │ History: 12 Nov auto → N Office …         │
┌ Field tasks ────────────────────────────────────────────────────────────────────────┐
│ Visit garage · Initial · F Operator · In progress · checklist 4/7 · due 13 Nov       │
│ Files waiting on phones: F Operator 3 files (reported 10:05)                          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| Section | Source |
|---|---|
| Intake fields | `case_template_fields` (template of the case, `source = 'intake'`, section then field order) left-joined in code with `case_field_values`; empty value "—"; no template → note |
| Assignment | `cases.office_owner_id / office_assigned_at / assignment_method`, `case_assignments` (assignee, by, method, reason) |
| Reassign | `reassign_case(p_case_id, p_assignee_id, p_reason)`; options from active staff `profiles` with availability and open-case counts; current owner excluded |
| Unassigned case | "Run automatic assignment" → `retry_auto_assign(p_case_id)`; null → "No one is available" |
| Field tasks | `tasks` + assignee; checklist progress from `v_case_checklist` (done = status not pending or evidence_count > 0); `case_outbox_status(p_case_id)` |

### Thread

```
┌ 12 Nov 10:02  ── Case assigned automatically to N Office ──  [Staff only]
│ 12 Nov 11:15  N Office (Office): Please collect the FIR copy.
│ 12 Nov 11:20  REQUEST · Visit garage → F Operator                    [task]
│ 12 Nov 15:40  F Operator (Field): 📎 3 files  dl_front.jpg · …
│ ▌12 Nov 16:00 N Orch (Orchestrator) [Staff only]: Garage section still empty  (amber, left bar)
└ Composer: ( ) Staff note — office only (default)   ( ) Message to field operator
            [textarea 1–4000]                                              [Send]
```

| Item | Source |
|---|---|
| Messages | `case_messages` (newest 200, shown oldest → newest) + sender profile, task title, files (`evidence` by `message_id`); withdrawn → "Message withdrawn" |
| Staff-only | `visibility = 'staff'`: amber background, "Staff only" badge; field users never receive them (RLS `p_msg_field_r`, pgTAP 09) |
| Read pointer | `mark_thread_read(p_case_id)` when the tab renders |
| Staff note | `post_staff_note(p_case_id, p_client_message_id, p_body)` (notifies owner / orchestrator) |
| Message to field | `post_thread_message(p_case_id, p_client_message_id, 'text', p_body)` |

`client_message_id` is a UUID made in the browser per draft, so a double submit stores one message.

### Evidence

Table of the case's files: file name / type, source (camera / gallery / share / web / insurer email), uploaded by, server time, active labels (category, source, confidence; LLM description as tooltip), processing state (`v_evidence_processing`), flags (`is_flagged`, `relevance`, withdrawn). Filters `?source=field|email` and `?flagged=1`. No downloads yet (R2 files need a staff presigner — gap G2).

### History

One timeline, newest first, merged in code (`buildHistory`, `lib/cases.ts`): `case_status_history` (from → to, by, note), `case_assignments` (auto / manual, reason) and `case_field_history(p_case_id)` (field, old → new, by).

## `/cases/new` — create a case directly (D49)

For a case that did not arrive by email (phone call, insurer portal). "New case" button in the `/cases` header, for every staff role.

```
Cases / New case
Insurer [IGI General (IGI) ▾] [Continue]          step 1: ?insurer=<id> lists its templates in use
  Motor · OD · v3   IndusInd (Reliance) — Motor OD investigation   → ?template=<id>
─────────────────────────────────────────────
IGI General · Motor · OD · v3                     [Change template]   step 2
┌ Insured ─────────────────────────────────┐
│ Claim no *  [      ]   Insured name * [ ] │   the template's intake fields, by type
└───────────────────────────────────────────┘
┌ Assignment ───────────────────────────────┐
│ Owner [Assign automatically ▾]            │   orchestrator / admin (active staff, load, availability)
│ "This case will be assigned to you."      │   office
│ Staff note (optional) [            ]      │
└───────────────────────────────────────────┘                        [Cancel] [Create case]
```

| Item | Source |
|---|---|
| Step 1 | `case_templates` active, insurer active (`load.ts`); template label "claim type · variant · version" |
| Fields | `case_template_fields` with `source = 'intake'` in section / position order; claim no. always present and required; controls and normalising as in the report workspace (`normaliseValue`, `lib/reports.ts`); helpers in `lib/new-case.ts` |
| Owner options | active `office` / `orchestrator` / `admin` profiles with open-case counts (`assigneeOptions`) |
| Create | `create_case_direct(p_template_id, p_values, p_owner_id, p_note)` → flash "Case INV-… created." and redirect to `/cases/<ref>`. Duplicate claim no. and empty required fields show next to the field |

`create_case_direct` (migration `20261116000000_create_case_direct.sql`, pgTAP 21): staff only; office owner is always the caller (another owner refused); orchestrator / admin choose an active staff owner or leave it null for the automatic assignment (D40); active template of an active insurer; keys must be the template's intake fields (claim no. always accepted, required); required intake fields filled; duplicate `(insurer, claim no.)` refused, naming the existing case ref only when the caller can see it. Writes the case (`created_by`, `due_at` from TAT, status `assigned` with a chosen owner, `received` → auto-assign otherwise), field values (source `office`), parties (insured / driver, as intake), status history, assignment row, owner notification (when not the creator), staff-only "Case created by ‹name›" message, the note as a staff-only message, audit row `CASE_CREATED`.

## Errors and empty states

- Each section loads independently; a failed query shows `ErrorState` for that section only.
- Server actions return `{ error }` for the form (mapped with `mapDbError`), or flash + `revalidatePath` on success.
- Empty: no intake fields ("This case has no template"), no tasks ("No field work yet" + link), no messages, no files, no history.

## DB gaps / open questions

- **G1** `reassign_case` accepts the current owner and terminal cases; the UI excludes the current owner and hides the button on submitted / closed / cancelled cases. Tighten in the DB later if wanted.
- **G2** No staff download of evidence: R2 objects need a presigned GET (edge function like `evidence-upload`); `email-raw` files could use a signed Storage URL. Later piece (M6 evidence workspace).
- **G3** Insured-name search reads `case_field_values` with `ilike` (fine at ~300 cases a month); add a trigram index or a `cases.insured_name` cache if it gets slow.
- **G4** No case-level "parties" UI; parties are not filled by intake today.
- **Q** Should office staff see only their own cases by default? Current choice: everyone sees all; "Mine" is one click (`owner=me`).
