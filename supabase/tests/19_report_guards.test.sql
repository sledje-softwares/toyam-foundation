-- Report guards (20261115800000_report_guards.sql): save_case_field_values (owner / orchestrator / admin,
-- status, compare-and-set), claim / policy no. sync (G6), approval request rules (G5), submission records,
-- acknowledgement, manual / portal submission, reopen. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(72);

-- ---------------------------------------------------------------------
-- Fixture (prefix 1d/2d/3d...): a1 admin, c1 orchestrator, b1 office (owner), b2 office, f1 field;
-- insurer RGD (pool: b1); template with claim / policy no. and required fields; cases RGD-1 (b1), RGD-2.
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000a1','authenticated','authenticated','g-admin@example.com',null,'{"role":"admin","full_name":"G Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000c1','authenticated','authenticated','g-orch@example.com',null,'{"role":"orchestrator","full_name":"G Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000b1','authenticated','authenticated','g-off1@example.com',null,'{"role":"office","full_name":"G Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000b2','authenticated','authenticated','g-off2@example.com',null,'{"role":"office","full_name":"G Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000091','{"role":"field","full_name":"G Field"}','{}');
insert into public.insurers (id, name, code) values ('2d000000-0000-4000-8000-0000000000a1', 'Guard Insurer', 'RGD');
insert into public.assignment_rules (id, name, insurer_id) values ('2d100000-0000-4000-8000-000000000001', 'RGD pool', '2d000000-0000-4000-8000-0000000000a1');
insert into public.assignment_rule_members values ('2d100000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1');
select public.load_case_template('{"insurer_code":"RGD","claim_type":"motor","variant":"od","name":"RGD OD","requires_approval":true,"output_formats":["pdf"],
  "sections":[{"key":"claim","title":"Claim","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true},
      {"key":"policy_no","label":"Policy no","source":"intake"},
      {"key":"insured_name","label":"Insured name","required":true}]},
    {"key":"garage","title":"Garage","fields":[
      {"key":"odometer","label":"Odometer","required":true},
      {"key":"job_card_no","label":"Job card"}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, policy_no, claim_type, template_id)
select v.id::uuid, '2d000000-0000-4000-8000-0000000000a1', v.claim, 'P-1', 'motor', t.id
  from public.case_templates t join public.insurers i on i.id = t.insurer_id,
       (values ('3d000000-0000-4000-8000-000000000001', 'RGD-1'), ('3d000000-0000-4000-8000-000000000002', 'RGD-2')) v(id, claim)
 where i.code = 'RGD' and t.is_active;
-- intake values (as intake would write them)
insert into public.case_field_values (case_id, field_id, value, source)
select '3d000000-0000-4000-8000-000000000001', f.id, v.val, 'email_parser'
  from public.case_template_fields f
  join public.cases c on c.template_id = f.template_id and c.id = '3d000000-0000-4000-8000-000000000001'
  join (values ('insurer_claim_no', 'RGD-1'), ('policy_no', 'P-1')) v(key, val) on v.key = f.key;

select is((select office_owner_id from public.cases where id = '3d000000-0000-4000-8000-000000000001'),
          '1d000000-0000-4000-8000-0000000000b1'::uuid, 'fixture: case owned by G Office 1');
select has_function('public', 'save_case_field_values', array['uuid', 'jsonb', 'jsonb'], 'save_case_field_values exists');
select has_function('private', 'can_manage_case', array['uuid'], 'can_manage_case exists (D44)');

-- =====================================================================
-- A. save_case_field_values
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001',
            '{"odometer":"3200"}', '{"odometer":""}') -> 'saved'), '["odometer"]'::jsonb, 'owner saves a new value');
select is((select v.value || '/' || v.source || '/' || v.updated_by from public.case_field_values v
             join public.case_template_fields f on f.id = v.field_id
            where v.case_id = '3d000000-0000-4000-8000-000000000001' and f.key = 'odometer'),
          '3200/office/1d000000-0000-4000-8000-0000000000b1', 'stored with source office and the editor');
create temp table t_res on commit drop as
    select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"odometer":"3300"}', '{"odometer":""}') as r;
