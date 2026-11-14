-- Field task lifecycle RPCs and hardening (20261115600000_field_task_rpcs.sql):
-- create_field_task() checks, cancel_field_task(), reassign_field_task() (D43 late-upload window kept),
-- update_field_task(), reassign_case() checks; D44 case ownership. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(95);

-- ---------------------------------------------------------------------
-- Fixture (prefix a7/b7/c7...): a1 admin, c1 orchestrator, b1 office (owns the cases), b2 office (owns none),
-- f1/f2 field, f3 field (inactive). Insurer FTR with a motor template.
--   C1 assigned, template with checklist CL1 (in use, default) and CL3 (out of use) linked
--   C2 closed;  C3 assigned, no template;  C4 submitted
--   CL2 motor all insurers (in use, not linked);  CL4 health (in use)
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000a1','authenticated','authenticated','t-admin@example.com',null,'{"role":"admin","full_name":"T Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000c1','authenticated','authenticated','t-orch@example.com',null,'{"role":"orchestrator","full_name":"T Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000b1','authenticated','authenticated','t-off1@example.com',null,'{"role":"office","full_name":"T Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000b2','authenticated','authenticated','t-off2@example.com',null,'{"role":"office","full_name":"T Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919840000001','{"role":"field","full_name":"Ravi Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919840000002','{"role":"field","full_name":"Mohan Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a7000000-0000-4000-8000-0000000000f3','authenticated','authenticated',null,'919840000003','{"role":"field","full_name":"Dev Field"}','{}');
update public.profiles set is_active = false where id = 'a7000000-0000-4000-8000-0000000000f3';

insert into public.insurers (id, name, code, tat_days) values ('b7000000-0000-4000-8000-000000000001', 'Task Insurer', 'FTR', 10);
select public.load_case_template('{"insurer_code":"FTR","claim_type":"motor","variant":"od","name":"FTR OD","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[{"key":"insurer_claim_no","label":"Claim","source":"intake","required":true}]}]}');

insert into public.checklist_templates (id, name, claim_type, insurer_id, is_active) values
 ('c7100000-0000-4000-8000-000000000001', 'FTR motor standard', 'motor', 'b7000000-0000-4000-8000-000000000001', true),
 ('c7100000-0000-4000-8000-000000000002', 'Motor generic',      'motor', null, true),
 ('c7100000-0000-4000-8000-000000000003', 'FTR motor old',      'motor', 'b7000000-0000-4000-8000-000000000001', false),
 ('c7100000-0000-4000-8000-000000000004', 'Health generic',     'health', null, true);
insert into public.checklist_template_items (template_id, position, description) values
 ('c7100000-0000-4000-8000-000000000001', 1, 'Vehicle photos'),
 ('c7100000-0000-4000-8000-000000000002', 1, 'RC book');
insert into public.case_template_checklists (template_id, checklist_template_id, is_default)
select t.id, x.cl, x.d from public.case_templates t join public.insurers i on i.id = t.insurer_id,
  (values ('c7100000-0000-4000-8000-000000000001'::uuid, true), ('c7100000-0000-4000-8000-000000000003'::uuid, false)) x (cl, d)
 where i.code = 'FTR' and t.is_active;

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select '37a00000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'FTR-1', 'motor', t.id,
       'a7000000-0000-4000-8000-0000000000b1', 'assigned'
  from public.case_templates t join public.insurers i on i.id = t.insurer_id where i.code = 'FTR' and t.is_active;
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, office_owner_id, status) values
 ('37a00000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000001', 'FTR-2', 'motor', 'a7000000-0000-4000-8000-0000000000b1', 'closed'),
 ('37a00000-0000-4000-8000-000000000003', 'b7000000-0000-4000-8000-000000000001', 'FTR-3', 'motor', 'a7000000-0000-4000-8000-0000000000b1', 'assigned'),
 ('37a00000-0000-4000-8000-000000000004', 'b7000000-0000-4000-8000-000000000001', 'FTR-4', 'motor', 'a7000000-0000-4000-8000-0000000000b1', 'submitted');
-- an open task left on the closed case (for the reassignment check)
insert into public.tasks (id, case_id, title, assignee_id) values
 ('47a00000-0000-4000-8000-000000000002', '37a00000-0000-4000-8000-000000000002', 'Late visit', 'a7000000-0000-4000-8000-0000000000f1');

create function pg_temp.tid(p text) returns uuid language sql stable as $$ select id from public.tasks where title = p $$;

-- =====================================================================
-- B. create_field_task hardening
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Garage visit')$$,
    '42501', null::text, 'office cannot assign field work on a case owned by someone else');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Garage visit')$$,
    '42501', null::text, 'field cannot assign field work');

