-- Office walkthrough fixes (20261128200000_office_walkthrough_fixes.sql): incident date mirrored from the
-- template's date_of_loss / loss_datetime (parsing, sync, mirror guard, backfill), staff-only approval
-- events in the thread (request, changes requested, approved, one-step approval), and the staff-only note
-- when field work is completed with required checklist items missing. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(65);

-- ---------------------------------------------------------------------
-- Fixture (prefix 35...): c1 orchestrator, b1 office (owns every case), f1 field.
-- Templates: WKA (date_of_loss, date), WKB (loss_datetime, datetime), WKC (no loss date).
--   K1 WKA office review      K2 WKB office review      K3 WKC office review
--   K4 WKA office review (approval request flow)        K5 WKA office review (one-step approval)
--   K6 WKC assigned: tasks T1..T4 for complete_field_task
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','35000000-0000-4000-8000-0000000000c1','authenticated','authenticated','wk-orch@example.com',null,'{"role":"orchestrator","full_name":"W Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','35000000-0000-4000-8000-0000000000b1','authenticated','authenticated','wk-off1@example.com',null,'{"role":"office","full_name":"W Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','35000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000351','{"role":"field","full_name":"W Field"}','{}');

insert into public.insurers (id, name, code) values
 ('35100000-0000-4000-8000-0000000000a1', 'Walk A', 'WKA'),
 ('35100000-0000-4000-8000-0000000000a2', 'Walk B', 'WKB'),
 ('35100000-0000-4000-8000-0000000000a3', 'Walk C', 'WKC');
select public.load_case_template('{"insurer_code":"WKA","claim_type":"motor","variant":"od","name":"WKA OD","requires_approval":true,"output_formats":["pdf"],
  "sections":[{"key":"claim","title":"Claim","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake"},
      {"key":"date_of_loss","label":"Date of loss","type":"date","source":"intake"},
      {"key":"insured_name","label":"Insured name","source":"intake"}]}]}');
select public.load_case_template('{"insurer_code":"WKB","claim_type":"motor","variant":"od","name":"WKB OD","requires_approval":true,"output_formats":["pdf"],
  "sections":[{"key":"claim","title":"Claim","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake"},
      {"key":"loss_datetime","label":"Loss date and time","type":"datetime","source":"intake"}]}]}');
select public.load_case_template('{"insurer_code":"WKC","claim_type":"motor","variant":"od","name":"WKC OD","requires_approval":true,"output_formats":["pdf"],
  "sections":[{"key":"claim","title":"Claim","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake"},
      {"key":"remarks","label":"Remarks"}]}]}');

create function pg_temp.tpl(p_code text) returns uuid language sql stable security definer set search_path = '' as $$
    select t.id from public.case_templates t join public.insurers i on i.id = t.insurer_id where i.code = p_code and t.is_active $$;
create function pg_temp.idate(p_case uuid) returns date language sql stable security definer set search_path = '' as $$
    select c.incident_date from public.cases c where c.id = p_case $$;
grant execute on function pg_temp.tpl(text), pg_temp.idate(uuid) to authenticated;

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select v.id::uuid, i.id, v.claim, 'motor', pg_temp.tpl(v.code), '35000000-0000-4000-8000-0000000000b1', v.st::public.case_status
  from (values ('35200000-0000-4000-8000-000000000001', 'WKA', 'WKA-1', 'office_review'),
               ('35200000-0000-4000-8000-000000000002', 'WKB', 'WKB-1', 'office_review'),
               ('35200000-0000-4000-8000-000000000003', 'WKC', 'WKC-1', 'office_review'),
               ('35200000-0000-4000-8000-000000000004', 'WKA', 'WKA-4', 'office_review'),
               ('35200000-0000-4000-8000-000000000005', 'WKA', 'WKA-5', 'office_review'),
               ('35200000-0000-4000-8000-000000000006', 'WKC', 'WKC-6', 'assigned')) v(id, code, claim, st)
  join public.insurers i on i.code = v.code;