select is((select r -> 'saved' from t_res), '[]'::jsonb, 'stale expected value: nothing saved');
select is((select r #>> '{conflicts,odometer,value}' from t_res), '3200', 'conflict returns the current value');
select is((select r #>> '{conflicts,odometer,updated_by_name}' from t_res), 'G Office 1', 'conflict says who saved it');
select ok((select (r #>> '{conflicts,odometer,updated_at}') is not null from t_res), 'conflict says when');
select is((select v.value from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
            where v.case_id = '3d000000-0000-4000-8000-000000000001' and f.key = 'odometer'), '3200', 'conflicting value not written');
drop table t_res;
create temp table t_res on commit drop as
    select public.save_case_field_values('3d000000-0000-4000-8000-000000000001',
        '{"odometer":"3300","job_card_no":"J-1"}', '{"odometer":"3200","job_card_no":"J-0"}') as r;
select is((select r -> 'saved' from t_res), '["odometer"]'::jsonb, 'partial save writes the fields without conflict');
select ok((select (r -> 'conflicts') ? 'job_card_no' from t_res), 'and returns the conflicting one');
select is((select r #> '{conflicts,job_card_no,value}' from t_res), 'null'::jsonb, 'a field never filled conflicts with value null');
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"odometer":" 3300 "}', '{"odometer":"3300"}') -> 'saved'),
          '[]'::jsonb, 'unchanged value is not rewritten');
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"odometer":"a\r\nb"}', '{"odometer":"3300\r\n"}') -> 'saved'),
          '["odometer"]'::jsonb, 'line endings and spaces do not cause false conflicts');
select is((select v.value from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
            where v.case_id = '3d000000-0000-4000-8000-000000000001' and f.key = 'odometer'), E'a\nb', 'stored with LF line endings');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"nope":"x"}', '{"nope":""}')$$,
    '22023', null::text, 'unknown field rejected');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"odometer":"x"}', '{}')$$,
    '22023', null::text, 'expected value required for every field');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"odometer":5}', '{"odometer":""}')$$,
    '22023', null::text, 'non-text value rejected');
select throws_ok($$insert into public.case_field_values (case_id, field_id, value)
                   select '3d000000-0000-4000-8000-000000000001', f.id, 'x' from public.case_template_fields f
                     join public.cases c on c.template_id = f.template_id and c.id = '3d000000-0000-4000-8000-000000000001'
                    where f.key = 'job_card_no'$$,
    '42501', null::text, 'direct insert by staff refused');
select throws_ok($$update public.case_field_values set value = 'x' where case_id = '3d000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'direct update by staff refused');
select is((select count(*)::int from public.case_field_values where case_id = '3d000000-0000-4000-8000-000000000001'), 3,
          'staff still read the values');
select ok(exists (select 1 from public.case_field_history('3d000000-0000-4000-8000-000000000001')
                   where field_key = 'odometer' and action = 'UPDATE' and actor_name = 'G Office 1' and new_value = '3300'),
          'field history records the change');

set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-2"}', '{"job_card_no":""}')$$,
    '42501', null::text, 'office user who does not own the case is refused (D44)');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-2"}', '{"job_card_no":""}') -> 'saved'),
          '["job_card_no"]'::jsonb, 'orchestrator edits the report (D45)');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-3"}', '{"job_card_no":"J-2"}') -> 'saved'),
          '["job_card_no"]'::jsonb, 'admin edits the report');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-4"}', '{"job_card_no":"J-3"}')$$,
    '42501', null::text, 'field user refused');
select is_empty($$select 1 from public.case_field_values where case_id = '3d000000-0000-4000-8000-000000000001' and value = 'J-3'$$,
    'field user cannot read office values');

-- =====================================================================
-- B. G6: claim / policy no. follow the fields
-- =====================================================================
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001',
                  '{"insurer_claim_no":"RGD-1A","policy_no":"P-9"}', '{"insurer_claim_no":"RGD-1","policy_no":"P-1"}')$$,
    'owner corrects claim and policy no.');
