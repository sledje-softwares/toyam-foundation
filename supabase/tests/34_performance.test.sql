-- Performance migration (20261128100000_performance.sql): indexes, helper volatility, staff_workload(),
-- the filename matcher, and — the important part — that the rewritten RLS policies keep the exact
-- access matrix. The matrix check reads every policy-protected table as each user (admin,
-- orchestrator, both office employees, three operators, a deactivated office employee and operator,
-- a signed-in user without a profile) and records the visible rows (ctid) and, for UPDATE policies,
-- the rows an update reaches (rolled back). Then, inside this transaction, it puts back the helper
-- bodies and policy expressions exactly as they were before 20261128100000 and reads again: both
-- reads must be identical, table by table. If a later migration changes a policy on purpose,
-- update the "before" block below to the state just before 20261128100000 still (it is the oracle).
-- Seed data plus a small fixture; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(85);

-- ---------------------------------------------------------------------
-- [1-10] Indexes
-- ---------------------------------------------------------------------
select has_index('public', 'cases', 'ix_cases_open_owner', 'open cases per owner');
select has_index('public', 'tasks', 'ix_tasks_open_due', 'open tasks by due date');
select has_index('public', 'case_field_values', 'ix_case_field_values_field', 'field values by field');
select has_index('public', 'report_approvals', 'ix_report_approvals_case', 'approvals by case');
select has_index('public', 'case_status_history', 'ix_status_hist_changed', 'status history by time');
select has_index('public', 'audit_log', 'ix_audit_field_values_case', 'field-value audit rows by case');
select has_index('public', 'emails', 'ix_emails_retry_alert', 'retries not yet alerted');
select has_index('public', 'processing_jobs', 'ix_processing_jobs_running', 'running pipeline jobs');
select hasnt_index('public', 'evidence_labels', 'ix_evidence_labels_active', 'redundant label index dropped');
select hasnt_index('public', 'evidence_field_matches', 'ix_evidence_field_matches_evidence', 'redundant match index dropped');

-- ---------------------------------------------------------------------
-- [11-22] Helpers: stable, security definer, empty search_path; not callable by anon
-- ---------------------------------------------------------------------
select volatility_is('private', 'sees_all_cases', '{}'::name[], 'stable', 'sees_all_cases is stable');
select volatility_is('private', 'office_case_ids', '{}'::name[], 'stable', 'office_case_ids is stable');
select volatility_is('private', 'field_case_ids', '{}'::name[], 'stable', 'field_case_ids is stable');
select volatility_is('private', 'can_manage_case', array['uuid']::name[], 'stable', 'can_manage_case is stable');
select volatility_is('private', 'can_manage_evidence', array['uuid']::name[], 'stable', 'can_manage_evidence is stable');
select volatility_is('public', 'staff_workload', '{}'::name[], 'stable', 'staff_workload is stable');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private'
              and p.proname in ('sees_all_cases', 'office_case_ids', 'field_case_ids', 'can_manage_case', 'can_manage_case_owner',
                                'can_manage_task', 'can_manage_evidence', 'can_manage_report')),
          'policy helpers are security definer with an empty search_path');
select ok(not (select p.prosecdef from pg_proc p where p.oid = 'public.staff_workload()'::regprocedure),
          'staff_workload runs as the caller (RLS applies)');
select ok(not has_function_privilege('anon', 'private.office_case_ids()', 'execute'), 'anon cannot call office_case_ids');
select ok(not has_function_privilege('anon', 'public.staff_workload()', 'execute'), 'anon cannot call staff_workload');
select ok(has_function_privilege('authenticated', 'public.staff_workload()', 'execute'), 'signed-in users can call staff_workload');
select is((select count(*)::int from pg_policies
            where schemaname = 'public'
              and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '(?<!SELECT )(?<!SELECT public\.)(?<!SELECT private\.)(is_staff|is_field|is_admin|current_user_role|sees_all_cases)\(\)'),
          0, 'no policy calls an argument-free role helper per row (wrap it in a scalar subquery)');

