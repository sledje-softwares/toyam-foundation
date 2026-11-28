# Performance check at volume (dev only)

Synthetic data and timings for the hot database paths. **Local stack only**; never run these against a hosted project.

| File | What it does |
|---|---|
| `volume.sql` | Adds synthetic data on top of `seed.sql`: 1 office + 7 field users (3 office, 10 operators), 4 000 cases over five insurers / three templates / all statuses, ~12 000 field tasks with checklist items, ~200 000 thread messages, ~150 000 evidence rows with labels, 384 / 1600 px copies, device OCR, processing jobs and file comments, ~150 000 report values, ~6 500 emails with attachments and intake rows, reports / approvals / submissions, read pointers. Rows go through the normal triggers (audit, assignment, status history, processing queue, guards). Only the last step, back-dating timestamps, runs in one transaction with `session_replication_role = replica` for that session, because the guards stamp `created_at` with `now()` and forbid changing it. Deterministic. Takes ~5–10 minutes on a laptop. |
| `explain.sql` (+ `explain_staff.sql`) | Runs each hot path 7× with `EXPLAIN (ANALYZE)` as the API would: role `authenticated` with the `sub` of the orchestrator, an office employee and a field operator (RLS applies), or `service_role` for the cron / worker RPCs. Prints the median execution and planning time. The SQL mirrors what PostgREST builds for the apps' calls. Writes run in a transaction that is rolled back. |

```bash
npx -y supabase@3.1.0 db reset
docker exec -i supabase_db_toyam-foundation psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/perf/volume.sql
docker cp supabase/perf supabase_db_toyam-foundation:/tmp/
docker exec supabase_db_toyam-foundation psql -U postgres -d postgres -X -f /tmp/perf/explain.sql
```

For a full plan of one query, inside a role block of `explain.sql` (or after the same `set local role` / `request.jwt.claims` lines): `select * from pg_temp.plan($q$ select ... $q$);`.

`supabase db reset` removes the synthetic data again. pgTAP (`supabase test db`) expects the plain seed, so reset before running the tests.

Results of the 2026-11-28 run and the changes they led to: `supabase/migrations/20261128100000_performance.sql` (header comment).
