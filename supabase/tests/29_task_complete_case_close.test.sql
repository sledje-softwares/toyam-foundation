-- Completing field work and closing a case (20261119100000_task_complete_case_close.sql):
-- complete_field_task() for the assigned operator and for staff who manage the case (D44), the case
-- moving to office review through tasks_after_change, the D43 late-upload window after completion,
-- no direct field completion; close_case() from submitted with an acknowledgement (orchestrator /
-- admin may close without one, with a reason), no direct close / un-close, reopen_case unchanged.
-- Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(75);

-- ---------------------------------------------------------------------
-- Fixture (prefix 29...): a1 admin, c1 orchestrator, b1 office (owns every case), b2 office (owns none),
-- f1 / f2 field, f3 field (inactive). Insurer CCL, no template (no approval needed to submit).
--   K1 field work: T1 (f1, pending), T2 (f2, in progress)
--   K2 submitted (acknowledged) with a left-over open task T3 (f1)
--   K3 closed with a left-over open task T4 (f1)
--   K4 assigned: T6 (f1, pending; completed straight from pending)
--   K5 submitted, acknowledged      K6 submitted, not acknowledged
--   K7 office review                K8 submitted twice: older acknowledged, latest not
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000a1','authenticated','authenticated','cc-admin@example.com',null,'{"role":"admin","full_name":"CC Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000c1','authenticated','authenticated','cc-orch@example.com',null,'{"role":"orchestrator","full_name":"CC Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000b1','authenticated','authenticated','cc-off1@example.com',null,'{"role":"office","full_name":"CC Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000b2','authenticated','authenticated','cc-off2@example.com',null,'{"role":"office","full_name":"CC Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919860000291','{"role":"field","full_name":"Ravi Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919860000292','{"role":"field","full_name":"Mohan Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000f3','authenticated','authenticated',null,'919860000293','{"role":"field","full_name":"Dev Field"}','{}');
update public.profiles set is_active = false where id = '29000000-0000-4000-8000-0000000000f3';

insert into public.insurers (id, name, code, tat_days) values ('29100000-0000-4000-8000-000000000001', 'Close Insurer', 'CCL', 10);

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, office_owner_id, status)
select v.id::uuid, '29100000-0000-4000-8000-000000000001', v.claim, 'motor', '29000000-0000-4000-8000-0000000000b1', v.st::public.case_status
  from (values ('29200000-0000-4000-8000-000000000001', 'CCL-1', 'assigned'),
               ('29200000-0000-4000-8000-000000000002', 'CCL-2', 'office_review'),
               ('29200000-0000-4000-8000-000000000003', 'CCL-3', 'closed'),
               ('29200000-0000-4000-8000-000000000004', 'CCL-4', 'assigned'),
               ('29200000-0000-4000-8000-000000000005', 'CCL-5', 'office_review'),
               ('29200000-0000-4000-8000-000000000006', 'CCL-6', 'office_review'),
               ('29200000-0000-4000-8000-000000000007', 'CCL-7', 'office_review'),
               ('29200000-0000-4000-8000-000000000008', 'CCL-8', 'office_review')) v(id, claim, st);

insert into public.tasks (id, case_id, title, assignee_id, status) values
 ('29300000-0000-4000-8000-000000000001', '29200000-0000-4000-8000-000000000001', 'Garage visit', '29000000-0000-4000-8000-0000000000f1', 'pending'),
 ('29300000-0000-4000-8000-000000000002', '29200000-0000-4000-8000-000000000001', 'Spot visit',   '29000000-0000-4000-8000-0000000000f2', 'in_progress'),
 ('29300000-0000-4000-8000-000000000004', '29200000-0000-4000-8000-000000000003', 'Late visit',   '29000000-0000-4000-8000-0000000000f1', 'pending'),
 ('29300000-0000-4000-8000-000000000006', '29200000-0000-4000-8000-000000000004', 'RC check',     '29000000-0000-4000-8000-0000000000f1', 'pending');
-- T1's hold started an hour ago (so a file captured half an hour ago lies within it)
update public.task_holds set held_from = now() - interval '1 hour' where task_id = '29300000-0000-4000-8000-000000000001';

-- reports and submissions (submissions_after_insert moves the cases to submitted)
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin)
select ('29400000-0000-4000-8000-00000000000' || n)::uuid, ('29200000-0000-4000-8000-00000000000' || n)::uuid, 1,
       'cases/ccl-' || n || '/report-v1.pdf', '29000000-0000-4000-8000-0000000000b1', 'uploaded'
  from unnest(array[2, 5, 6, 8]) n;
insert into public.submissions (id, case_id, report_id, channel, submitted_at, submitted_by, notes, formats, acknowledged_at)
values
 ('29500000-0000-4000-8000-000000000002', '29200000-0000-4000-8000-000000000002', '29400000-0000-4000-8000-000000000002', 'other', now() - interval '3 days', '29000000-0000-4000-8000-0000000000b1', 'By hand', '{pdf}', now() - interval '1 day'),
 ('29500000-0000-4000-8000-000000000005', '29200000-0000-4000-8000-000000000005', '29400000-0000-4000-8000-000000000005', 'other', now() - interval '3 days', '29000000-0000-4000-8000-0000000000b1', 'By hand', '{pdf}', now() - interval '1 day'),
 ('29500000-0000-4000-8000-000000000006', '29200000-0000-4000-8000-000000000006', '29400000-0000-4000-8000-000000000006', 'other', now() - interval '3 days', '29000000-0000-4000-8000-0000000000b1', 'By hand', '{pdf}', null),
 ('29500000-0000-4000-8000-000000000081', '29200000-0000-4000-8000-000000000008', '29400000-0000-4000-8000-000000000008', 'other', now() - interval '5 days', '29000000-0000-4000-8000-0000000000b1', 'By hand', '{pdf}', now() - interval '4 days');
-- K8 sent again later (after a reopen), not acknowledged yet
update public.cases set status = 'office_review' where id = '29200000-0000-4000-8000-000000000008';
insert into public.submissions (id, case_id, report_id, channel, submitted_at, submitted_by, notes, formats)
values ('29500000-0000-4000-8000-000000000082', '29200000-0000-4000-8000-000000000008', '29400000-0000-4000-8000-000000000008', 'other', now() - interval '1 day', '29000000-0000-4000-8000-0000000000b1', 'Again', '{pdf}');
-- a left-over open task on the submitted K2 (as before D46)
insert into public.tasks (id, case_id, title, assignee_id) values
 ('29300000-0000-4000-8000-000000000003', '29200000-0000-4000-8000-000000000002', 'Old visit', '29000000-0000-4000-8000-0000000000f1');

select results_eq($$select status::text from public.cases where insurer_claim_no in ('CCL-1', 'CCL-2', 'CCL-5', 'CCL-6', 'CCL-8') order by insurer_claim_no$$,
    $$values ('field_in_progress'), ('submitted'), ('submitted'), ('submitted'), ('submitted')$$, 'fixture: case statuses');
select has_function('public', 'complete_field_task', array['uuid', 'text'], 'complete_field_task exists');
select has_function('public', 'close_case', array['uuid', 'text'], 'close_case exists');

-- =====================================================================
-- A. complete_field_task: who may call it
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001')$$,
    '42501', 'You can mark only your own field work complete', 'an operator cannot complete another operator''s task');
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f3","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001')$$,
    '42501', null::text, 'an inactive user cannot');
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001')$$,
    '42501', 'You can change field tasks only on your own cases', 'office staff cannot complete tasks on cases they do not own (D44)');
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-0000000000ff')$$,
    'P0002', 'Task not found', 'unknown task');