select is((select insurer_claim_no || '/' || policy_no from public.cases where id = '3d000000-0000-4000-8000-000000000001'),
          'RGD-1A/P-9', 'case record follows the fields');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001',
                   '{"insurer_claim_no":"RGD-2"}', '{"insurer_claim_no":"RGD-1A"}')$$,
    '23505', 'Another case of this insurer already has claim number RGD-2', 'claim no. of another case refused');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001',
                   '{"insurer_claim_no":""}', '{"insurer_claim_no":"RGD-1A"}')$$,
    '23514', null::text, 'claim no. cannot be cleared');
select lives_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"policy_no":null}', '{"policy_no":"P-9"}')$$,
    'policy no. can be cleared');
select is((select policy_no from public.cases where id = '3d000000-0000-4000-8000-000000000001'), null, 'cleared on the case too');
select throws_ok($$update public.cases set insurer_claim_no = 'X-1' where id = '3d000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'case claim no. cannot be changed directly when the template has the field');

-- =====================================================================
-- C. G5: approval request
-- =====================================================================
reset role;
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin)
values ('5d000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000001', 1,
        'cases/3d000000-0000-4000-8000-000000000001/report-v1.pdf', '1d000000-0000-4000-8000-0000000000b1', 'generated');
set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$insert into public.report_approvals (case_id, report_id, requested_by)
                   values ('3d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1')$$,
    '23514', '1 required field is empty: Insured name', 'approval refused while a required field is empty');
select lives_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"insured_name":"R Rao"}', '{"insured_name":null}')$$,
    'required field filled');
select lives_ok($$select public.create_field_task('3d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000f1', 'Visit garage')$$,
    'field work assigned');
select throws_ok($$insert into public.report_approvals (case_id, report_id, requested_by)
                   values ('3d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1')$$,
    '55000', 'Field work is still open', 'approval refused while field work is open');
reset role;
update public.tasks set status = 'completed' where case_id = '3d000000-0000-4000-8000-000000000001';
set local role authenticated;
select is((select status::text from public.cases where id = '3d000000-0000-4000-8000-000000000001'), 'office_review', 'case in office review');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$insert into public.report_approvals (case_id, report_id, requested_by)
                   values ('3d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b2')$$,
    '42501', null::text, 'office user who does not own the case cannot request approval');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into public.report_approvals (case_id, report_id, requested_by)
                  values ('3d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1')$$,
    'owner requests approval');
select is((select status::text from public.cases where id = '3d000000-0000-4000-8000-000000000001'), 'orchestrator_review', 'case waits for approval');
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-5"}', '{"job_card_no":"J-3"}')$$,
    '55000', null::text, 'values locked while approval is pending');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-5"}', '{"job_card_no":"J-3"}')$$,
    '55000', null::text, 'locked for the orchestrator too');
update public.report_approvals set decision = 'approved' where report_id = '5d000000-0000-4000-8000-000000000001';

-- =====================================================================
-- D. Submissions: manual / portal, records, acknowledgement, reopen
-- =====================================================================
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'email', '{pdf}', null, 'sent')$$,
    '22023', null::text, 'email submissions are left to the sender');
select throws_ok($$select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'portal', '{pdf}', null, null)$$,
    '22023', 'Enter the portal reference number', 'portal submission needs the portal reference');
select throws_ok($$select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'portal', '{docx}', 'PRT-77', null)$$,
    '23514', null::text, 'format not allowed by the template refused');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'portal', '{pdf}', 'PRT-77', null)$$,
    '42501', null::text, 'office user who does not own the case cannot record a submission');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
create temp table t_sub on commit drop as
    select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'portal', '{pdf}', 'PRT-77', 'Uploaded to the portal') as id;
grant select on t_sub to service_role;
select is((select s.channel || '/' || s.submitted_by || '/' || s.insurer_reference from public.submissions s join t_sub t on t.id = s.id),
          'portal/1d000000-0000-4000-8000-0000000000b1/PRT-77', 'portal submission recorded by the owner');