-- =====================================================================
-- A1. private.parse_loss_date
-- =====================================================================
select is(private.parse_loss_date('2026-11-10'), '2026-11-10'::date, 'ISO date');
select is(private.parse_loss_date(' 2026-11-10 21:30 '), '2026-11-10'::date, 'ISO date and time (space)');
select is(private.parse_loss_date('2026-11-10T21:30:00+05:30'), '2026-11-10'::date, 'ISO date and time (T, offset)');
select is(private.parse_loss_date('10/11/2026'), '2026-11-10'::date, 'DD/MM/YYYY is day first');
select is(private.parse_loss_date('10-11-2026'), '2026-11-10'::date, 'DD-MM-YYYY');
select is(private.parse_loss_date('5/3/2026 9:15 PM'), '2026-03-05'::date, 'D/M/YYYY followed by a time');
select is(private.parse_loss_date('10-11-2026 21:30'), '2026-11-10'::date, 'DD-MM-YYYY HH:MM');
select is(private.parse_loss_date('31/02/2026'), null::date, 'impossible date gives null');
select is(private.parse_loss_date('2026-13-01'), null::date, 'month 13 gives null');
select is(private.parse_loss_date('10-11/2026'), null::date, 'mixed separators give null');
select is(private.parse_loss_date('last Tuesday'), null::date, 'text gives null');
select is(private.parse_loss_date(''), null::date, 'empty gives null');
select is(private.parse_loss_date(null), null::date, 'null gives null');

-- =====================================================================
-- A2. Sync from case_field_values
-- =====================================================================
insert into public.case_field_values (case_id, field_id, value, source)
select '35200000-0000-4000-8000-000000000001', f.id, '2026-11-10', 'email_parser'
  from public.case_template_fields f where f.template_id = pg_temp.tpl('WKA') and f.key = 'date_of_loss';
insert into public.case_field_values (case_id, field_id, value, source)
select '35200000-0000-4000-8000-000000000002', f.id, '2026-10-05 21:30', 'email_parser'
  from public.case_template_fields f where f.template_id = pg_temp.tpl('WKB') and f.key = 'loss_datetime';
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), '2026-11-10'::date, 'date_of_loss sets the incident date on insert');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000002'), '2026-10-05'::date, 'loss_datetime sets the date part');

set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000001', '{"date_of_loss":"15/11/2026"}', '{"date_of_loss":"2026-11-10"}')$$,
    'owner saves a DD/MM/YYYY date');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), '2026-11-15'::date, 'incident date follows the saved value');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000001', '{"date_of_loss":"1-2-2026 10:00"}', '{"date_of_loss":"15/11/2026"}')$$,
    'owner saves a D-M-YYYY date with time');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), '2026-02-01'::date, 'day-first with time');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000001', '{"date_of_loss":"last Tuesday"}', '{"date_of_loss":"1-2-2026 10:00"}')$$,
    'an unparseable value is saved (never raises)');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), null::date, 'unparseable value clears the incident date');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000001', '{"date_of_loss":"2026-11-12"}', '{"date_of_loss":"last Tuesday"}')$$,
    'owner saves an ISO date');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), '2026-11-12'::date, 'ISO date set');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000001', '{"date_of_loss":""}', '{"date_of_loss":"2026-11-12"}')$$,
    'owner clears the date');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), null::date, 'empty value clears the incident date');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000002', '{"loss_datetime":"2026-10-06T08:15:00+05:30"}', '{"loss_datetime":"2026-10-05 21:30"}')$$,
    'owner saves an ISO datetime with T');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000002'), '2026-10-06'::date, 'datetime with T gives the date part');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000002', '{"loss_datetime":"31/02/2026 10:00"}', '{"loss_datetime":"2026-10-06T08:15:00+05:30"}')$$,
    'an impossible date is saved');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000002'), null::date, 'impossible date clears the incident date');
select lives_ok($$select public.save_case_field_values('35200000-0000-4000-8000-000000000002', '{"loss_datetime":"05-10-2026 21:30"}', '{"loss_datetime":"31/02/2026 10:00"}')$$,
    'owner saves DD-MM-YYYY HH:MM');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000002'), '2026-10-05'::date, 'DD-MM-YYYY HH:MM gives the date');

-- create_case_direct and intake write field values through the same trigger
create temp table t_new on commit drop as
    select r.case_id from public.create_case_direct(pg_temp.tpl('WKA'), '{"insurer_claim_no":"WKA-9","date_of_loss":"03/09/2026"}') r;
select is((select pg_temp.idate(case_id) from t_new), '2026-09-03'::date, 'create_case_direct sets the incident date');
reset role;
create temp table t_intake on commit drop as
    select r.case_id from private.create_case_from_intake(null, pg_temp.tpl('WKB'), 'WKB-9',
        '{"insurer_claim_no":{"value":"WKB-9"},"loss_datetime":{"value":"2026-08-07T10:00"}}', now(), 'email_parser') r;
select is((select pg_temp.idate(case_id) from t_intake), '2026-08-07'::date,
          'intake (create_case_from_intake) sets the incident date');

