-- Submitted cases and one-step approval (20261115900000_submitted_case_rules.sql):
-- D46 no field work on a submitted case until reopen_case (create_field_task, direct insert,
-- reassign / edit refused; cancel allowed); D47 approve_own_report for orchestrator / admin under the
-- report_approvals_guard rules. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- ---------------------------------------------------------------------
-- Fixture (prefix 1e/2e/3e...): a1 admin, c1 orchestrator, b1 office (owns the cases), f1/f2 field.
-- Insurer SCR with a template (one required field, approval required).
--   S1 submitted with an open task left on it;  S2 assigned (one-step approval by the orchestrator);
--   S3 assigned (one-step approval by the admin);  S4 closed
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000a1','authenticated','authenticated','s-admin@example.com',null,'{"role":"admin","full_name":"S Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000c1','authenticated','authenticated','s-orch@example.com',null,'{"role":"orchestrator","full_name":"S Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000b1','authenticated','authenticated','s-off1@example.com',null,'{"role":"office","full_name":"S Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000191','{"role":"field","full_name":"S Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919850000192','{"role":"field","full_name":"S Field 2"}','{}');
insert into public.insurers (id, name, code) values ('2e000000-0000-4000-8000-0000000000a1', 'Submitted Insurer', 'SCR');
select public.load_case_template('{"insurer_code":"SCR","claim_type":"motor","variant":"od","name":"SCR OD","requires_approval":true,"output_formats":["pdf"],
  "sections":[{"key":"claim","title":"Claim","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake"},
      {"key":"insured_name","label":"Insured name","required":true}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select v.id::uuid, '2e000000-0000-4000-8000-0000000000a1', v.claim, 'motor', t.id, '1e000000-0000-4000-8000-0000000000b1', v.st::public.case_status
  from public.case_templates t join public.insurers i on i.id = t.insurer_id,
       (values ('3e000000-0000-4000-8000-000000000001', 'SCR-1', 'office_review'),
               ('3e000000-0000-4000-8000-000000000002', 'SCR-2', 'assigned'),
               ('3e000000-0000-4000-8000-000000000003', 'SCR-3', 'assigned'),
               ('3e000000-0000-4000-8000-000000000004', 'SCR-4', 'closed')) v(id, claim, st)
 where i.code = 'SCR' and t.is_active;
-- an open task left on S1, then S1 is submitted (as before D46)
insert into public.tasks (id, case_id, title, assignee_id) values
 ('4e000000-0000-4000-8000-000000000001', '3e000000-0000-4000-8000-000000000001', 'Old visit', '1e000000-0000-4000-8000-0000000000f1');
update public.cases set status = 'submitted' where id = '3e000000-0000-4000-8000-000000000001';
-- report versions: S2 v1 and v2, S3 v1
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin) values
 ('5e000000-0000-4000-8000-000000000021', '3e000000-0000-4000-8000-000000000002', 1, 'cases/s2/report-v1.pdf', '1e000000-0000-4000-8000-0000000000b1', 'generated'),
 ('5e000000-0000-4000-8000-000000000022', '3e000000-0000-4000-8000-000000000002', 2, 'cases/s2/report-v2.pdf', '1e000000-0000-4000-8000-0000000000b1', 'generated'),
 ('5e000000-0000-4000-8000-000000000031', '3e000000-0000-4000-8000-000000000003', 1, 'cases/s3/report-v1.pdf', '1e000000-0000-4000-8000-0000000000b1', 'generated');

select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000001'), 'submitted', 'fixture: S1 submitted');
select has_function('public', 'approve_own_report', array['uuid', 'text'], 'approve_own_report exists');

-- =====================================================================
-- A. D46: no field work on a submitted case until it is reopened
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('3e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000f1', 'New visit')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'owner cannot assign field work on a submitted case');
select throws_ok($$select public.create_field_task('3e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000f1', 'Re-investigation',
                   'Check the RC again', null, 're_investigation', null, null, '4e000000-0000-4000-8000-000000000001')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'nor request a re-investigation');
select throws_ok($$insert into public.tasks (case_id, title, assignee_id, created_by)
                   values ('3e000000-0000-4000-8000-000000000001', 'Direct', '1e000000-0000-4000-8000-0000000000f1', '1e000000-0000-4000-8000-0000000000b1')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'a direct task insert is refused too');
select throws_ok($$insert into public.tasks (case_id, title, assignee_id, created_by)
                   values ('3e000000-0000-4000-8000-000000000004', 'Direct', '1e000000-0000-4000-8000-0000000000f1', '1e000000-0000-4000-8000-0000000000b1')$$,
    '22023', null::text, 'and on a closed case');
select throws_ok($$select public.reassign_field_task('4e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000f2', 'Other operator')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'open task on a submitted case cannot be reassigned');
select throws_ok($$select public.update_field_task('4e000000-0000-4000-8000-000000000001', 'Old visit (edited)')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'nor edited');
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('3e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000f1', 'New visit')$$,
    '22023', 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'the orchestrator is refused too');
select lives_ok($$select public.cancel_field_task('4e000000-0000-4000-8000-000000000001', 'Left over from before submission')$$,
    'a left-over open task can still be cancelled');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000001'), 'submitted', 'cancelling leaves the case submitted');

set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.reopen_case('3e000000-0000-4000-8000-000000000001', 'Insurer asked for a second garage visit')$$,
    'owner reopens on the insurer''s request');