-- C. no direct completion by the operator; starting a task directly still works
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$update public.tasks set status = 'completed' where id = '29300000-0000-4000-8000-000000000001'$$,
    '42501', 'Use "Mark task done" in the app to finish field work', 'the operator cannot complete a task with a direct update');
select lives_ok($$update public.tasks set status = 'in_progress' where id = '29300000-0000-4000-8000-000000000001'$$,
    'the operator can still start the task directly (post_thread_message does this)');
select is((select status::text from public.tasks where id = '29300000-0000-4000-8000-000000000001'), 'in_progress', 'T1 started');
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001', repeat('x', 1001))$$,
    '22023', 'Keep the note under 1000 characters', 'note length checked');

-- =====================================================================
-- A. The operator completes their task
-- =====================================================================
select lives_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001', '  All photos sent  ')$$,
    'the assigned operator marks the task done');
reset role;
select is((select status::text from public.tasks where id = '29300000-0000-4000-8000-000000000001'), 'completed', 'T1 completed');
select ok((select completed_at is not null and completed_at <= now() from public.tasks where id = '29300000-0000-4000-8000-000000000001'),
    'completed_at set by the server');
select is((select status::text from public.cases where id = '29200000-0000-4000-8000-000000000001'), 'field_in_progress',
    'case stays in field work while T2 is open');