select is((select status::text from public.cases where id = '3d000000-0000-4000-8000-000000000001'), 'submitted', 'case submitted');
select throws_ok($$select public.record_manual_submission('3d000000-0000-4000-8000-000000000001', 'other', '{pdf}', null, 'By hand')$$,
    '55000', null::text, 'a submitted case is not recorded twice');
select throws_ok($$update public.submissions set notes = 'changed' where id = (select id from t_sub)$$,
    '42501', null::text, 'staff cannot change a submission directly');

set local role service_role;
select throws_ok($$update public.submissions set channel = 'other' where id = (select id from t_sub)$$,
    '42501', null::text, 'submission core fields are immutable');
select throws_ok($$delete from public.submissions where id = (select id from t_sub)$$,
    '42501', null::text, 'submissions cannot be deleted');
select lives_ok($$update public.submissions set sent_message_id = '<m1@x>' where id = (select id from t_sub)$$, 'sender id set once');
select throws_ok($$update public.submissions set sent_message_id = '<m2@x>' where id = (select id from t_sub)$$,
    '42501', null::text, 'set-once field cannot change again');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.record_submission_ack((select id from t_sub), now(), null)$$,
    '42501', null::text, 'office user who does not own the case cannot record the acknowledgement');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.record_submission_ack((select id from t_sub), now() + interval '1 day', null)$$,
    '22023', null::text, 'acknowledgement in the future refused');
select lives_ok($$select public.record_submission_ack((select id from t_sub), now(), 'Ack mail from RCU')$$, 'owner records the acknowledgement');
select is((select acknowledged_by::text || '/' || ack_note from public.submissions where id = (select id from t_sub)),
          '1d000000-0000-4000-8000-0000000000b1/Ack mail from RCU', 'acknowledgement stamped with who and the note');
select throws_ok($$select public.record_submission_ack((select id from t_sub), now(), null)$$,
    '55000', null::text, 'acknowledgement recorded once');

set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.reopen_case('3d000000-0000-4000-8000-000000000001', 'Insurer query')$$,
    '42501', null::text, 'field user cannot reopen');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.reopen_case('3d000000-0000-4000-8000-000000000001', 'x')$$,
    '22023', null::text, 'reopen needs a reason');
select lives_ok($$select public.reopen_case('3d000000-0000-4000-8000-000000000001', 'Insurer asked for the RC copy')$$,
    'orchestrator reopens on an insurer query');
select is((select status::text from public.cases where id = '3d000000-0000-4000-8000-000000000001'), 'office_review', 'case back in office review');
select is((select note from public.case_status_history where case_id = '3d000000-0000-4000-8000-000000000001'
            and from_status = 'submitted' and to_status = 'office_review'), 'Reopened: Insurer asked for the RC copy',
          'status history keeps the reason');
select is((select reopened_by::text || '/' || reopen_reason from public.submissions where id = (select id from t_sub)),
          '1d000000-0000-4000-8000-0000000000c1/Insurer asked for the RC copy', 'submission marked reopened');
select ok(exists (select 1 from public.case_messages where case_id = '3d000000-0000-4000-8000-000000000001'
                   and kind = 'system' and visibility = 'staff' and body = 'Case reopened by G Orch: Insurer asked for the RC copy'),
          'staff-only thread event');
reset role;
select ok(exists (select 1 from public.notifications where user_id = '1d000000-0000-4000-8000-0000000000b1' and kind = 'case_reopened'),
          'owner notified');
set local role authenticated;
select throws_ok($$select public.reopen_case('3d000000-0000-4000-8000-000000000001', 'Again')$$,
    '55000', null::text, 'only a submitted case can be reopened');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select public.save_case_field_values('3d000000-0000-4000-8000-000000000001', '{"job_card_no":"J-6"}', '{"job_card_no":"J-3"}') -> 'saved'),
          '["job_card_no"]'::jsonb, 'report editable again after reopening');

select * from finish();
rollback;