-- ---------------------------------------------------------------------
-- Fixture: deactivated office employee with a case, deactivated operator with a task, a signed-in
-- user without a profile, a staff-only file, a withdrawn file, an outbox row.
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','34000000-0000-4000-8000-0000000000b9','authenticated','authenticated','pf-off-gone@example.com',null,'{"role":"office","full_name":"PF Office Gone"}','{}'),
 ('00000000-0000-0000-0000-000000000000','34000000-0000-4000-8000-0000000000f9','authenticated','authenticated',null,'919870003409','{"role":"field","full_name":"PF Field Gone"}','{}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('34100000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000004', 'PF-GONE-1', 'motor', 'assigned',
        '34000000-0000-4000-8000-0000000000b9');
insert into public.tasks (id, case_id, title, assignee_id)
values ('34200000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000103', 'PF visit', '34000000-0000-4000-8000-0000000000f9');
update public.profiles set is_active = false
 where id in ('34000000-0000-4000-8000-0000000000b9', '34000000-0000-4000-8000-0000000000f9');

set local app.system_message to 'off';
insert into public.case_messages (id, case_id, sender_id, kind, body, visibility)
values ('34300000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000103', 'a0000000-0000-4000-8000-000000000004',
        'media', 'staff-only file', 'staff');
insert into public.evidence (case_id, evidence_type, capture_source, storage_path, sha256, captured_by, message_id)
values ('d0000000-0000-4000-8000-000000000103', 'photo', 'web_upload',
        'cases/d0000000-0000-4000-8000-000000000103/files/' || repeat('3a', 32) || '.jpg', repeat('3a', 32),
        'a0000000-0000-4000-8000-000000000004', '34300000-0000-4000-8000-000000000001');
set local app.withdrawing to 'on';
update public.evidence set withdrawn_at = now(), withdrawn_by = captured_by
 where id = (select e.id from public.evidence e where e.case_id = 'd0000000-0000-4000-8000-000000000103'
                and e.message_id is not null and e.captured_by = 'a0000000-0000-4000-8000-000000000012'
              order by e.id limit 1);
set local app.withdrawing to 'off';
insert into public.field_devices (device_id, profile_id, secret_sha256)
values ('34400000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000012', repeat('ab', 32));
insert into public.device_outbox_status (device_id, profile_id, pending_count, pending_bytes)
values ('34400000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000012', 2, 2048);

-- rows for tables the seed leaves empty
insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height)
select e.id, 384, private.derivative_path(e.case_id, e.sha256, 384, md5(e.id::text) || md5(e.sha256)), md5(e.id::text) || md5(e.sha256),
       1000, 384, 288
  from public.evidence e where e.evidence_type = 'photo' and e.sha256 is not null;
insert into public.evidence_ocr (evidence_id, page_no, engine, text, blocks)
select e.id, 1, 'mlkit_device', 'MH12 AB 1234', '[]' from public.evidence e where e.evidence_type in ('photo', 'document');
insert into public.evidence_comments (evidence_id, case_id, author_id, body, client_comment_id)
select e.id, e.case_id, e.captured_by, 'PF comment', gen_random_uuid()
  from public.evidence e where e.message_id is not null and e.captured_by is not null;
insert into public.report_files (report_id, format, storage_path)
select r.id, 'pdf', r.case_id || '/' || r.id || '/report.pdf' from public.reports r;
insert into public.report_annexures (report_id, evidence_id, section_key, position)
select r.id, (select e.id from public.evidence e where e.case_id = r.case_id and e.withdrawn_at is null
                and e.relevance <> 'not_relevant' and e.evidence_type = 'photo' order by e.id limit 1), null, 1
  from public.reports r
 where exists (select 1 from public.evidence e where e.case_id = r.case_id and e.withdrawn_at is null
                 and e.relevance <> 'not_relevant' and e.evidence_type = 'photo');