set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1',
                  'Garage visit', 'Check damage', 'c7100000-0000-4000-8000-000000000001', 'initial', null, 'Pune', null,
                  'Insurer asked for a garage visit')$$,
    'owner assigns field work with a linked checklist and a reason');
select is((select reason from public.tasks where id = pg_temp.tid('Garage visit')), 'Insurer asked for a garage visit', 'reason stored on the task');
select is((select count(*)::int from public.task_checklist_items where task_id = pg_temp.tid('Garage visit')), 1, 'checklist items copied');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-0000000000f1', 'Closed visit')$$,
    '22023', null::text, 'closed case takes no new field work');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Other checklist',
                  null, 'c7100000-0000-4000-8000-000000000002')$$,
    '22023', null::text, 'checklist not linked to the case template is refused');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Old checklist',
                  null, 'c7100000-0000-4000-8000-000000000003')$$,
    '22023', null::text, 'linked checklist that is out of use is refused');
select lives_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-0000000000f1', 'Spot visit',
                  null, 'c7100000-0000-4000-8000-000000000002')$$,
    'case without a template: in-use checklist of its claim type is accepted');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-0000000000f1', 'Health list',
                  null, 'c7100000-0000-4000-8000-000000000004')$$,
    '22023', null::text, 'case without a template: checklist of another claim type is refused');
select throws_ok(format($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Wrong parent',
                  'Recheck the garage please', null, 're_investigation', null, null, %L)$$, pg_temp.tid('Spot visit')),
    '22023', null::text, 'parent task of another case is refused');
select lives_ok(format($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Re-check',
                  'Photograph the chassis number', null, 're_investigation', null, null, %L)$$, pg_temp.tid('Garage visit')),
    'parent task of the same case is accepted');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Short reason',
                  null, null, 'other', null, null, null, 'x')$$,
    '22023', null::text, 'reason shorter than 3 characters is refused');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'Long reason',
                  null, null, 'other', null, null, null, repeat('r', 501))$$,
    '22023', null::text, 'reason longer than 500 characters is refused');

set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f2', 'Orch task')$$,
    'orchestrator assigns field work on any case (old three-argument call still works)');
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-0000000000ff', 'a7000000-0000-4000-8000-0000000000f2', 'No case')$$,
    'P0002', null::text, 'unknown case');

-- =====================================================================
-- A1. cancel_field_task
-- =====================================================================
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok(format($$select public.cancel_field_task(%L, 'Not needed any more')$$, pg_temp.tid('Spot visit')),
    '42501', null::text, 'office non-owner cannot cancel');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok(format($$select public.cancel_field_task(%L, 'Not needed any more')$$, pg_temp.tid('Spot visit')),
    '42501', null::text, 'field cannot cancel');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok(format($$select public.cancel_field_task(%L, 'no')$$, pg_temp.tid('Spot visit')),
    '22023', null::text, 'cancel needs a reason of 3+ characters');
select throws_ok(format($$select public.cancel_field_task(%L, %L)$$, pg_temp.tid('Spot visit'), repeat('r', 501)),
    '22023', null::text, 'cancel reason at most 500 characters');
select throws_ok($$select public.cancel_field_task('47a00000-0000-4000-8000-0000000000ff', 'Not needed any more')$$,
    'P0002', null::text, 'unknown task');