select ok((select held_until is not null from public.task_holds where task_id = '29300000-0000-4000-8000-000000000001'),
    'the hold on T1 ended (D43)');
select is((select visibility from public.case_messages
            where task_id = '29300000-0000-4000-8000-000000000001' and body = 'Ravi Field marked field work complete: Garage visit'),
    'all', 'thread event names the operator, visible on the case');
select is((select visibility from public.case_messages
            where task_id = '29300000-0000-4000-8000-000000000001' and body = 'Note from Ravi Field on completing "Garage visit": All photos sent'),
    'all', 'the operator''s note is visible on the case');
select is((select count(*)::int from public.notifications
            where user_id = '29000000-0000-4000-8000-0000000000b1' and kind = 'task_completed'
              and dedupe_key = 'task_done:29300000-0000-4000-8000-000000000001'), 1, 'the case owner is notified');
select is((select new_data->>'by' from public.audit_log
            where action = 'TASK_COMPLETED' and record_id = '29300000-0000-4000-8000-000000000001'), 'operator', 'audited TASK_COMPLETED');
select is((select actor_id from public.audit_log
            where action = 'TASK_COMPLETED' and record_id = '29300000-0000-4000-8000-000000000001'),
    '29000000-0000-4000-8000-0000000000f1'::uuid, 'audit actor is the operator');

set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000001')$$,
    '22023', 'This task is completed and can no longer be changed', 'a completed task cannot be completed again');
-- D43: files captured while holding the task are still accepted after completion
select ok(not public.can_upload_evidence('29300000-0000-4000-8000-000000000001'), 'the open-task upload path is closed');
select ok(public.can_upload_evidence_at('29300000-0000-4000-8000-000000000001', now() - interval '30 minutes'),
    'a file captured while the task was held is still accepted (late-upload window)');
select ok(not public.can_upload_evidence_at('29300000-0000-4000-8000-000000000001', now() - interval '2 hours'),
    'but not one captured before the hold');

-- straight from pending: started_at and completed_at both set; last open task moves the case on
select lives_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000006')$$, 'a pending task can be marked done');
select ok((select started_at is not null and completed_at is not null from public.tasks where id = '29300000-0000-4000-8000-000000000006'),
    'started_at and completed_at set');
select is((select list from public.field_case_list() where case_id = '29200000-0000-4000-8000-000000000004'), 'completed',
    'the case moves to Completed in the operator''s list');
select is((select list from public.field_case_list() where case_id = '29200000-0000-4000-8000-000000000001'), 'completed',
    'K1 is Completed for this operator too (T1 done; T2 is someone else''s)');