-- =====================================================================
-- A3. Mirror guard
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$update public.cases set incident_date = '2026-01-01' where id = '35200000-0000-4000-8000-000000000001'$$,
    '42501', 'Change the date of loss in the report workspace', 'incident date cannot be changed directly (date_of_loss template)');
select throws_ok($$update public.cases set incident_date = '2026-01-01' where id = '35200000-0000-4000-8000-000000000002'$$,
    '42501', 'Change the date of loss in the report workspace', 'nor on a loss_datetime template');
select lives_ok($$update public.cases set incident_date = '2026-01-01' where id = '35200000-0000-4000-8000-000000000003'$$,
    'a template without a loss-date field keeps the column editable');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000003'), '2026-01-01'::date, 'direct value stored');
select lives_ok($$update public.cases set suspicion_summary = 'Check the garage' where id = '35200000-0000-4000-8000-000000000001'$$,
    'other case columns still update');

-- =====================================================================
-- A4. Backfill
-- =====================================================================
reset role;
update public.cases set incident_date = '2000-01-01' where id = '35200000-0000-4000-8000-000000000002';
update public.cases set incident_date = '2000-01-01' where id = '35200000-0000-4000-8000-000000000001';
update public.case_field_values v set value = '07/07/2026'
  from public.case_template_fields f
 where f.id = v.field_id and f.key = 'date_of_loss' and v.case_id = '35200000-0000-4000-8000-000000000001';
update public.cases set incident_date = '2000-01-01' where id = '35200000-0000-4000-8000-000000000001';
select ok(private.sync_incident_dates() >= 2, 'backfill corrects the drifted cases');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000001'), '2026-07-07'::date, 'K1 backfilled from date_of_loss');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000002'), '2026-10-05'::date, 'K2 backfilled from loss_datetime');
select is(pg_temp.idate('35200000-0000-4000-8000-000000000003'), '2026-01-01'::date, 'a case without a loss-date field is left alone');
select is(private.sync_incident_dates(), 0, 'a second run changes nothing');

-- =====================================================================
-- B. Approval events (staff-only)
-- =====================================================================
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin) values
 ('35400000-0000-4000-8000-000000000041', '35200000-0000-4000-8000-000000000004', 1, 'cases/wk4/report-v1.pdf', '35000000-0000-4000-8000-0000000000b1', 'generated'),
 ('35400000-0000-4000-8000-000000000051', '35200000-0000-4000-8000-000000000005', 1, 'cases/wk5/report-v1.pdf', '35000000-0000-4000-8000-0000000000b1', 'generated');

-- one-step approval: only its own message (and the flag does not leak into later requests)
set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select public.approve_own_report('35400000-0000-4000-8000-000000000051')$$, 'orchestrator approves in one step');
reset role;
select is((select count(*)::int from public.case_messages where case_id = '35200000-0000-4000-8000-000000000005'
            and kind = 'system' and visibility = 'staff' and body = 'Report version 1 approved by W Orch'), 1,
    'one-step approval: one staff-only "Report version 1 approved by W Orch"');
select is((select count(*)::int from public.case_messages where case_id = '35200000-0000-4000-8000-000000000005'
            and (body like 'Approval requested by%' or body like 'Report approved by%')), 0,
    'one-step approval does not also post the request / decision messages');
select is(current_setting('app.self_approval', true), 'off', 'self-approval flag switched off afterwards');

-- office request
set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into public.report_approvals (case_id, report_id)
                  values ('35200000-0000-4000-8000-000000000004', '35400000-0000-4000-8000-000000000041')$$,
    'office owner requests approval');
select is((select visibility from public.case_messages where case_id = '35200000-0000-4000-8000-000000000004'
            and kind = 'system' and body = 'Approval requested by W Office for report version 1'),
    'staff', 'request posts a staff-only "Approval requested by W Office for report version 1"');

-- changes requested
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$update public.report_approvals set decision = 'changes_requested', comments = 'Fix the odometer'
                   where report_id = '35400000-0000-4000-8000-000000000041'$$, 'orchestrator requests changes');
select is((select visibility from public.case_messages where case_id = '35200000-0000-4000-8000-000000000004'
            and kind = 'system' and body = 'Changes requested by W Orch: Fix the odometer'),
    'staff', 'staff-only "Changes requested by W Orch: Fix the odometer"');

-- version 2, approved
reset role;
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin) values
 ('35400000-0000-4000-8000-000000000042', '35200000-0000-4000-8000-000000000004', 2, 'cases/wk4/report-v2.pdf', '35000000-0000-4000-8000-0000000000b1', 'generated');
