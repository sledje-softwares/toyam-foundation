-- RLS for field users (least privilege, task/checklist/evidence rules)
-- Self-contained: fixture below is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

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

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FIX-1', 'health', 'assigned'),
       ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'FIX-2', 'motor',  'field_in_progress'),
       ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'FIX-3', 'health', 'assigned');

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
-- Field user 1
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f1","role":"authenticated"}';

select results_eq($$select id from public.cases order by id$$,
    $$values ('30000000-0000-4000-8000-000000000001'::uuid), ('30000000-0000-4000-8000-000000000002'::uuid)$$,
    'field 1 sees only the cases on which they hold a task');
select results_eq($$select id from public.parties order by id$$,
    $$values ('31000000-0000-4000-8000-000000000001'::uuid), ('31000000-0000-4000-8000-000000000002'::uuid)$$,
    'field 1 sees only parties of their cases');
select results_eq($$select id from public.tasks order by id$$,
    $$values ('40000000-0000-4000-8000-000000000001'::uuid), ('40000000-0000-4000-8000-000000000002'::uuid)$$,
    'field 1 sees only their own tasks');
select results_eq($$select id from public.task_checklist_items order by id$$,
    $$values ('50000000-0000-4000-8000-000000000001'::uuid), ('50000000-0000-4000-8000-000000000002'::uuid)$$,
    'field 1 sees only checklist items of their tasks');
select results_eq($$select id from public.v_case_dashboard order by id$$,
    $$values ('30000000-0000-4000-8000-000000000001'::uuid), ('30000000-0000-4000-8000-000000000002'::uuid)$$,
    'dashboard view respects RLS for field 1');
select is_empty($$select 1 from public.emails$$,              'field cannot read emails');
select is_empty($$select 1 from public.email_attachments$$,   'field cannot read email attachments');
select is_empty($$select 1 from public.intake_extractions$$,  'field cannot read extractions');
select is_empty($$select 1 from public.reports$$,             'field cannot read reports');
select is_empty($$select 1 from public.submissions$$,         'field cannot read submissions');
select is_empty($$select 1 from public.audit_log$$,           'field cannot read the audit log');
select is_empty($$select 1 from public.case_status_history$$, 'field cannot read status history');
select is_empty($$select 1 from public.checklist_templates$$, 'field cannot read checklist templates');
select is_empty($$select 1 from public.entities$$,            'field cannot read entities');
select results_eq($$select id from public.profiles$$,
    $$values ('10000000-0000-4000-8000-0000000000f1'::uuid)$$, 'field sees only own profile');
select results_eq($$select id from public.evidence$$,
    $$values ('80000000-0000-4000-8000-000000000001'::uuid)$$, 'field reads only evidence they captured');

-- Task updates: status only, forward only
select lives_ok($$update public.tasks set status = 'in_progress', started_at = '2000-01-01'
                  where id = '40000000-0000-4000-8000-000000000001'$$, 'field can start own task');
select ok((select started_at > now() - interval '1 minute' from public.tasks
           where id = '40000000-0000-4000-8000-000000000001'), 'started_at is set by the server, not the client');
select throws_ok($$update public.tasks set title = 'hacked' where id = '40000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot change task title');
select throws_ok($$update public.tasks set location_text = 'elsewhere' where id = '40000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot change task location');
select throws_ok($$update public.tasks set assignee_id = '10000000-0000-4000-8000-0000000000f2' where id = '40000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot reassign a task');
select throws_ok($$update public.tasks set status = 'cancelled' where id = '40000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot cancel a task');
select throws_ok($$update public.tasks set status = 'in_progress' where id = '40000000-0000-4000-8000-000000000002'$$,
    '42501', null::text, 'field cannot reopen a completed task');