-- left-over tasks on submitted / closed cases
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000003')$$,
    '22023', 'This case is no longer open for field work. Ask the office.', 'operator: not on a submitted case');
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000004')$$,
    '22023', 'This case is no longer open for field work. Ask the office.', 'operator: not on a closed case');
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000003')$$,
    '22023', 'This case was submitted, so its field work cannot be marked complete. Cancel left-over work instead',
    'staff: left-over work on a submitted case is cancelled, not completed (D46)');
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000004')$$,
    '22023', 'This case is closed or cancelled, so its field work cannot be marked complete', 'staff: not on a closed case');
reset role;
select is((select status::text from public.cases where id = '29200000-0000-4000-8000-000000000004'), 'office_review',
    'K4: last open task done, case in office review');

-- =====================================================================
-- A. The office completes the operator's task (owner)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000002', 'Operator confirmed by phone')$$,
    'the case owner marks the operator''s task complete');
select is((select status::text from public.cases where id = '29200000-0000-4000-8000-000000000001'), 'office_review',
    'last open task done: case moves to office review (tasks_after_change)');
reset role;
select is((select visibility from public.case_messages
            where task_id = '29300000-0000-4000-8000-000000000002' and body = 'Field work marked complete by the office: Spot visit'),
    'all', 'thread event says the office completed it');
select is((select visibility from public.case_messages
            where task_id = '29300000-0000-4000-8000-000000000002' and body like 'Note on completing "Spot visit" (CC Office 1): Operator confirmed by phone'),
    'staff', 'a staff note is staff-only (D32)');
select is((select count(*)::int from public.notifications
            where user_id = '29000000-0000-4000-8000-0000000000f2' and kind = 'task_completed'), 1, 'the operator is notified');
select is((select count(*)::int from public.notifications
            where user_id = '29000000-0000-4000-8000-0000000000b1' and dedupe_key = 'task_done:29300000-0000-4000-8000-000000000002'), 0,
    'the owner is not notified of their own action');
select is((select new_data->>'by' from public.audit_log
            where action = 'TASK_COMPLETED' and record_id = '29300000-0000-4000-8000-000000000002'), 'office', 'audited as office');
select ok((select held_until is not null from public.task_holds where task_id = '29300000-0000-4000-8000-000000000002'),
    'the operator''s hold ended; the late-upload window applies (D43)');

set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.case_messages where body like 'Note on completing%'), 0,
    'the operator does not see the staff note');
select is((select count(*)::int from public.case_messages where body = 'Field work marked complete by the office: Spot visit'), 1,
    'the operator sees the completion event');
reset role;

-- orchestrator on any case; the owner hears about it
insert into public.tasks (id, case_id, title, assignee_id) values
 ('29300000-0000-4000-8000-000000000005', '29200000-0000-4000-8000-000000000001', 'Extra photos', '29000000-0000-4000-8000-0000000000f1');
set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select public.complete_field_task('29300000-0000-4000-8000-000000000005')$$, 'the orchestrator completes a task on any case');
reset role;
select is((select count(*)::int from public.notifications
            where user_id = '29000000-0000-4000-8000-0000000000b1' and dedupe_key = 'task_done:29300000-0000-4000-8000-000000000005'), 1,
    'the owner is notified when someone else completed the task');
select is((select status::text from public.cases where id = '29200000-0000-4000-8000-000000000001'), 'office_review', 'K1 back in office review');

-- =====================================================================
-- D. close_case
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000005')$$, '42501', null::text, 'field users cannot close cases');
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000005')$$,
    '42501', 'Only the case owner, an orchestrator or an admin can close this case', 'office staff cannot close cases they do not own');

set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000007')$$,
    '55000', 'Only a submitted case can be closed', 'a case in office review cannot be closed');
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000002')$$,
    '55000', 'Field work is still open on this case. Cancel it before closing', 'open field work blocks closing');
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000006')$$,
    '55000', 'Record the insurer''s acknowledgement before closing the case', 'office: acknowledgement first');
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000008')$$,
    '55000', 'Record the insurer''s acknowledgement before closing the case', 'the latest submission must be acknowledged');
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000005', repeat('x', 501))$$,
    '22023', 'Keep the note under 500 characters', 'note length checked');