insert into public.entities (id, entity_type, name) values ('34500000-0000-4000-8000-000000000001', 'garage', 'PF Garage');
insert into public.case_entities (case_id, entity_id) select c.id, '34500000-0000-4000-8000-000000000001' from public.cases c;
insert into public.case_thread_reads (case_id, user_id, last_read_at)
select distinct t.case_id, t.assignee_id, now() from public.tasks t where t.assignee_id is not null
union
select c.id, c.office_owner_id, now() from public.cases c where c.office_owner_id is not null;
insert into public.assignment_rules (id, name, claim_type) values ('34600000-0000-4000-8000-000000000001', 'PF motor', 'motor');
insert into public.assignment_rule_members (rule_id, profile_id) values ('34600000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003');
insert into public.device_tokens (token, user_id) values ('pf-token-field', 'a0000000-0000-4000-8000-000000000012'),
    ('pf-token-office', 'a0000000-0000-4000-8000-000000000003');
insert into public.report_sends (case_id, report_id, requested_by, formats, to_addresses, subject, body, attachment_name)
select r.case_id, r.id, 'a0000000-0000-4000-8000-000000000004', '{pdf}', '{claims@example.com}', 'PF report', 'PF body', 'report'
  from public.reports r where r.id = '91000000-0000-4000-8000-000000000106';

create temp table t_users (uid uuid primary key, who text not null) on commit drop;
insert into t_users values
 ('a0000000-0000-4000-8000-000000000001', 'admin'),
 ('a0000000-0000-4000-8000-000000000002', 'orchestrator'),
 ('a0000000-0000-4000-8000-000000000003', 'office Uma'),
 ('a0000000-0000-4000-8000-000000000004', 'office Neel'),
 ('a0000000-0000-4000-8000-000000000011', 'field Farid'),
 ('a0000000-0000-4000-8000-000000000012', 'field Fatima'),
 ('a0000000-0000-4000-8000-000000000013', 'field Feroz'),
 ('34000000-0000-4000-8000-0000000000b9', 'deactivated office'),
 ('34000000-0000-4000-8000-0000000000f9', 'deactivated field'),
 ('34000000-0000-4000-8000-00000000dead', 'no profile');
create temp table t_tables (tbl text primary key) on commit drop;
insert into t_tables select distinct tablename from pg_policies where schemaname = 'public' and tablename <> 'notifications';
create temp table t_upd (tbl text primary key, set_expr text not null) on commit drop;
insert into t_upd values ('evidence', 'is_flagged = is_flagged'), ('tasks', 'status = status'),
    ('task_checklist_items', 'note = note'), ('field_suggestions', 'status = status'), ('report_approvals', 'comments = comments');
create temp table t_vis (phase text, uid uuid, tbl text, rowref text) on commit drop;
grant select on t_users, t_tables, t_upd to authenticated;
grant insert on t_vis to authenticated;

-- Reads every table as every user (and the rows an UPDATE reaches, undone); back as postgres after.
create function pg_temp.collect(p_phase text) returns void
language plpgsql as $$
declare u record; t record; v_ids text[]; v_state text;
begin
    for u in select uid from t_users order by uid loop
        perform set_config('request.jwt.claims', json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        for t in select tbl from t_tables order by tbl loop
            execute format('insert into t_vis select %L, %L, %L, ctid::text from public.%I', p_phase, u.uid, t.tbl, t.tbl);
        end loop;
        for t in select tbl, set_expr from t_upd order by tbl loop
            v_ids := null;
            begin
                execute format('with x as (update public.%I set %s returning id::text as id) select array_agg(id order by id) from x',
                               t.tbl, t.set_expr) into v_ids;
                v_state := 'ok';
                raise exception 'undo' using errcode = 'PT001';
            exception
                when sqlstate 'PT001' then null;
                when others then v_state := 'error ' || sqlstate; v_ids := null;
            end;
            insert into t_vis select p_phase, u.uid, 'update ' || t.tbl, x
              from unnest(coalesce(v_ids, array[v_state])) x;
        end loop;
        perform set_config('role', 'postgres', true);
    end loop;
    perform set_config('request.jwt.claims', '', true);
end $$;

create function pg_temp.differences(p_tbl text) returns int
language sql as $$
    select count(*)::int from (
        (select uid, rowref from t_vis where phase = 'new' and tbl = p_tbl
         except all select uid, rowref from t_vis where phase = 'old' and tbl = p_tbl)
        union all
        (select uid, rowref from t_vis where phase = 'old' and tbl = p_tbl
         except all select uid, rowref from t_vis where phase = 'new' and tbl = p_tbl)) d;
$$;

-- ---------------------------------------------------------------------
-- [23-28] staff_workload()
-- ---------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
create temp table t_wl_orch on commit drop as select * from public.staff_workload();
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}';
create temp table t_wl_uma on commit drop as select * from public.staff_workload();
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-000000000012","role":"authenticated"}';
create temp table t_wl_field on commit drop as select * from public.staff_workload();
reset role;
reset request.jwt.claims;