update public.tasks set status = 'in_progress' where id = '40000000-0000-4000-8000-000000000003';
select throws_ok($$insert into public.tasks (case_id, title, assignee_id)
                   values ('30000000-0000-4000-8000-000000000001', 'x', '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'field cannot create tasks');
select throws_ok($$insert into public.cases (insurer_id, insurer_claim_no, claim_type)
                   values ('20000000-0000-4000-8000-000000000001', 'FIX-99', 'health')$$,
    '42501', null::text, 'field cannot create cases');

-- Checklist items: status / note only
select lives_ok($$update public.task_checklist_items set status = 'not_available', note = 'Hospital closed'
                  where id = '50000000-0000-4000-8000-000000000002'$$, 'field can update checklist status and note');
select throws_ok($$update public.task_checklist_items set camera_only = false where id = '50000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot clear camera_only');
select throws_ok($$update public.task_checklist_items set is_mandatory = false where id = '50000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot change is_mandatory');
select throws_ok($$update public.task_checklist_items set status = 'waived' where id = '50000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'field cannot waive a checklist item');

-- Evidence inserts
select lives_ok($$insert into public.evidence (case_id, task_id, checklist_item_id, evidence_type, capture_source,
                    storage_path, sha256, captured_by, server_received_at)
                  values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
                    '50000000-0000-4000-8000-000000000001', 'photo', 'gallery',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('0a', 32) || '.jpg',
                    repeat('0a', 32), '10000000-0000-4000-8000-0000000000f1', '2000-01-01')$$,
    'field can add evidence to own open task');
-- D18 (2026-11-13): gallery / shared files are accepted without any mark or flag
select ok((select not is_flagged and flag_reason is null from public.evidence where sha256 = repeat('0a', 32)),
    'gallery upload is accepted without a flag (D18)');
select ok((select server_received_at > now() - interval '1 minute' from public.evidence where sha256 = repeat('0a', 32)),
    'server_received_at is set by the database');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000003/tasks/40000000-0000-4000-8000-000000000003/' || repeat('0b', 32) || '.jpg',
                    repeat('0b', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    null::char(5), null::text, 'field cannot add evidence to another operator''s task');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000002/tasks/40000000-0000-4000-8000-000000000002/' || repeat('0c', 32) || '.jpg',
                    repeat('0c', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'field cannot add evidence to a closed task');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('0d', 32) || '.jpg',
                    repeat('0d', 32), '10000000-0000-4000-8000-0000000000f2')$$,
    '42501', null::text, 'field cannot add evidence in another user''s name');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'photo', 'web_upload',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('0e', 32) || '.jpg',
                    repeat('0e', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'field evidence must come from camera or gallery');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'photo', 'camera',
                    'somewhere/else.jpg', repeat('0f', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '23514', null::text, 'evidence storage_path must follow the case/task/sha256 convention');
select throws_ok($$insert into public.evidence (case_id, task_id, checklist_item_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
                    '50000000-0000-4000-8000-000000000003', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('1a', 32) || '.jpg',
                    repeat('1a', 32), '10000000-0000-4000-8000-0000000000f1')$$,
    '23514', null::text, 'evidence cannot point at a checklist item of another task');

-- Evidence cannot be changed or removed by field (no policy: zero rows affected)
update public.evidence set is_flagged = true, flag_reason = 'self' where id = '80000000-0000-4000-8000-000000000001';
delete from public.evidence where id = '80000000-0000-4000-8000-000000000001';

-- =====================================================================
-- Field user 2
-- =====================================================================
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select results_eq($$select id from public.cases$$, $$values ('30000000-0000-4000-8000-000000000003'::uuid)$$,
    'field 2 sees only their own case');
select is_empty($$select 1 from public.cases where id = '30000000-0000-4000-8000-000000000001'$$, 'field 2 cannot see field 1''s case');
select is_empty($$select 1 from public.parties where case_id = '30000000-0000-4000-8000-000000000001'$$, 'field 2 cannot see field 1''s parties');
select is_empty($$select 1 from public.tasks where assignee_id = '10000000-0000-4000-8000-0000000000f1'$$, 'field 2 cannot see field 1''s tasks');
select is_empty($$select 1 from public.task_checklist_items where task_id = '40000000-0000-4000-8000-000000000001'$$, 'field 2 cannot see field 1''s checklist');
select is_empty($$select 1 from public.evidence$$, 'field 2 cannot see field 1''s evidence');

-- =====================================================================
-- Deactivated field user (still assigned to t4)
-- =====================================================================
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f3","role":"authenticated"}';
select is_empty($$select 1 from public.tasks$$, 'deactivated field user sees no tasks');
select is_empty($$select 1 from public.cases$$, 'deactivated field user sees no cases');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004', 'photo', 'camera',
                    'cases/30000000-0000-4000-8000-000000000003/tasks/40000000-0000-4000-8000-000000000004/' || repeat('2a', 32) || '.jpg',
                    repeat('2a', 32), '10000000-0000-4000-8000-0000000000f3')$$,
    null::char(5), null::text, 'deactivated field user cannot add evidence');

-- =====================================================================
-- Verify as owner
-- =====================================================================
reset role;
set local request.jwt.claims to '';
select is((select status::text from public.tasks where id = '40000000-0000-4000-8000-000000000003'), 'pending',
    'field 1 could not update field 2''s task');
select is((select is_flagged from public.evidence where id = '80000000-0000-4000-8000-000000000001'), false,
    'field cannot flag / update evidence');
select is((select count(*)::int from public.evidence where id = '80000000-0000-4000-8000-000000000001'), 1,
    'field cannot delete evidence');
select ok((select completed_at is not null from public.task_checklist_items where id = '50000000-0000-4000-8000-000000000002'),
    'checklist completed_at set by the server');

select * from finish();
rollback;
