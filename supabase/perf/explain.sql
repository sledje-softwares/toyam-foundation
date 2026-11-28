-- =====================================================================
-- DEV-ONLY: timings of the hot read / write paths at volume (load volume.sql first).
--
--   docker cp supabase/perf supabase_db_toyam-foundation:/tmp/
--   docker exec supabase_db_toyam-foundation psql -U postgres -d postgres -X -f /tmp/perf/explain.sql
--
-- Each query runs as the API would run it: role `authenticated`, request.jwt.claims.sub of an
-- orchestrator, an office employee or a field operator (RLS applies), or `service_role` for the
-- cron / worker RPCs. The SQL mirrors what PostgREST builds for the apps' calls (apps/web,
-- apps/field): embeds as LEFT JOIN LATERAL json_agg, `count=exact` as a separate count.
-- pg_temp.bench() runs EXPLAIN (ANALYZE) 7 times and prints the median execution / planning ms.
-- Writes (post_thread_message, save_case_field_values, ...) run inside a transaction that is
-- rolled back. For a full plan: select * from pg_temp.plan($q$ ... $q$); inside a role block.
-- =====================================================================
\set QUIET on
\pset footer off
\pset pager off

create or replace function pg_temp.bench(p_label text, p_sql text, p_runs int default 7)
returns table (path text, exec_ms numeric, plan_ms numeric, top_rows bigint)
language plpgsql as $$
declare j json; e numeric[] := '{}'; pl numeric[] := '{}'; r bigint;
begin
    for i in 1 .. p_runs loop
        execute 'explain (analyze, format json) ' || p_sql into j;
        e  := e  || (j -> 0 ->> 'Execution Time')::numeric;
        pl := pl || (j -> 0 ->> 'Planning Time')::numeric;
        r  := (j -> 0 -> 'Plan' ->> 'Actual Rows')::bigint;
    end loop;
    return query select p_label,
        (select percentile_cont(0.5) within group (order by x) from unnest(e) x)::numeric(10, 2),
        (select percentile_cont(0.5) within group (order by x) from unnest(pl) x)::numeric(10, 2), r;
end $$;

create or replace function pg_temp.plan(p_sql text) returns setof text
language plpgsql as $$
begin
    return query execute 'explain (analyze, buffers) ' || p_sql;
end $$;

-- Who and what (as postgres): Uma (office) and her busiest open case, its open-task operator.
select 'a0000000-0000-4000-8000-000000000002' as orch_id, 'a0000000-0000-4000-8000-000000000003' as office_id \gset
select c.id as case_id, c.case_ref as case_ref, c.template_id as tpl_id
  from public.cases c
 where c.office_owner_id = :'office_id' and c.status = 'field_in_progress' and c.template_id is not null
 order by (select count(*) from public.case_messages m where m.case_id = c.id) desc, c.id limit 1 \gset
select t.id as task_id, t.assignee_id as field_id from public.tasks t
 where t.case_id = :'case_id' and t.status in ('pending', 'in_progress') order by t.created_at desc limit 1 \gset
select c.id as rcase_id, c.case_ref as rcase_ref, c.template_id as rtpl_id from public.cases c
 where c.office_owner_id = :'office_id' and c.status = 'office_review' and c.template_id is not null
 order by c.id limit 1 \gset
select coalesce(jsonb_object_agg(f.key, v.value), '{}') as cur_values from public.case_field_values v
  join public.case_template_fields f on f.id = v.field_id
 where v.case_id = :'rcase_id' and f.key in ('insured_name') \gset

select exists (select 1 from pg_proc where proname = 'staff_workload') as have_workload \gset
-- the web passes the ids of the page it shows as a literal list (.in("case_id", ids))
select string_agg(quote_literal(id), ', ') as page_ids from (
    select id from public.cases where template_id is not null and status = 'office_review'
       and office_owner_id = :'office_id' order by due_at, id limit 25) x \gset

\echo case :case_ref, report case :rcase_ref, operator :field_id

-- ---------------------------------------------------------------------
-- Staff paths, run for the orchestrator and for the office employee
-- ---------------------------------------------------------------------
\set staff_label orchestrator
\set staff_id :orch_id
\ir explain_staff.sql
\set staff_label office
\set staff_id :office_id
\ir explain_staff.sql

-- ---------------------------------------------------------------------
-- Field operator paths
-- ---------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'field_id', 'role', 'authenticated')::text, true) \g /dev/null
\echo
\echo == field operator
select * from pg_temp.bench('field: field_case_list()', $q$ select * from public.field_case_list() $q$)
union all
select * from pg_temp.bench('field: open tasks', $q$ select id, case_id, created_at from public.tasks where status in ('pending', 'in_progress') $q$)
union all
select * from pg_temp.bench('field: case details (case, parties, values)', $q$
    select (select row_to_json(c) from (select policy_no, incident_date, suspicion_summary from public.cases where id = '$q$ || :'case_id' || $q$') c),
           (select json_agg(p) from (select role, name, phone, address from public.parties where case_id = '$q$ || :'case_id' || $q$') p),
           (select json_agg(v) from (select field_id, value from public.case_field_values where case_id = '$q$ || :'case_id' || $q$') v) $q$)