select lives_ok(format($$select public.cancel_field_task(%L, 'Insured withdrew the claim')$$, pg_temp.tid('Spot visit')),
    'owner cancels a task');
select is((select status::text from public.tasks where id = pg_temp.tid('Spot visit')), 'cancelled', 'task is cancelled');
select is((select status::text from public.cases where id = '37a00000-0000-4000-8000-000000000003'), 'office_review',
          'case with no field work left moves to office review');
select is((select visibility from public.case_messages where task_id = pg_temp.tid('Spot visit') and body = 'Field work cancelled: Spot visit'),
          'all', 'cancellation posted to the thread for everyone');
select is((select visibility from public.case_messages where task_id = pg_temp.tid('Spot visit') and body like 'Reason for cancelling%Insured withdrew%'),
          'staff', 'cancellation reason posted as a staff-only message');
select throws_ok(format($$select public.cancel_field_task(%L, 'Cancel it again')$$, pg_temp.tid('Spot visit')),
    '22023', null::text, 'cancelled task cannot be cancelled again');

set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok(format($$select public.cancel_field_task(%L, 'Duplicate of the garage visit')$$, pg_temp.tid('Orch task')),
    'orchestrator cancels a task on a case it does not own');
reset role;
select is((select count(*)::int from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000f1' and kind = 'task_cancelled'
            and dedupe_key = 'task_cancelled:' || pg_temp.tid('Spot visit')), 1, 'operator notified of the cancellation');
select is((select count(*)::int from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000b1' and kind = 'task_cancelled'), 1,
          'case owner notified only when someone else cancelled');
select is((select new_data->>'reason' from public.audit_log where action = 'TASK_CANCELLED' and record_id = pg_temp.tid('Spot visit')),
          'Insured withdrew the claim', 'cancellation audited with the reason');
select is((select actor_id from public.audit_log where action = 'TASK_CANCELLED' and record_id = pg_temp.tid('Spot visit')),
          'a7000000-0000-4000-8000-0000000000b1'::uuid, 'audit row names the actor');
select ok((select held_until is not null from public.task_holds where task_id = pg_temp.tid('Spot visit')), 'cancellation ends the hold');

-- =====================================================================
-- A2. reassign_field_task
-- =====================================================================
update public.tasks set status = 'in_progress' where id = pg_temp.tid('Garage visit');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    '42501', null::text, 'office non-owner cannot reassign a task');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    '42501', null::text, 'field cannot reassign a task');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f3', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'cannot reassign to an inactive operator');
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000b2', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'cannot reassign to an office user');
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f1', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'cannot reassign to the current operator');
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'x')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'reassignment needs a reason');
select throws_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'Not open any more')$$, pg_temp.tid('Spot visit')),
    '22023', null::text, 'cancelled task cannot be reassigned');
select throws_ok($$select public.reassign_field_task('47a00000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-0000000000f2', 'Ravi is on leave')$$,
    '22023', null::text, 'task on a closed case cannot be reassigned');
select lives_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'Ravi is on leave')$$, pg_temp.tid('Garage visit')),
    'owner reassigns the operator');
select is((select assignee_id::text || '/' || status::text || '/' || coalesce(started_at::text, 'none') from public.tasks where id = pg_temp.tid('Garage visit')),
          'a7000000-0000-4000-8000-0000000000f2/pending/none', 'new operator starts the task afresh');
select is((select status::text from public.cases where id = '37a00000-0000-4000-8000-000000000001'), 'field_in_progress', 'case stays in the field');
select is((select visibility from public.case_messages where task_id = pg_temp.tid('Garage visit')
            and body = 'Field work reassigned from Ravi Field to Mohan Field: Garage visit'), 'all', 'reassignment posted to the thread');
select is((select visibility from public.case_messages where task_id = pg_temp.tid('Garage visit') and body like 'Reason for reassigning%on leave'),
          'staff', 'reassignment reason posted as a staff-only message');

set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.tasks where id = pg_temp.tid('Garage visit')), 1, 'new operator sees the task');
select is((select count(*)::int from public.case_messages where body like 'Reason for%'), 0, 'new operator does not see reasons');