-- E. no direct close
select throws_ok($$update public.cases set status = 'closed' where id = '29200000-0000-4000-8000-000000000005'$$,
    '42501', 'Close the case from Submissions (close_case)', 'a direct status update to closed is refused');

select lives_ok($$select public.close_case('29200000-0000-4000-8000-000000000005', ' Insurer acknowledged by mail ')$$,
    'the owner closes an acknowledged case');
select is((select status::text from public.cases where id = '29200000-0000-4000-8000-000000000005'), 'closed', 'K5 closed');
select ok((select closed_at is not null from public.cases where id = '29200000-0000-4000-8000-000000000005'), 'closed_at set');
select is((select note from public.case_status_history where case_id = '29200000-0000-4000-8000-000000000005' and to_status = 'closed'),
    'Closed: Insurer acknowledged by mail', 'the note is kept in the status history');
select is((select changed_by from public.case_status_history where case_id = '29200000-0000-4000-8000-000000000005' and to_status = 'closed'),
    '29000000-0000-4000-8000-0000000000b1'::uuid, 'history records who closed it');
select is((select visibility from public.case_messages
            where case_id = '29200000-0000-4000-8000-000000000005' and body = 'Case closed by CC Office 1: Insurer acknowledged by mail'),
    'staff', 'staff-only thread event');
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000005')$$, '55000', 'The case is already closed', 'closed once');
select throws_ok($$select public.reopen_case('29200000-0000-4000-8000-000000000005', 'Insurer asked again')$$,
    '55000', 'Only a submitted case can be reopened', 'a closed case is final: reopen_case still needs submitted (D46)');
select throws_ok($$update public.cases set status = 'office_review' where id = '29200000-0000-4000-8000-000000000005'$$,
    '42501', 'A closed case cannot be reopened', 'nor can a direct update move it out of closed');
select is((select count(*)::int from public.notifications where user_id = '29000000-0000-4000-8000-0000000000b1' and kind = 'case_closed'), 0,
    'the owner is not notified of their own action');

-- orchestrator / admin may close without an acknowledgement, with a reason
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.close_case('29200000-0000-4000-8000-000000000006')$$,
    '22023', 'Say why the case is closed without the insurer''s acknowledgement (3 to 500 characters)', 'a reason is needed without an acknowledgement');
select lives_ok($$select public.close_case('29200000-0000-4000-8000-000000000006', 'Portal shows no acknowledgement; insurer confirmed by phone')$$,
    'the orchestrator closes without an acknowledgement');
select is((select note from public.case_status_history where case_id = '29200000-0000-4000-8000-000000000006' and to_status = 'closed'),
    'Closed without acknowledgement: Portal shows no acknowledgement; insurer confirmed by phone', 'history says no acknowledgement');
reset role;
select is((select count(*)::int from public.notifications where user_id = '29000000-0000-4000-8000-0000000000b1' and kind = 'case_closed'), 1,
    'the owner is notified when someone else closed the case');
select is((select (new_data->>'acknowledged')::boolean from public.audit_log where action = 'CASE_CLOSED' and record_id = '29200000-0000-4000-8000-000000000006'),
    false, 'audited CASE_CLOSED without acknowledgement');
select is((select count(*)::int from public.audit_log where action = 'CASE_CLOSED'), 2, 'one audit row per close');

-- =====================================================================
-- Grants
-- =====================================================================
select ok(not has_function_privilege('anon', 'public.complete_field_task(uuid, text)', 'execute'), 'anon cannot complete tasks');
select ok(not has_function_privilege('anon', 'public.close_case(uuid, text)', 'execute'), 'anon cannot close cases');
select ok(has_function_privilege('authenticated', 'public.complete_field_task(uuid, text)', 'execute'), 'authenticated can complete tasks');
select ok(not has_function_privilege('authenticated', 'private.cases_closed_guard()', 'execute'), 'guard not callable by clients');

select * from finish();
rollback;