select set_eq('select profile_id, open_cases, open_tasks from t_wl_orch',
    $$ with c as (select office_owner_id p, count(*)::int n from public.cases
                   where status not in ('submitted', 'closed', 'cancelled') and office_owner_id is not null group by 1),
            t as (select assignee_id p, count(*)::int n from public.tasks
                   where status in ('pending', 'in_progress') and assignee_id is not null group by 1)
       select coalesce(c.p, t.p) as pid, coalesce(c.n, 0) as nc, coalesce(t.n, 0) as nt from c full join t on t.p = c.p $$,
    'orchestrator: open cases per owner and open tasks per operator over all cases');
select ok((select count(*) from t_wl_orch where open_cases > 0) >= 2 and (select count(*) from t_wl_orch where open_tasks > 0) >= 2,
          'orchestrator counts cover several owners and operators');
select set_eq('select profile_id, open_cases from t_wl_uma where open_cases > 0',
    $$ select office_owner_id, count(*)::int from public.cases
        where status not in ('submitted', 'closed', 'cancelled') and office_owner_id = 'a0000000-0000-4000-8000-000000000003' group by 1 $$,
    'office: only their own open cases are counted (D44)');
select set_eq('select profile_id, open_tasks from t_wl_uma where open_tasks > 0',
    $$ select t.assignee_id, count(*)::int from public.tasks t join public.cases c on c.id = t.case_id
        where t.status in ('pending', 'in_progress') and t.assignee_id is not null
          and c.office_owner_id = 'a0000000-0000-4000-8000-000000000003' group by 1 $$,
    'office: open tasks counted only on their own cases');
select ok(not exists (select 1 from t_wl_uma where profile_id = 'a0000000-0000-4000-8000-000000000004'),
          'office: another office employee''s workload is not shown');
select is((select count(*)::int from t_wl_field), 0, 'field users get no workload rows');

-- ---------------------------------------------------------------------
-- [29-30] Filename matcher: same categories as before, also with a pattern that does not compile
-- ---------------------------------------------------------------------
create function pg_temp.old_match(p_name text) returns setof uuid
language plpgsql stable set search_path = '' as $$
declare v_variants text[] := private.filename_label_variants(p_name); c record; p text; v_hit boolean; v_seen uuid[] := '{}';
begin
    if coalesce(array_length(v_variants, 1), 0) = 0 or v_variants[1] = '' then return; end if;
    for c in select ec.id, ec.code, ec.filename_patterns from public.evidence_categories ec
              where ec.is_active and ec.filename_patterns <> '{}' order by ec.code loop
        v_hit := false;
        foreach p in array c.filename_patterns loop
            begin
                p := replace(p, '\b', '\y');
                if exists (select 1 from unnest(v_variants) v where v ~* p) then v_hit := true; exit; end if;
            exception when others then null;
            end;
        end loop;
        if v_hit and not (c.id = any (v_seen)) then v_seen := v_seen || c.id; return next c.id; end if;
    end loop;