reset role;
select is((select held_until from public.task_holds where task_id = pg_temp.tid('Garage visit') and profile_id = 'a7000000-0000-4000-8000-0000000000f1'),
          now(), 'old operator''s hold ends at server time');
select is((select count(*)::int from public.task_holds where task_id = pg_temp.tid('Garage visit') and held_until is null
            and profile_id = 'a7000000-0000-4000-8000-0000000000f2'), 1, 'new operator holds the task');
select ok(private.field_upload_allowed(pg_temp.tid('Garage visit'), 'a7000000-0000-4000-8000-0000000000f1', now()),
          'old operator keeps the late-upload window for files captured while holding the task (D43)');
select is((select kind from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000f2'
            and dedupe_key = 'task:' || pg_temp.tid('Garage visit')), 'task_assigned', 'new operator notified');
select is((select count(*)::int from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000f1' and kind = 'task_unassigned'), 1,
          'old operator notified');
select is((select new_data->>'assignee_id' from public.audit_log where action = 'TASK_REASSIGNED' and record_id = pg_temp.tid('Garage visit')),
          'a7000000-0000-4000-8000-0000000000f2', 'reassignment audited');
select is((select count(*)::int from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000b1' and kind = 'task_reassigned'), 0,
          'owner not notified of their own reassignment');

set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok(format($$select public.reassign_field_task(%L, 'a7000000-0000-4000-8000-0000000000f2', 'Mohan is nearer')$$, pg_temp.tid('Re-check')),
    'orchestrator reassigns a task on a case it does not own');
reset role;
select is((select kind from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000f2'
            and dedupe_key = 'task:' || pg_temp.tid('Re-check')), 'field_request', 'reassigned re-investigation arrives as a request');
select is((select count(*)::int from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000b1' and kind = 'task_reassigned'), 1,
          'owner notified when someone else reassigned');

-- =====================================================================
-- A3. update_field_task ('Garage visit': instructions 'Check damage', location 'Pune', no due)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage', null, 'Nashik')$$, pg_temp.tid('Garage visit')),
    '42501', null::text, 'office non-owner cannot edit a task');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage', null, 'Nashik')$$, pg_temp.tid('Garage visit')),
    '42501', null::text, 'field cannot edit a task through the function');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok(format($$select public.update_field_task(%L, 'ab')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'title of 3-120 characters');
select throws_ok(format($$select public.update_field_task(%L, %L)$$, pg_temp.tid('Garage visit'), repeat('t', 121)),
    '22023', null::text, 'title longer than 120 characters refused');
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', %L)$$, pg_temp.tid('Garage visit'), repeat('i', 4001)),
    '22023', null::text, 'instructions at most 4000 characters');
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage', null, %L)$$, pg_temp.tid('Garage visit'), repeat('l', 301)),
    '22023', null::text, 'location at most 300 characters');
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage', now() - interval '1 hour', 'Pune')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'new due time must be in the future');
select throws_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage', now() + interval '400 days', 'Pune')$$, pg_temp.tid('Garage visit')),
    '22023', null::text, 'new due time within a year');
select is(public.update_field_task(pg_temp.tid('Garage visit'), 'Garage visit', ' Check damage ', null, 'Pune'), false,
          'nothing changed: returns false');
select is((select count(*)::int from public.case_messages where task_id = pg_temp.tid('Garage visit') and body like 'Field work updated%'), 0,
          'no message when nothing changed');
select is(public.update_field_task(pg_temp.tid('Garage visit'), 'Garage visit', 'Check damage', now() + interval '2 days', ''), true,
          'owner changes due time and clears location');
select is((select (due_at = now() + interval '2 days')::text || '/' || coalesce(location_text, 'none') from public.tasks where id = pg_temp.tid('Garage visit')),
          'true/none', 'changes applied');
select is((select visibility from public.case_messages where task_id = pg_temp.tid('Garage visit')
            and body = 'Field work updated (due time, location): Garage visit'), 'all', 'edit posted to the thread with what changed');
