-- RLS for anon / office / orchestrator / admin; evidence immutability; duplicates
-- Self-contained: fixture below is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- ---------------------------------------------------------------------
-- Fixture (rolled back at the end of the file). IDs:
--   users  1...a1 admin, a2 orchestrator, a3 office, f1 field 1, f2 field 2,
--          f3 field (deactivated)
--   case c1: task t1 (field 1, pending) with items ci1 (camera-only), ci2
--   case c2: task t2 (field 1, completed)
--   case c3: task t3 (field 2, pending) with item ci3; task t4 (field 3)
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a1','authenticated','authenticated','t-admin@example.com',null,'{"role":"admin","full_name":"T Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a2','authenticated','authenticated','t-orch@example.com',null,'{"role":"orchestrator","full_name":"T Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a3','authenticated','authenticated','t-office@example.com',null,'{"role":"office","full_name":"T Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919811111111','{"role":"field","full_name":"T Field 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919822222222','{"role":"field","full_name":"T Field 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000f3','authenticated','authenticated',null,'919833333333','{"role":"field","full_name":"T Field 3"}','{}');

insert into public.insurers (id, name, code, tat_days)
values ('20000000-0000-4000-8000-000000000001', 'Fixture Insurer', 'FIX', 7);

-- c1, c2 are owned by the office user (D44: office sees only its own cases); c3 is unassigned
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FIX-1', 'health', 'assigned', '10000000-0000-4000-8000-0000000000a3'),
       ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'FIX-2', 'motor',  'field_in_progress', '10000000-0000-4000-8000-0000000000a3'),
       ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'FIX-3', 'health', 'assigned', null);

insert into public.parties (id, case_id, role, name)
values ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'insured', 'P1'),
       ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'insured', 'P2'),
       ('31000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'insured', 'P3');

insert into public.tasks (id, case_id, title, assignee_id, status, location_text)
values ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'T1', '10000000-0000-4000-8000-0000000000f1', 'pending',   'Loc 1'),
       ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'T2', '10000000-0000-4000-8000-0000000000f1', 'completed', 'Loc 2'),
       ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'T3', '10000000-0000-4000-8000-0000000000f2', 'pending',   'Loc 3'),
       ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000003', 'T4', '10000000-0000-4000-8000-0000000000f3', 'pending',   'Loc 4');

insert into public.task_checklist_items (id, task_id, position, description, camera_only)
values ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 1, 'Front photo', true),
       ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 2, 'Bill',        false),
       ('50000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', 1, 'Front photo', true);