end $$;
create temp table t_names (n text) on commit drop;
insert into t_names values ('Front View(1).png'), ('Odometer(1).png'), ('Spot(1).png'), ('chassis_no.jpg'), ('RC_copy.jpg'),
    ('DL_front.jpg'), ('claim_form.pdf'), ('estimate.pdf'), ('policy_schedule.pdf'), ('FIR copy.pdf'), ('IMG_20261101_1234.jpg'),
    ('random.bin'), (''), ('Aadhaar card.jpg'), ('towing bill final.pdf'), ('job card.pdf');
select is((select count(*)::int from t_names n
            where array(select private.match_filename_categories(n.n)) is distinct from array(select pg_temp.old_match(n.n))),
          0, 'filename matcher: same categories in the same order as the per-pattern loop');
insert into public.evidence_categories (code, name, filename_patterns) values ('pf_broken', 'PF broken', array['spot(', 'front']);
set local client_min_messages to error;   -- the fallback warns about the broken pattern, as before
select is((select count(*)::int from t_names n
            where array(select private.match_filename_categories(n.n)) is distinct from array(select pg_temp.old_match(n.n))),
          0, 'filename matcher: same answers when a pattern does not compile (falls back to the per-pattern loop)');
reset client_min_messages;
delete from public.evidence_categories where code = 'pf_broken';

-- ---------------------------------------------------------------------
-- [31-85] Access matrix: new policies vs the policies before 20261128100000
-- ---------------------------------------------------------------------
select pg_temp.collect('new');