select throws_ok(format($$select public.update_field_task(%L, 'Re-check', '  ')$$, pg_temp.tid('Re-check')),
    '22023', null::text, 're-investigation request cannot be cleared');
select throws_ok(format($$select public.update_field_task(%L, 'Spot visit again')$$, pg_temp.tid('Spot visit')),
    '22023', null::text, 'cancelled task cannot be edited');

reset role;
update public.tasks set due_at = now() - interval '1 day' where id = pg_temp.tid('Re-check');
set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is(public.update_field_task(pg_temp.tid('Re-check'), 'Re-check chassis', 'Photograph the chassis number',
                                   (select due_at from public.tasks where id = pg_temp.tid('Re-check'))), true,
          'orchestrator edits; an unchanged past due time is kept');
reset role;
select ok(exists (select 1 from public.notifications where user_id = 'a7000000-0000-4000-8000-0000000000f2' and kind = 'task_updated'
                  and dedupe_key = 'task_updated:' || pg_temp.tid('Garage visit')), 'operator notified of the edit');
select is((select new_data->'changed' from public.audit_log where action = 'TASK_UPDATED' and record_id = pg_temp.tid('Garage visit')),
          '["due time", "location"]'::jsonb, 'edit audited with the changed fields');
select is((select title from public.tasks where id = pg_temp.tid('Re-check chassis')), 'Re-check chassis', 'title changed');

-- =====================================================================
-- C. reassign_case hardening
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000b2', 'Balance the load')$$,
    '42501', null::text, 'office cannot reassign a case, even its own');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000b1', 'Balance the load')$$,
    '22023', null::text, 'cannot reassign a case to its current owner');
select throws_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-0000000000b2', 'Balance the load')$$,
    '22023', null::text, 'submitted case cannot be reassigned');
select throws_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-0000000000b2', 'Balance the load')$$,
    '22023', null::text, 'closed case cannot be reassigned');
select throws_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000b2', repeat('r', 501))$$,
    '22023', null::text, 'case reassignment reason at most 500 characters');
select lives_ok($$select public.reassign_case('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000b2', 'Balance the load')$$,
    'orchestrator reassigns the case');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('37a00000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-0000000000f1', 'After handover')$$,
    '42501', null::text, 'former owner can no longer assign field work on the case');
select throws_ok(format($$select public.cancel_field_task(%L, 'Not mine any more')$$, pg_temp.tid('Garage visit')),
    '42501', null::text, 'former owner can no longer cancel its tasks');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select lives_ok(format($$select public.update_field_task(%L, 'Garage visit', 'Check damage and the job card', now() + interval '2 days')$$, pg_temp.tid('Garage visit')),
    'new owner edits the task');
set local request.jwt.claims to '{"sub":"a7000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok(format($$select public.cancel_field_task(%L, 'Admin closes the visit')$$, pg_temp.tid('Garage visit')),
    'admin cancels a task on any case');
reset role;

-- =====================================================================
-- Grants
-- =====================================================================
select ok(not has_function_privilege('anon', 'public.cancel_field_task(uuid, text)', 'execute'), 'anon cannot cancel tasks');
select ok(not has_function_privilege('anon', 'public.reassign_field_task(uuid, uuid, text)', 'execute'), 'anon cannot reassign tasks');
select ok(not has_function_privilege('anon', 'public.update_field_task(uuid, text, text, timestamptz, text)', 'execute'), 'anon cannot edit tasks');
select ok(not has_function_privilege('anon',
    'public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid, text)', 'execute'), 'anon cannot create tasks');
select ok(has_function_privilege('authenticated', 'public.reassign_field_task(uuid, uuid, text)', 'execute'), 'authenticated can call the RPCs');
select ok(not has_function_privilege('authenticated', 'private.lock_manageable_task(uuid)', 'execute'), 'helpers are not callable by clients');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'create_field_task'), 1, 'one create_field_task (no ambiguous overload)');
select ok(exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'private' and p.proname = 'can_manage_case' and p.prosecdef), 'can_manage_case exists (D44)');

select * from finish();
rollback;
