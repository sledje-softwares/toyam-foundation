# Dashboard (M9, structure pass)

Route `/dashboard`. Read-only. Roles: admin, orchestrator, office (all staff; see `lib/nav.ts`). Everything is read through the signed-in user's session under RLS (`is_staff()`); no service-role key and no database change.

## Tiles and data sources

| Tile / block | Source (PostgREST) | Links to |
|---|---|---|
| Open cases | `cases` count, `status not in (submitted, closed, cancelled)` | `/cases?scope=open` |
| Awaiting intake review | `intake_extractions` count, `status = pending_review` | `/intake` |
| Failed mail | `emails` count, `status in (failed, retry_requested)` | `/intake/failed` |
| Overdue vs TAT | open cases with `due_at` before today (IST) | `/cases?scope=open&due=overdue` |
| Reports awaiting approval | `report_approvals` count, `decision = pending` | `/reports?approval=pending` |
| Workload, office | open cases grouped by `office_owner_id` (+ unassigned) | `/cases?scope=open&owner=<profile_id>` (`owner=none` for unassigned) |
| Workload, field | `tasks` with `status in (pending, in_progress)` grouped by `assignee_id` | `/tasks?status=open&assignee=<profile_id>` |
| Ageing vs TAT | open cases (`id, insurer_id, due_at`) bucketed in code by IST calendar days to `due_at`: on time (due after today), due today, overdue 1-2 days, overdue 3+ days, no due date | `/cases?scope=open&due=<ontime\|today\|1-2\|3plus\|none>&insurer=<insurer_id>` |
| Recent escalations | the viewer's own `notifications` of kind `case_unassigned`, `no_field_task`, `intake_retry_stuck`, newest 8 (RLS: own rows only) | embeds `cases(case_ref)`; rows link to `/cases/<case_ref>`, or `/intake/failed` for retry alerts |
| Turnaround per stage | `case_status_history` of the last 90 days (limit 5000): time spent in a status = next change minus this change; count, median, mean per stage; still-current stages are skipped | none |
| Model cost vs budget | none yet: placeholder "after 6.10" | none |

Aggregates are shaped in `lib/dashboard.ts` (pure, tested). At ~300 cases a month the open set is a few hundred rows, so one narrow select per block is cheaper than new views. Reads are capped (5000 rows); the page shows "partial" when a cap is hit.

## Query parameters other pages should honour

- `/cases`: `scope=open`, `status=<case_status>`, `due=overdue|today|1-2|3plus|ontime|none`, `insurer=<uuid>`, `owner=<uuid>|none`.
- `/tasks`: `status=open` (pending + in progress), `assignee=<uuid>`.
- `/reports`: `approval=pending`.

## Wireframe

```
Dashboard
[Open cases 212] [Intake review 4] [Failed mail 1] [Overdue 17] [Awaiting approval 6]

Workload: office staff            | Workload: field operators
 name        open cases           |  name        open tasks
 ...                              |  ...
Ageing vs TAT (open cases)
 insurer  | On time | Due today | Overdue 1-2 d | Overdue 3+ d | No date
Recent escalations                | Turnaround per stage (90 days)
 title  when                      |  stage | cases | median | mean
Model cost vs budget: after 6.10
```

## DB gaps

- No escalation table: only the viewer's own notifications are visible (an orchestrator sees theirs, not another's). A staff-wide escalation view needs a view or function.
- No TAT stored per case beyond `due_at`; ageing uses `due_at` (set from the insurer TAT).
- Per-stage turnaround ignores re-entered stages' pairing subtleties (each stay counts once).
- Model cost needs 6.10 (tokens and cost per job, monthly budget).
- Overdue counting uses IST days in code; if row caps get hit, move the buckets into a `security invoker` view.