insert into public.emails (id, gmail_message_id, from_address, received_at, case_id)
values ('60000000-0000-4000-8000-000000000001', 'fixture-msg-1', 'a@fixture.example', now(), '30000000-0000-4000-8000-000000000001');
insert into public.email_attachments (email_id, filename, storage_path, sha256)
values ('60000000-0000-4000-8000-000000000001', 'claim.pdf', 'emails/60000000-0000-4000-8000-000000000001/claim.pdf', repeat('ab', 32));
insert into public.intake_extractions (email_id, case_id, model, extracted)
values ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'fixture', '{}');
insert into public.reports (id, case_id, version, storage_path, uploaded_by)
values ('70000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1, 'cases/x/report-v1.docx', '10000000-0000-4000-8000-0000000000a3');
insert into public.submissions (case_id, report_id, channel, submitted_by)
values ('30000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'email', '10000000-0000-4000-8000-0000000000a2');

-- evidence: ev1 by field 1 on t1; ev2 by office on c1 (web upload)
insert into public.evidence (id, case_id, task_id, checklist_item_id, evidence_type, capture_source, storage_path, sha256, captured_by)
values ('80000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000002', 'photo', 'camera',
        'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('01', 32) || '.jpg',
        repeat('01', 32), '10000000-0000-4000-8000-0000000000f1'),
       ('80000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
        null, 'document', 'web_upload',
        'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('02', 32) || '.pdf',
        repeat('02', 32), '10000000-0000-4000-8000-0000000000a3');

-- field 3 is deactivated
update public.profiles set is_active = false where id = '10000000-0000-4000-8000-0000000000f3';

-- =====================================================================
-- Anonymous
-- =====================================================================
set local role anon;
select throws_ok($$select 1 from public.cases$$,    '42501', null::text, 'anon has no access to cases');
select throws_ok($$select 1 from public.profiles$$, '42501', null::text, 'anon has no access to profiles');
select throws_ok($$select 1 from public.v_case_dashboard$$, '42501', null::text, 'anon has no access to the dashboard view');
reset role;

-- =====================================================================
-- Office
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select ok((select count(*) from public.cases where insurer_id = '20000000-0000-4000-8000-000000000001') = 2, 'office sees only its own cases (D44)');
select isnt_empty($$select 1 from public.emails$$,             'office reads emails');
select isnt_empty($$select 1 from public.intake_extractions$$, 'office reads extractions');
select isnt_empty($$select 1 from public.reports$$,            'office reads reports');
select ok((select count(*) from public.evidence where case_id = '30000000-0000-4000-8000-000000000001') = 2, 'office reads all evidence');
select is_empty($$select 1 from public.audit_log$$, 'office cannot read the audit log');
-- D44: no staff UPDATE policy on tasks (changes go through the task RPCs): a direct update is a no-op
select lives_ok($$update public.tasks set title = 'T1 renamed' where id = '40000000-0000-4000-8000-000000000001'$$, 'office direct task update runs');
select throws_ok($$insert into public.insurers (name, code) values ('Rogue', 'RGE')$$, '42501', null::text, 'office cannot create insurers');
update public.insurers set tat_days = 99 where id = '20000000-0000-4000-8000-000000000001';
select throws_ok($$insert into public.checklist_templates (name, claim_type) values ('x', 'other')$$, '42501', null::text, 'office cannot create checklist templates');
select throws_ok($$insert into public.profiles (id, full_name, role) values (gen_random_uuid(), 'x', 'admin')$$, '42501', null::text, 'office cannot create profiles');
update public.profiles set role = 'admin' where id = '10000000-0000-4000-8000-0000000000a3';

-- evidence: flag allowed, core fields / delete blocked
select lives_ok($$update public.evidence set is_flagged = true, flag_reason = 'GPS mismatch' where id = '80000000-0000-4000-8000-000000000001'$$,
    'office can flag evidence');
select throws_ok($$update public.evidence set sha256 = repeat('ff', 32) where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'office cannot change evidence hash');
select throws_ok($$update public.evidence set latitude = 1 where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'office cannot change evidence GPS');
select throws_ok($$update public.evidence set mime_type = 'image/png' where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'office cannot change evidence metadata');
select throws_ok($$update public.evidence set checklist_item_id = '50000000-0000-4000-8000-000000000001' where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'office cannot re-link evidence to another checklist item');
delete from public.evidence where id = '80000000-0000-4000-8000-000000000001';  -- no DELETE policy: 0 rows
select is((select count(*)::int from public.evidence where id = '80000000-0000-4000-8000-000000000001'), 1,
    'office cannot delete evidence');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'document', 'web_upload',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('3a', 32) || '.pdf',
                    repeat('3a', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'office cannot add evidence in another user''s name');

-- =====================================================================
-- Orchestrator
-- =====================================================================
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select ok((select count(*) from public.cases where insurer_id = '20000000-0000-4000-8000-000000000001') = 3, 'orchestrator sees all cases');
select is_empty($$select 1 from public.audit_log$$, 'orchestrator cannot read the audit log');
select throws_ok($$insert into public.insurers (name, code) values ('Rogue', 'RGE')$$, '42501', null::text, 'orchestrator cannot create insurers');
select throws_ok($$insert into public.checklist_template_items (template_id, position, description)
                   select id, 99, 'x' from public.checklist_templates limit 1$$, '42501', null::text, 'orchestrator cannot add template items');
update public.checklist_template_items set is_mandatory = not is_mandatory;
select lives_ok($$update public.cases set status = 'office_review' where id = '30000000-0000-4000-8000-000000000002'$$, 'orchestrator can move case status');

-- =====================================================================
-- Admin
-- =====================================================================
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$insert into public.insurers (name, code) values ('Admin Insurer', 'ADM')$$, 'admin can create insurers');
select isnt_empty($$select 1 from public.audit_log$$, 'admin reads the audit log');
select throws_ok($$update public.evidence set note_text = 'x' where id = '80000000-0000-4000-8000-000000000002'$$,
    '42501', null::text, 'admin cannot change evidence core fields');

-- =====================================================================
-- Owner checks (RLS bypassed; triggers still apply)
-- =====================================================================
reset role;
set local request.jwt.claims to '';
select is((select tat_days from public.insurers where id = '20000000-0000-4000-8000-000000000001'), 7, 'office update of insurer had no effect');
select is((select role::text from public.profiles where id = '10000000-0000-4000-8000-0000000000a3'), 'office', 'office cannot change own role');
select is((select count(*)::int from public.checklist_template_items where is_mandatory is distinct from true and template_id = 'c0000000-0000-4000-8000-000000000001'),
          (select count(*)::int from public.checklist_template_items where is_mandatory = false and template_id = 'c0000000-0000-4000-8000-000000000001'),
          'orchestrator update of template items had no effect') ;
select ok((select is_flagged from public.evidence where id = '80000000-0000-4000-8000-000000000001'), 'flag update persisted');
select is((select title from public.tasks where id = '40000000-0000-4000-8000-000000000001'), 'T1', 'office direct task update had no effect');
select throws_ok($$delete from public.evidence where id = '80000000-0000-4000-8000-000000000002'$$,
    '42501', null::text, 'even the database owner cannot delete evidence');
select throws_ok($$update public.evidence set storage_path = 'x' where id = '80000000-0000-4000-8000-000000000002'$$,
    '42501', null::text, 'even the database owner cannot change evidence core fields');
select is((select to_status::text from public.case_status_history
            where case_id = '30000000-0000-4000-8000-000000000002' order by id desc limit 1), 'office_review',
    'status change written to history');
select is((select changed_by from public.case_status_history
            where case_id = '30000000-0000-4000-8000-000000000002' order by id desc limit 1),
    '10000000-0000-4000-8000-0000000000a2'::uuid, 'status history records the actor');
select isnt_empty($$select 1 from public.audit_log where table_name = 'evidence'
                    and record_id = '80000000-0000-4000-8000-000000000001' and action = 'UPDATE'$$,
    'evidence flag change is audited');

-- =====================================================================
-- Duplicates and integrity constraints
-- =====================================================================
select throws_ok($$insert into public.cases (insurer_id, insurer_claim_no, claim_type)
                   values ('20000000-0000-4000-8000-000000000001', 'FIX-1', 'health')$$,
    '23505', null::text, 'duplicate (insurer, claim no) rejected');
select lives_ok($$insert into public.cases (insurer_id, insurer_claim_no, claim_type)
                  select id, 'FIX-1', 'health' from public.insurers where code = 'ADM'$$,
    'same claim no under another insurer is allowed');
select throws_ok($$insert into public.emails (gmail_message_id, from_address, received_at)
                   values ('fixture-msg-1', 'b@fixture.example', now())$$,
    '23505', null::text, 'duplicate gmail_message_id rejected');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('01', 32) || '.jpg',
                    repeat('01', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '23505', null::text, 'duplicate evidence hash on the same case rejected');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/ABC.jpg',
                    'ABC', '10000000-0000-4000-8000-0000000000f1')$$,
    '23514', null::text, 'malformed sha256 rejected');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000002/tasks/40000000-0000-4000-8000-000000000001/' || repeat('4a', 32) || '.jpg',
                    repeat('4a', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '23514', null::text, 'evidence task must belong to the evidence case');
select matches((select case_ref from public.cases where id = '30000000-0000-4000-8000-000000000001'),
    '^INV-[0-9]{4}-[0-9]{6}$', 'case_ref generated');
select is((select due_at - received_at from public.cases where id = '30000000-0000-4000-8000-000000000001'),
    interval '7 days', 'due_at defaults from insurer TAT');

-- Function exposure
select ok(not has_function_privilege('anon', 'private.current_user_role()', 'execute'), 'anon cannot call role helper');
select ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on private schema');
select ok(not has_function_privilege('authenticated', 'private.handle_new_auth_user()', 'execute'), 'authenticated cannot call the auth trigger function');

select * from finish();
rollback;
