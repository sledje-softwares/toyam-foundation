# 12 — Office pages: Tasks (build plan 4.3, 4.4)

Field tasks seen from the office: a list of all field work, the form that assigns it (4.3), the same form in re-investigation mode (4.4), and a task detail page. Design rule 1 applies: extra investigation is a new `task`, never a new case status.

Routes (this page set; docs/08 §1.3 listed nested `/cases/[caseRef]/tasks/...` routes — the flat routes below replace them so the case page can link here with `?case=`):

| Screen | Route | Notes |
|---|---|---|
| Tasks | `/tasks` | `?status=&operator=&case=&due=&kind=&scope=&q=&sort=&dir=&page=` |
| Assign field task | `/tasks/new?case=[caseRef]` | without `case`: a small "Which case?" form |
| Re-investigation | `/tasks/new?case=[caseRef]&kind=reinvestigation[&parent=[taskId]]` | same form, request mode |
| Task detail | `/tasks/[taskId]` | |

## Roles

All staff (admin, orchestrator, office). Field operators never use the web app (layout redirect).

**RLS (D44):** staff task policies are `p_tasks_staff_r` (SELECT) and `p_tasks_staff_i` (INSERT), both `private.can_manage_case(case_id)`; there is no staff UPDATE / DELETE policy, so changes go through the task RPCs. An `office` user sees only the tasks of cases assigned to them; the list has no scope filter for office (`scope` is ignored). Orchestrator / admin open on *All cases* and can switch to *My cases* (`scope=all|mine`). Operator workload counts in the assign form are, for office, counts on their own cases only.

**Changing field work** (`20261115600000_field_task_rpcs.sql`): `create_field_task()`, `cancel_field_task()`, `reassign_field_task()` and `update_field_task()` require `private.can_manage_case()` — orchestrator / admin on every case, office staff only on cases they own. The task detail page shows the actions only when the same rule passes (`canManageTask` in `lib/tasks-actions.ts`).

## /tasks — list

```
Tasks                                                        
[Search task, case ref, claim no.] [Status: Open ▾] [Operator ▾] [Due ▾] [Kind ▾] [Scope: My cases ▾]  Clear   37 results
Showing tasks of case INV-2026-000123 · Show all cases                     (only with ?case=)
┌──────────────────────┬────────────────┬──────────────────┬──────────┬────────────┬──────────────┬───────────┐
│ TASK                 │ CASE           │ KIND             │ OPERATOR │ STATUS     │ DUE ▲        │ CHECKLIST │
├──────────────────────┼────────────────┼──────────────────┼──────────┼────────────┼──────────────┼───────────┤
│ Visit the garage     │ INV-…0123 ICICI│ First visit      │ Farid K. │ In progress│ 14 Nov ⚠Over│ 3 / 5     │
│ Re-investigation     │ INV-…0098 HDFC │ Re-investigation │ Ravi S.  │ Pending    │ 18 Nov       │ —         │
└──────────────────────┴────────────────┴──────────────────┴──────────┴────────────┴──────────────┴───────────┘
1–37 of 37                                                                       [Previous] [Next]
```

| Section | Source |
|---|---|
| Rows | `tasks` + `cases!inner(case_ref, insurer_claim_no, status, office_owner_id, insurers(code))` + `profiles!tasks_assignee_id_fkey(full_name, is_active)`; count exact; 50 per page; `lib/list-params.ts` |
| Checklist column | `v_case_checklist` for the task ids on the page; an item is done when its status is `captured` / `not_available` / `waived` or it has matched evidence (`evidence_count > 0`, D41) |
| Operator filter | `profiles` where `role = 'field'` (inactive marked) |
| Search `q` | `tasks.title` ilike, or `case_id` in cases whose `case_ref` / `insurer_claim_no` match (bounded lookup, as on `/intake`) |

Filters: **status** (default *Open* = pending + in progress; Pending, In progress, Completed, Cancelled, All), **operator**, **case** (exact `case_ref`, set by links from the case page), **due** (Overdue = open and `due_at` < now; Due today (IST); Due in 7 days; No due date), **kind** (`task_kind`: First visit, Re-investigation, Additional field work, Office), **scope** (above). Sort: due (default ascending, no due date last) or assigned date.

Empty: "No open field tasks" (+ "Clear filters" when filtered). Error: `ErrorState`.

## /tasks/new — assign field task (4.3) and re-investigation (4.4)