set local search_path = public, extensions;
-- Before: helper bodies from 20261115500000 / 20261115800000
create or replace function private.can_manage_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then exists (select 1 from public.cases c where c.id = p_case_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
create or replace function private.can_manage_case_owner(p_office_owner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then p_office_owner_id is not null and p_office_owner_id = (select auth.uid())
    else false end
$$;
create or replace function private.can_manage_task(p_task_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then exists (select 1 from public.tasks t join public.cases c on c.id = t.case_id
                                where t.id = p_task_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
create or replace function private.can_manage_evidence(p_evidence_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then exists (select 1 from public.evidence e join public.cases c on c.id = e.case_id
                                where e.id = p_evidence_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
create or replace function private.can_manage_report(p_report_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then exists (select 1 from public.reports r join public.cases c on c.id = r.case_id
                                where r.id = p_report_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
-- Before: policy expressions as they were on 20261127300000 (pg_policies text)
alter policy p_settings_admin on public.app_settings using (is_admin()) with check (is_admin());
alter policy p_settings_read on public.app_settings using (is_staff());
alter policy p_rule_members_read on public.assignment_rule_members using (is_staff());
alter policy p_rule_members_write on public.assignment_rule_members using ((private.current_user_role() = ANY (ARRAY['admin'::user_role, 'orchestrator'::user_role]))) with check ((private.current_user_role() = ANY (ARRAY['admin'::user_role, 'orchestrator'::user_role])));
alter policy p_rules_read on public.assignment_rules using (is_staff());
alter policy p_rules_write on public.assignment_rules using ((private.current_user_role() = ANY (ARRAY['admin'::user_role, 'orchestrator'::user_role]))) with check ((private.current_user_role() = ANY (ARRAY['admin'::user_role, 'orchestrator'::user_role])));
alter policy p_audit_admin on public.audit_log using (is_admin());
alter policy p_assignments_read on public.case_assignments using (private.can_manage_case(case_id));
alter policy p_case_ent_staff on public.case_entities using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));
alter policy p_cfv_field on public.case_field_values using ((is_field() AND private.field_can_see_case(case_id) AND private.is_intake_field(field_id)));
alter policy p_cfv_staff_r on public.case_field_values using (private.can_manage_case(case_id));
alter policy p_msg_field_r on public.case_messages using ((is_field() AND (visibility = 'all'::text) AND private.field_can_see_case(case_id)));
alter policy p_msg_field_w on public.case_messages with check ((is_field() AND (sender_id = ( SELECT auth.uid() AS uid)) AND (kind = ANY (ARRAY['text'::message_kind, 'media'::message_kind, 'voice'::message_kind])) AND (visibility = 'all'::text) AND private.field_can_post(case_id)));
alter policy p_msg_staff_r on public.case_messages using (private.can_manage_case(case_id));
alter policy p_msg_staff_w on public.case_messages with check ((private.can_manage_case(case_id) AND (sender_id = ( SELECT auth.uid() AS uid)) AND (kind = ANY (ARRAY['text'::message_kind, 'media'::message_kind, 'voice'::message_kind]))));
alter policy p_hist_staff on public.case_status_history using (private.can_manage_case(case_id));
alter policy p_ctcf_admin on public.case_template_category_fields using (is_admin()) with check (is_admin());
alter policy p_ctcf_read on public.case_template_category_fields using (is_staff());
alter policy p_ctcl_admin on public.case_template_checklists using (is_admin()) with check (is_admin());
alter policy p_ctcl_read on public.case_template_checklists using (is_staff());
alter policy p_ctpf_admin on public.case_template_fields using (is_admin()) with check (is_admin());
alter policy p_ctpf_read on public.case_template_fields using (is_staff());
alter policy p_ctsc_admin on public.case_template_section_categories using (is_admin()) with check (is_admin());
alter policy p_ctsc_read on public.case_template_section_categories using (is_staff());
alter policy p_ctps_admin on public.case_template_sections using (is_admin()) with check (is_admin());
alter policy p_ctps_read on public.case_template_sections using (is_staff());
alter policy p_ctpl_admin on public.case_templates using (is_admin()) with check (is_admin());
alter policy p_ctpl_read on public.case_templates using (is_staff());
alter policy p_reads_own on public.case_thread_reads using ((user_id = ( SELECT auth.uid() AS uid))) with check (((user_id = ( SELECT auth.uid() AS uid)) AND (private.can_manage_case(case_id) OR (is_field() AND private.field_can_see_case(case_id)))));
alter policy p_cases_field on public.cases using ((is_field() AND private.field_can_see_case(id)));
alter policy p_cases_staff on public.cases using (private.can_manage_case(id)) with check (private.can_manage_case_owner(office_owner_id));
alter policy p_tpli_admin on public.checklist_template_items using (is_admin()) with check (is_admin());
alter policy p_tpli_read on public.checklist_template_items using (is_staff());
alter policy p_tpl_admin on public.checklist_templates using (is_admin()) with check (is_admin());
alter policy p_tpl_read on public.checklist_templates using (is_staff());
alter policy p_outbox_own_r on public.device_outbox_status using ((is_field() AND (profile_id = ( SELECT auth.uid() AS uid))));
alter policy p_outbox_staff_r on public.device_outbox_status using (private.can_see_operator_outbox(profile_id));
alter policy p_tokens_own on public.device_tokens using ((user_id = ( SELECT auth.uid() AS uid))) with check (((user_id = ( SELECT auth.uid() AS uid)) AND (private.current_user_role() IS NOT NULL)));
alter policy p_attach_staff on public.email_attachments using (private.can_manage_email(email_id)) with check (private.can_manage_email(email_id));
alter policy p_emails_staff on public.emails using (private.can_manage_intake(case_id)) with check (private.can_manage_intake(case_id));
alter policy p_entities_staff on public.entities using (is_staff()) with check (is_staff());
alter policy p_evidence_field_r on public.evidence using ((is_field() AND ((captured_by = ( SELECT auth.uid() AS uid)) OR ((message_id IS NOT NULL) AND (withdrawn_at IS NULL) AND private.field_can_see_case(case_id) AND (EXISTS ( SELECT 1
   FROM case_messages m
  WHERE ((m.id = evidence.message_id) AND (m.visibility = 'all'::text))))))));
alter policy p_evidence_field_w on public.evidence with check ((is_field() AND (captured_by = ( SELECT auth.uid() AS uid)) AND (capture_source = ANY (ARRAY['camera'::capture_source, 'gallery'::capture_source, 'share'::capture_source])) AND (EXISTS ( SELECT 1
   FROM tasks t
  WHERE ((t.id = evidence.task_id) AND (t.case_id = evidence.case_id) AND (t.assignee_id = ( SELECT auth.uid() AS uid)) AND (t.status = ANY (ARRAY['pending'::task_status, 'in_progress'::task_status])))))));
alter policy p_evidence_staff_r on public.evidence using (private.can_manage_case(case_id));
alter policy p_evidence_staff_u on public.evidence using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));
alter policy p_evidence_staff_w on public.evidence with check ((private.can_manage_case(case_id) AND (captured_by = ( SELECT auth.uid() AS uid))));
alter policy p_categories_admin on public.evidence_categories using (is_admin()) with check (is_admin());
alter policy p_categories_read on public.evidence_categories using ((is_staff() OR is_field()));
alter policy p_evidence_comments_read on public.evidence_comments using ((private.can_manage_evidence(evidence_id) OR (is_field() AND (EXISTS ( SELECT 1
   FROM evidence e
  WHERE (e.id = evidence_comments.evidence_id))))));
alter policy p_derivatives_field_r on public.evidence_derivatives using ((is_field() AND (EXISTS ( SELECT 1
   FROM evidence e
  WHERE (e.id = evidence_derivatives.evidence_id)))));
alter policy p_derivatives_staff_r on public.evidence_derivatives using ((is_staff() AND private.can_manage_evidence(evidence_id)));
alter policy p_field_matches_staff on public.evidence_field_matches using (private.can_manage_evidence(evidence_id));
alter policy p_labels_field_w on public.evidence_labels with check ((is_field() AND (source = 'operator'::label_source) AND (EXISTS ( SELECT 1
   FROM evidence e
  WHERE ((e.id = evidence_labels.evidence_id) AND (e.captured_by = ( SELECT auth.uid() AS uid)))))));
alter policy p_labels_read on public.evidence_labels using ((private.can_manage_evidence(evidence_id) OR (is_field() AND (EXISTS ( SELECT 1
   FROM evidence e
  WHERE (e.id = evidence_labels.evidence_id))))));
alter policy p_labels_staff_w on public.evidence_labels with check ((private.can_manage_evidence(evidence_id) AND (source = ANY (ARRAY['human'::label_source, 'operator'::label_source]))));
alter policy p_ocr_staff on public.evidence_ocr using (private.can_manage_evidence(evidence_id));
alter policy p_suggest_staff on public.field_suggestions using (private.can_manage_evidence(evidence_id));
alter policy p_suggest_staff_u on public.field_suggestions using (private.can_manage_evidence(evidence_id)) with check (private.can_manage_evidence(evidence_id));
alter policy p_insurers_admin on public.insurers using (is_admin()) with check (is_admin());
alter policy p_insurers_read on public.insurers using ((is_staff() OR is_field()));
alter policy p_extract_staff on public.intake_extractions using (private.can_manage_intake(case_id)) with check (private.can_manage_intake(case_id));
alter policy p_parties_field on public.parties using ((is_field() AND private.field_can_see_case(case_id)));
alter policy p_parties_staff on public.parties using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));
alter policy p_jobs_read on public.processing_jobs using ((private.can_manage_evidence(evidence_id) OR (is_field() AND (EXISTS ( SELECT 1
   FROM evidence e
  WHERE (e.id = processing_jobs.evidence_id))))));
alter policy p_profiles_admin on public.profiles using (is_admin()) with check (is_admin());
alter policy p_profiles_self on public.profiles using (((id = ( SELECT auth.uid() AS uid)) OR is_staff()));
alter policy p_rannex_staff on public.report_annexures using (private.can_manage_report(report_id)) with check (private.can_manage_report(report_id));
alter policy p_approvals_i on public.report_approvals with check ((private.can_manage_case(case_id) AND (requested_by = ( SELECT auth.uid() AS uid))));
alter policy p_approvals_r on public.report_approvals using (private.can_manage_case(case_id));
alter policy p_approvals_u on public.report_approvals using ((private.current_user_role() = ANY (ARRAY['orchestrator'::user_role, 'admin'::user_role]))) with check ((private.current_user_role() = ANY (ARRAY['orchestrator'::user_role, 'admin'::user_role])));
alter policy p_rfiles_staff on public.report_files using (private.can_manage_report(report_id)) with check (private.can_manage_report(report_id));
alter policy p_rsends_staff_r on public.report_sends using ((is_staff() AND private.can_manage_case(case_id)));
alter policy p_reports_staff on public.reports using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));
alter policy p_subs_staff_i on public.submissions with check ((is_staff() AND (submitted_by = ( SELECT auth.uid() AS uid)) AND private.can_manage_case(case_id)));
alter policy p_subs_staff_r on public.submissions using (private.can_manage_case(case_id));
alter policy p_check_field_r on public.task_checklist_items using ((is_field() AND (EXISTS ( SELECT 1
   FROM tasks t
  WHERE ((t.id = task_checklist_items.task_id) AND (t.assignee_id = ( SELECT auth.uid() AS uid)))))));