set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into public.report_approvals (case_id, report_id)
                  values ('35200000-0000-4000-8000-000000000004', '35400000-0000-4000-8000-000000000042')$$,
    'office owner requests approval of version 2');
select is((select visibility from public.case_messages where case_id = '35200000-0000-4000-8000-000000000004'
            and kind = 'system' and body = 'Approval requested by W Office for report version 2'),
    'staff', 'second request names version 2');
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$update public.report_approvals set decision = 'approved'
                   where report_id = '35400000-0000-4000-8000-000000000042'$$, 'orchestrator approves');
select is((select visibility from public.case_messages where case_id = '35200000-0000-4000-8000-000000000004'
            and kind = 'system' and body = 'Report approved by W Orch'),
    'staff', 'staff-only "Report approved by W Orch"');
reset role;
select is((select count(*)::int from public.case_messages where case_id = '35200000-0000-4000-8000-000000000004'
            and (body like 'Approval requested by%' or body like 'Report approved by%' or body like 'Changes requested by%')
            and visibility <> 'staff'), 0, 'no approval event is visible to field users');

-- =====================================================================
-- C. complete_field_task: note when required checklist items are missing
-- =====================================================================
insert into public.tasks (id, case_id, title, assignee_id, status) values
 ('35300000-0000-4000-8000-000000000001', '35200000-0000-4000-8000-000000000006', 'Garage visit', '35000000-0000-4000-8000-0000000000f1', 'pending'),
 ('35300000-0000-4000-8000-000000000002', '35200000-0000-4000-8000-000000000006', 'Spot visit',   '35000000-0000-4000-8000-0000000000f1', 'pending'),
 ('35300000-0000-4000-8000-000000000003', '35200000-0000-4000-8000-000000000006', 'RC check',     '35000000-0000-4000-8000-0000000000f1', 'pending'),
 ('35300000-0000-4000-8000-000000000004', '35200000-0000-4000-8000-000000000006', 'DL check',     '35000000-0000-4000-8000-0000000000f1', 'pending');
insert into public.task_checklist_items (task_id, position, description, is_mandatory, status) values
 ('35300000-0000-4000-8000-000000000001', 1, 'Front photo', true,  'pending'),
 ('35300000-0000-4000-8000-000000000001', 2, 'Rear photo',  true,  'captured'),
 ('35300000-0000-4000-8000-000000000001', 3, 'Extra',       false, 'pending'),
 ('35300000-0000-4000-8000-000000000002', 1, 'Spot photo',  true,  'captured'),
 ('35300000-0000-4000-8000-000000000002', 2, 'Witness',     true,  'waived'),
 ('35300000-0000-4000-8000-000000000002', 3, 'Extra',       false, 'pending'),
 ('35300000-0000-4000-8000-000000000004', 1, 'DL front',    true,  'pending'),
 ('35300000-0000-4000-8000-000000000004', 2, 'DL back',     true,  'pending');

set local role authenticated;
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$select public.complete_field_task('35300000-0000-4000-8000-000000000001')$$,
    'operator completes T1 with a required item missing (not blocked)');
select lives_ok($$select public.complete_field_task('35300000-0000-4000-8000-000000000002')$$,
    'operator completes T2 with every required item done');
select lives_ok($$select public.complete_field_task('35300000-0000-4000-8000-000000000003')$$,
    'operator completes T3 (no checklist)');
set local request.jwt.claims to '{"sub":"35000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.complete_field_task('35300000-0000-4000-8000-000000000004')$$,
    'office completes T4 with no required item collected');
reset role;
select is((select status::text from public.tasks where id = '35300000-0000-4000-8000-000000000001'), 'completed', 'T1 completed');
select is((select visibility from public.case_messages where task_id = '35300000-0000-4000-8000-000000000001'
            and kind = 'system' and body = 'Task completed by W Field with 1 of 2 required checklist items collected'),
    'staff', 'T1: staff-only note "1 of 2 required checklist items collected"');
select is((select count(*)::int from public.case_messages where task_id = '35300000-0000-4000-8000-000000000002'
            and body like 'Task completed by%'), 0, 'T2: no note when every required item is done (captured / waived)');
select is((select count(*)::int from public.case_messages where task_id = '35300000-0000-4000-8000-000000000003'
            and body like 'Task completed by%'), 0, 'T3: no note without a checklist');
select is((select visibility from public.case_messages where task_id = '35300000-0000-4000-8000-000000000004'
            and kind = 'system' and body = 'Task completed by W Office with 0 of 2 required checklist items collected'),
    'staff', 'T4: note names the office user who completed it');

select * from finish();
rollback;