union all
select * from pg_temp.bench('field: thread messages (limit 200)', $q$
    select id, kind, body, sender_id, created_at, withdrawn_at, client_message_id from public.case_messages
     where case_id = '$q$ || :'case_id' || $q$' order by created_at desc limit 200 $q$)
union all
select * from pg_temp.bench('field: thread files + derivatives', $q$
    select e.id, e.message_id, e.evidence_type, e.sha256, coalesce(d.j, '[]') from public.evidence e
      left join lateral (select json_agg(json_build_object('width', x.width)) j from public.evidence_derivatives x where x.evidence_id = e.id) d on true
     where e.case_id = '$q$ || :'case_id' || $q$' and e.message_id is not null and e.withdrawn_at is null
     order by e.created_at limit 1000 $q$)
union all
select * from pg_temp.bench('field: thread file labels', $q$
    select e.id, coalesce(l.j, '[]') from public.evidence e
      left join lateral (select json_agg(json_build_object('is_active', x.is_active, 'source', x.source, 'description', x.description,
                                                           'category', (select json_build_object('code', c.code, 'name', c.name) from public.evidence_categories c where c.id = x.category_id))) j
                           from public.evidence_labels x where x.evidence_id = e.id) l on true
     where e.case_id = '$q$ || :'case_id' || $q$' and e.message_id is not null and e.withdrawn_at is null limit 1000 $q$)
union all
select * from pg_temp.bench('field: file comments', $q$
    select id, evidence_id, body, author_id, created_at from public.evidence_comments
     where case_id = '$q$ || :'case_id' || $q$' order by created_at limit 2000 $q$)
union all
select * from pg_temp.bench('field: v_evidence_processing', $q$
    select evidence_id, state from public.v_evidence_processing where case_id = '$q$ || :'case_id' || $q$' limit 2000 $q$)
union all
select * from pg_temp.bench('field: v_case_checklist', $q$
    select * from public.v_case_checklist where case_id = '$q$ || :'case_id' || $q$' order by position $q$)
union all
select * from pg_temp.bench('field: case_thread_state()', $q$ select * from public.case_thread_state('$q$ || :'case_id' || $q$') $q$)
union all
select * from pg_temp.bench('field: post_thread_message (1 photo)', $q$
    with s as (select encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex') h)
    select public.post_thread_message('$q$ || :'case_id' || $q$', gen_random_uuid(), 'media', null, '$q$ || :'task_id' || $q$', null,
           jsonb_build_array(jsonb_build_object('evidence_type', 'photo', 'capture_source', 'camera', 'mime_type', 'image/jpeg',
               'size_bytes', 100000, 'sha256', s.h,
               'storage_path', 'cases/$q$ || :'case_id' || $q$/tasks/$q$ || :'task_id' || $q$/' || s.h || '.jpg')))
      from s $q$)
union all
select * from pg_temp.bench('field: post_thread_message (text)', $q$
    select public.post_thread_message('$q$ || :'case_id' || $q$', gen_random_uuid(), 'text', 'Reached the garage') $q$)
union all
select * from pg_temp.bench('field: add_evidence_comment', $q$
    select public.add_evidence_comment((select id from public.evidence where case_id = '$q$ || :'case_id' || $q$' and captured_by = '$q$ || :'field_id' || $q$' limit 1),
                                       'A comment', gen_random_uuid()) $q$)
union all
select * from pg_temp.bench('field: mark_thread_read', $q$ select public.mark_thread_read('$q$ || :'case_id' || $q$') $q$);
rollback;

-- ---------------------------------------------------------------------
-- Service role: cron and worker RPCs
-- ---------------------------------------------------------------------
begin;
set local role service_role;
\echo
\echo == service_role
select * from pg_temp.bench('cron: claim_intake_retries(10)', $q$ select * from public.claim_intake_retries(10) $q$)
union all
select * from pg_temp.bench('cron: escalate_stuck_intake_retries()', $q$ select * from public.escalate_stuck_intake_retries() $q$)
union all
select * from pg_temp.bench('intake: email by gmail_message_id', $q$
    select id, status, case_id from public.emails where gmail_message_id = '<perf-17-1@mail.example>' $q$)
union all
select * from pg_temp.bench('worker: running jobs (listRunningJobs)', $q$
    select id, locked_by, locked_at from public.processing_jobs where status = 'running' limit 1000 $q$)
union all
select * from pg_temp.bench('worker: claim_processing_jobs(10)', $q$
    select * from public.claim_processing_jobs(array['ocr', 'label', 'field_suggest', 'text_extract']::public.processing_stage[], 10, 'perf-bench') $q$);
rollback;