alter policy p_check_field_u on public.task_checklist_items using ((is_field() AND (EXISTS ( SELECT 1
   FROM tasks t
  WHERE ((t.id = task_checklist_items.task_id) AND (t.assignee_id = ( SELECT auth.uid() AS uid)) AND (t.status = ANY (ARRAY['pending'::task_status, 'in_progress'::task_status]))))))) with check ((is_field() AND (EXISTS ( SELECT 1
   FROM tasks t
  WHERE ((t.id = task_checklist_items.task_id) AND (t.assignee_id = ( SELECT auth.uid() AS uid)) AND (t.status = ANY (ARRAY['pending'::task_status, 'in_progress'::task_status])))))));
alter policy p_checklist_staff on public.task_checklist_items using (private.can_manage_task(task_id)) with check (private.can_manage_task(task_id));
alter policy p_task_holds_staff on public.task_holds using (private.can_manage_task(task_id));
alter policy p_tasks_field_r on public.tasks using ((is_field() AND (assignee_id = ( SELECT auth.uid() AS uid))));
alter policy p_tasks_field_u on public.tasks using ((is_field() AND (assignee_id = ( SELECT auth.uid() AS uid)))) with check ((is_field() AND (assignee_id = ( SELECT auth.uid() AS uid))));
alter policy p_tasks_staff_i on public.tasks with check (private.can_manage_case(case_id));
alter policy p_tasks_staff_r on public.tasks using (private.can_manage_case(case_id));

