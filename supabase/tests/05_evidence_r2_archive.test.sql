-- Evidence on R2: upload permission check, set-once archive fields, purge candidates
-- Self-contained: fixture below is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

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

-- D44: the office user owns these cases (office sees only its own cases)
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FIX-1', 'health', 'assigned', '10000000-0000-4000-8000-0000000000a3'),
       ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'FIX-2', 'motor',  'field_in_progress', '10000000-0000-4000-8000-0000000000a3'),
       ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'FIX-3', 'health', 'assigned', '10000000-0000-4000-8000-0000000000a3');

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
-- can_upload_evidence (R2 presigner check)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000001'), true,  'field: own open task -> true');
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000003'), false, 'field: another operator''s task -> false');
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000002'), false, 'field: own completed task -> false');
select is(public.can_upload_evidence(gen_random_uuid()),                      false, 'field: unknown task -> false');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f3","role":"authenticated"}';
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000004'), false, 'deactivated field user -> false');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000003'), true,  'office: task on own case -> true');
select is(public.can_upload_evidence('40000000-0000-4000-8000-000000000002'), true,  'office: completed task on own case -> true');
reset role;
set local request.jwt.claims to '';
select ok(not has_function_privilege('anon', 'public.can_upload_evidence(uuid)', 'execute'), 'anon cannot call can_upload_evidence');
select is((select storage_backend from public.evidence where id = '80000000-0000-4000-8000-000000000001'), 'r2',
    'evidence storage_backend defaults to r2');

-- =====================================================================
-- Archive columns: archive job only, set once
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok($$update public.evidence set archived_at = now() where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'admin (staff) cannot set archive fields');
select throws_ok($$insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by, archived_at)
                   values ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'document', 'web_upload',
                    'cases/30000000-0000-4000-8000-000000000001/tasks/40000000-0000-4000-8000-000000000001/' || repeat('5a', 32) || '.pdf',
                    repeat('5a', 32), '10000000-0000-4000-8000-0000000000a1', now())$$,
    '42501', null::text, 'staff cannot insert pre-archived evidence');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
update public.evidence set cloud_purged_at = now() where id = '80000000-0000-4000-8000-000000000001';  -- no policy: 0 rows
reset role;
set local request.jwt.claims to '';

set local role service_role;
select lives_ok($$update public.evidence set archived_at = now() - interval '1 day', archive_location = 'archive://box-1/ev1',
                    archive_sha256_verified = true where id = '80000000-0000-4000-8000-000000000001'$$,
    'service role (archive job) sets archive fields');
select throws_ok($$update public.evidence set archive_location = 'archive://box-2/ev1' where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'archive_location is set-once');
select throws_ok($$update public.evidence set archive_sha256_verified = false where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'archive_sha256_verified is set-once');
select throws_ok($$update public.evidence set sha256 = repeat('ee', 32) where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'service role still cannot change core fields');
select throws_ok($$delete from public.evidence where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'service role still cannot delete evidence rows');
select throws_ok($$update public.evidence set cloud_purged_at = now() where id = '80000000-0000-4000-8000-000000000002'$$,
    '23514', null::text, 'cannot mark purged without a verified archive');
-- ev2 archived but NOT verified
update public.evidence set archived_at = now() - interval '1 day', archive_location = 'archive://box-1/ev2',
       archive_sha256_verified = false where id = '80000000-0000-4000-8000-000000000002';

-- =====================================================================
-- Purge candidates
-- =====================================================================
-- c1 has a submission (fixture) at now(); its task t1 is open.
select is_empty($$select 1 from public.evidence_purge_candidates(7)$$, 'not eligible: submission too recent and task open');
reset role;
update public.submissions set submitted_at = now() - interval '10 days' where case_id = '30000000-0000-4000-8000-000000000001';
update public.tasks set status = 'completed' where case_id = '30000000-0000-4000-8000-000000000001';
set local role service_role;
select results_eq($$select evidence_id from public.evidence_purge_candidates(7)$$,
    $$values ('80000000-0000-4000-8000-000000000001'::uuid)$$,
    'eligible: archived + verified, submission older than 7 days (unverified ev2 excluded)');
select is_empty($$select 1 from public.evidence_purge_candidates(30)$$, 'p_days respected');
reset role;
insert into public.tasks (case_id, kind, title, assignee_id, status)
values ('30000000-0000-4000-8000-000000000001', 're_investigation', 'Re-visit', '10000000-0000-4000-8000-0000000000f1', 'pending');
set local role service_role;
select is_empty($$select 1 from public.evidence_purge_candidates(7)$$, 'not eligible while a re-investigation task is open');
reset role;
update public.tasks set status = 'cancelled' where kind = 're_investigation' and case_id = '30000000-0000-4000-8000-000000000001';
-- closed case without a submission is never eligible
update public.cases set status = 'closed' where id = '30000000-0000-4000-8000-000000000002';
insert into public.evidence (case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by,
                             archived_at, archive_location, archive_sha256_verified)
values ('30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'photo', 'camera',
        'cases/30000000-0000-4000-8000-000000000002/tasks/40000000-0000-4000-8000-000000000002/' || repeat('6a', 32) || '.jpg',
        repeat('6a', 32), '10000000-0000-4000-8000-0000000000f1', now() - interval '30 days', 'archive://box-1/ev3', true);
set local role service_role;
select results_eq($$select evidence_id from public.evidence_purge_candidates(7)$$,
    $$values ('80000000-0000-4000-8000-000000000001'::uuid)$$,
    'closed case without a submission is not eligible');
select lives_ok($$update public.evidence set cloud_purged_at = now() where id = '80000000-0000-4000-8000-000000000001'$$,
    'archive job marks the cloud copy purged');
select throws_ok($$update public.evidence set cloud_purged_at = now() + interval '1 hour' where id = '80000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'cloud_purged_at is set-once');
select is_empty($$select 1 from public.evidence_purge_candidates(7)$$, 'purged evidence is no longer a candidate');
reset role;
select ok(not has_function_privilege('authenticated', 'public.evidence_purge_candidates(integer)', 'execute'),
    'authenticated cannot call evidence_purge_candidates');
select ok(has_function_privilege('service_role', 'public.evidence_purge_candidates(integer)', 'execute'),
    'service role can call evidence_purge_candidates');

select * from finish();
rollback;