```
Tasks / INV-2026-000123 / Assign field task
Case INV-2026-000123 · ICICI Lombard · Motor OD · claim 12345 · In the field · office: Asha R.   [Open case]

Operator *          ( ) Farid Khan   Pune    2 open tasks
                    ( ) Ravi Shah    Nashik  0 open tasks
                    ( ) Vijay More   Pune    1 open task   On leave until 18 Nov
Kind *              (•) First visit   ( ) Additional field work                (normal mode only)
Earlier task        [Visit the garage — completed 12 Nov ▾]                      (re-investigation only)
Title *             [Field investigation            ]
Instructions        [                               ]   ← "Request *" in re-investigation mode
Checklist           (•) Motor OD standard (12 items, default)  ( ) Motor theft (9)  ( ) No checklist
Due (India time)    [2026-11-20 18:00]   Case due 22 Nov 2026
Location            [Garage address / area           ]
                                                     [Cancel]  [Assign field task | Send request]
```

| Section | Source |
|---|---|
| Case header | `cases` by `case_ref` + `insurers(name, code)` + owner `profiles!cases_office_owner_id_fkey` |
| Operators | `profiles` `role = 'field' and is_active`, with `region`, `availability`, `availability_until`; open-task load = count of `tasks` in pending / in progress per assignee |
| Checklists | `case_template_checklists` for `cases.template_id` joined to active `checklist_templates` (+ item count), default first (D20, D42). Fallback when the case has no template or no active link: active checklists of the case's claim type and insurer (or all insurers) |
| Earlier tasks | `tasks` of the case, newest first (parent for re-investigation; also decides the default kind) |
| Submit | `rpc create_field_task(p_case_id, p_assignee_id, p_title, p_instructions, p_checklist_template_id, p_kind, p_due_at, p_location_text, p_parent_task_id, p_reason)` |

What the database does on insert (`private.tasks_after_change`, `tasks_track_holds`): posts "Field work assigned to X: title" as a system message — or, for `re_investigation`, the **request text as a `request` message** in the thread (visible to the operator); notifies the operator (`task_assigned` / `field_request`); moves the case from received / assigned / office review / awaiting approval to **In the field**; opens a `task_holds` row. Success → flash + redirect to `/cases/[caseRef]` (thread).

Defaults: re-investigation mode pre-selects the parent task (`?parent=` or the latest task) and its operator if still active, "No checklist", title "Re-investigation". Normal mode: kind *First visit* when the case has no earlier task, else *Additional field work*; the template's default checklist.

Validation (server action, pure helpers in `lib/tasks-form.ts`; the database re-checks assignee and title):
- operator: required, one of the listed active field operators;
- title 3–120 characters; instructions ≤ 4000 (a thread message is ≤ 4000); request required in re-investigation mode (10–4000);
- checklist: empty or one of the offered checklists; parent: empty or a task of the same case;
- due: optional `datetime-local` read as IST (+05:30), must be in the future and within 1 year;
- location ≤ 300; reason optional, 3–500 (stored in `tasks.reason`, readable by the operator); case must exist and not be Submitted, Closed or Cancelled.