reset search_path;

select pg_temp.collect('old');

-- the reads are not empty: every user saw something, and the scopes differ
select ok((select count(distinct uid) from t_vis where phase = 'new' and tbl = 'evidence') = 7,
          'seven users see files (admin, orchestrator, two office, three operators)');
select ok((select count(*) from t_vis where phase = 'new' and tbl = 'cases' and uid = 'a0000000-0000-4000-8000-000000000003')
          < (select count(*) from t_vis where phase = 'new' and tbl = 'cases' and uid = 'a0000000-0000-4000-8000-000000000002'),
          'office sees fewer cases than the orchestrator');
select ok((select count(*) from t_vis where phase = 'new' and uid in ('34000000-0000-4000-8000-0000000000b9',
                                                                      '34000000-0000-4000-8000-0000000000f9',
                                                                      '34000000-0000-4000-8000-00000000dead')
             and tbl in ('cases', 'evidence', 'case_messages', 'tasks', 'emails')) = 0,
          'deactivated users and users without a profile see no case data');
select ok(exists (select 1 from t_vis where phase = 'new' and tbl = 'update evidence' and uid = 'a0000000-0000-4000-8000-000000000003'
                    and rowref <> 'ok' and rowref not like 'error%'),
          'the update check reaches rows (office updates own files)');

select is(pg_temp.differences(t.tbl), 0, t.tbl || ': same rows for every user as before')
  from (select tbl from t_tables union all select 'update ' || tbl from t_upd) t
 order by t.tbl;

select * from finish();
rollback;