select lives_ok($$select public.create_field_task('3e000000-0000-4000-8000-000000000001', '1e000000-0000-4000-8000-0000000000f1', 'Re-investigation',
                  'Visit the garage again', null, 're_investigation', null, null, '4e000000-0000-4000-8000-000000000001')$$,
    'after reopening a re-investigation can be requested');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000001'), 'field_in_progress', 'case back in the field');

-- =====================================================================
-- B. D47: one-step approval
-- =====================================================================
-- office cannot use the one-step path
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022')$$,
    '42501', null::text, 'office employee cannot approve in one step');
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022')$$,
    '42501', null::text, 'field user cannot');

set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022')$$,
    '23514', '1 required field is empty: Insured name', 'guard rules apply: required field missing');
select lives_ok($$select public.save_case_field_values('3e000000-0000-4000-8000-000000000002', '{"insured_name":"R Rao"}', '{"insured_name":null}')$$,
    'orchestrator fills the required field (D45)');
select lives_ok($$select public.create_field_task('3e000000-0000-4000-8000-000000000002', '1e000000-0000-4000-8000-0000000000f1', 'Visit garage')$$,
    'field work assigned');
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022')$$,
    '55000', 'Field work is still open', 'guard rules apply: open field task');
reset role;
update public.tasks set status = 'completed' where case_id = '3e000000-0000-4000-8000-000000000002';
set local role authenticated;
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000021')$$,
    '22023', 'Only the latest report version can be approved', 'an older version cannot be approved');
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022', repeat('x', 2001))$$,
    '22023', null::text, 'comment length checked');
create temp table t_ap on commit drop as
    select public.approve_own_report('5e000000-0000-4000-8000-000000000022', '  Checked against the RC  ') as id;
select is((select a.decision::text from public.report_approvals a join t_ap t on t.id = a.id), 'approved', 'orchestrator approves in one step');
select is((select a.requested_by::text || '/' || a.decided_by::text from public.report_approvals a join t_ap t on t.id = a.id),
          '1e000000-0000-4000-8000-0000000000c1/1e000000-0000-4000-8000-0000000000c1', 'requester = decider');
select ok((select a.decided_at is not null and a.comments = 'Checked against the RC' from public.report_approvals a join t_ap t on t.id = a.id),
          'decision time and trimmed comment recorded');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000002'), 'orchestrator_review',
          'case approved and ready to send');
select ok(exists (select 1 from public.case_messages where case_id = '3e000000-0000-4000-8000-000000000002'
                   and kind = 'system' and visibility = 'staff' and body = 'Report version 2 approved by S Orch: Checked against the RC'),
          'staff-only thread event');
select throws_ok($$select public.approve_own_report('5e000000-0000-4000-8000-000000000022')$$,
    '55000', null::text, 'a version is approved once');
reset role;
select is_empty($$select 1 from public.notifications n join t_ap t on n.dedupe_key = 'approval:' || t.id::text$$,
    'no one is left a "waiting for approval" notification');
select ok(exists (select 1 from public.notifications where user_id = '1e000000-0000-4000-8000-0000000000b1' and kind = 'report_approved'
                   and case_id = '3e000000-0000-4000-8000-000000000002'),
          'case owner notified of the approval');
set local role authenticated;
select lives_ok($$select public.record_manual_submission('3e000000-0000-4000-8000-000000000002', 'portal', '{pdf}', 'PRT-9', null)$$,
    'the approved report can be recorded as sent');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000002'), 'submitted', 'case submitted');

-- admin, and the office path still asks for a decision
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select public.save_case_field_values('3e000000-0000-4000-8000-000000000003', '{"insured_name":"S Shah"}', '{"insured_name":null}')$$,
    'admin fills the required field');
create temp table t_ap2 on commit drop as select public.approve_own_report('5e000000-0000-4000-8000-000000000031') as id;
select is((select a.decision::text || '/' || a.requested_by::text || '/' || a.decided_by::text from public.report_approvals a join t_ap2 t on t.id = a.id),
          'approved/1e000000-0000-4000-8000-0000000000a1/1e000000-0000-4000-8000-0000000000a1', 'admin approves in one step');

reset role;
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin) values
 ('5e000000-0000-4000-8000-000000000011', '3e000000-0000-4000-8000-000000000001', 1, 'cases/s1/report-v2.pdf', '1e000000-0000-4000-8000-0000000000b1', 'generated');
update public.tasks set status = 'completed' where case_id = '3e000000-0000-4000-8000-000000000001' and status = 'pending';
set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.save_case_field_values('3e000000-0000-4000-8000-000000000001', '{"insured_name":"K Iyer"}', '{"insured_name":null}')$$,
    'office owner fills the reopened report');
select lives_ok($$insert into public.report_approvals (case_id, report_id)
                  values ('3e000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000011')$$,
    'office owner requests approval as before');
select is((select decision::text from public.report_approvals where report_id = '5e000000-0000-4000-8000-000000000011'), 'pending',
          'an office request waits for an orchestrator');

select * from finish();
rollback;