A **Submitted** case takes no field work (D46): the form shows a blocking notice "This case was submitted. Reopen it from Submissions when the insurer asks." with a link to `/submissions`; the case header and the task detail show "Reopen from Submissions" instead of "Assign field task" / "Request re-investigation". Reopening (`reopen_case`, reason = the insurer's request) returns the case to office review, after which work is assigned as usual.

The database re-checks (since `20261115600000`; Submitted since `20261115900000`): caller manages the case (D44), case exists and is not Submitted / Closed / Cancelled (also for a direct insert into `tasks`, trigger `tasks_open_case_guard`), active field assignee, title, parent task on the same case, checklist in use and offered for the case (linked to its template, or the claim-type fallback above), reason 3–500.

Errors: field messages inline, others in an `InlineAlert` via `mapDbError`. Unknown case → 404. No active operators → empty state "No active field operators. An admin adds them in Users."

## /tasks/[taskId] — task detail

```
Tasks / INV-2026-000123 / Visit the garage
Visit the garage  [In progress] [First visit]            [Request re-investigation] [Open case]
┌ Summary ────────────────────────────┐ ┌ Checklist  3 of 5 required done ─────────────────┐
│ Case      INV-…0123 · ICICI · OD    │ │ 1 Vehicle photos (4 sides)   Required  ✓ 4 files │
│ Operator  Farid Khan · +91 98… Pune │ │ 2 RC book                    Required  Missing   │
│ Due       14 Nov 18:00  ⚠ Overdue   │ │ …                                                │
│ Location  Garage, Pune              │ └──────────────────────────────────────────────────┘
│ Assigned  12 Nov by Asha · started …│ ┌ Phone and late uploads ──────────────────────────┐
│ Earlier   ← Visit the garage (done) │ │ Farid Khan: 12 files (34 MB) waiting on phone,   │
│ Files     9 received on this task   │ │   last online 2 h ago                            │
│ Instructions …                      │ │ Holds: Farid 12 Nov → open                       │
└─────────────────────────────────────┘ │        Ravi 10 Nov → 12 Nov · late uploads until │
  Follow-up tasks: Re-investigation …   │        15 Nov 14:00                              │
                                        └──────────────────────────────────────────────────┘
```

| Section | Source |
|---|---|
| Summary | `tasks` + case + assignee / creator `profiles`; parent and follow-ups: `tasks` by `id = parent_task_id` / `parent_task_id = id`; files: `evidence` count by `task_id` |
| Checklist | `v_case_checklist` where `task_id` (+ `evidence_categories.name`, `task_checklist_items.note`) |
| Late-upload holds (D43) | `task_holds` for the task + `profiles.deactivated_at` + `app_settings.late_upload_grace_hours` (72) / `drain_window_days` (7): same deadline as `private.field_upload_allowed()` — `held_until + grace` for a hold that ended before deactivation, `deactivated_at + drain` for a deactivated operator, the earlier wins |
| Files waiting on a phone | `rpc case_outbox_status(case_id)`, limited to operators who held this task and have files waiting |

Actions: **Request re-investigation** (link to the form with `parent`) on a completed task of a case that is not Submitted, Closed or Cancelled (on a Submitted case: **Reopen from Submissions**) (open work is discussed in the thread); **Open case**. On an open task, for whoever manages the case (D44), a **Manage task** panel:

| Action | Form | RPC | What the database does |
|---|---|---|---|
| Edit… | title (3–120), instructions / request (≤ 4000; a request ≥ 10), due (IST; a changed due must be in the future and within a year, an unchanged past due is kept), location (≤ 300) | `update_field_task(p_task_id, p_title, p_instructions, p_due_at, p_location_text)` — replaces all four, blank clears; returns false when nothing changed; refused on a Submitted case (D46; Edit and Reassign are hidden there, Cancel stays) | system message "Field work updated (due time, location): title" (visible to the operators); notifies the operator (`task_updated`); audit `TASK_UPDATED` with the changed fields |
| Reassign operator… | new operator (active field, not the current one), reason 3–500 | `reassign_field_task(p_task_id, p_assignee_id, p_reason)` (case not Submitted / Closed / Cancelled; D46) | assignee changes and the task restarts as Pending; `tasks_track_holds` closes the old hold and opens a new one, so the old operator keeps the D43 late-upload window; visible "Field work reassigned from A to B: title" + staff-only reason; notifies the new operator (`task_assigned` / `field_request`), the old one (`task_unassigned`) and the case owner if someone else acted (`task_reassigned`); audit `TASK_REASSIGNED` |
| Cancel task | confirm dialog with reason 3–500 | `cancel_field_task(p_task_id, p_reason)` | status Cancelled (case to Office review when no field work is left; hold ends); visible "Field work cancelled: title" + staff-only reason; notifies the operator and, if someone else acted, the case owner (`task_cancelled`); audit `TASK_CANCELLED` |

Success redirects back to the task with a flash; errors show inline (`mapDbError`). Server actions in `app/(app)/tasks/[id]/actions.ts`, forms in `components/tasks/task-actions.tsx`, pure helpers in `lib/tasks-actions.ts`.

Empty states: no checklist → "No checklist on this task."; no device report → "No files waiting on the operator's phone." Unknown id → 404.

## DB gaps

Resolved by `20261115600000_field_task_rpcs.sql` (pgTAP `17_field_task_rpcs`):

1. ~~No task lifecycle RPCs~~ — `cancel_field_task`, `reassign_field_task`, `update_field_task` (above). Still open: **complete-by-office** (no RPC; the operator completes). Direct staff updates are no longer possible (D44 policy split, item 5).
2. ~~`create_field_task()` validates little~~ — parent, case status, checklist and D44 ownership are checked in the database.
3. ~~`tasks.reason` cannot be set~~ — `p_reason` (optional, last parameter).

`reassign_case()` is hardened in the same migration: reason 3–500, the current owner and Submitted / Closed / Cancelled cases are refused.

Still open:

4. ~~A task raised on a Submitted case leaves the case Submitted~~ Closed by D46 (`20261115900000_submitted_case_rules`): `create_field_task`, a direct task insert, `reassign_field_task` and `update_field_task` refuse a Submitted case ("This case was submitted. Reopen it from Submissions when the insurer asks."); `cancel_field_task` still clears a left-over open task. Staff reopen the case (`reopen_case`, the insurer's request) first; it returns to office review.
5. ~~Office scope is not enforced by RLS~~ Closed by D44 (`20261115500000_office_case_scope`): office reads only their cases' tasks; staff policies are SELECT + INSERT only.
6. No way to add **ad-hoc checklist items** to a re-investigation task through a function (staff could insert `task_checklist_items` directly; not offered).
7. Field-operator availability: `profiles.availability` exists for every profile but only `set_availability()` changes it and there is no screen for operators; the picker shows it when set.
