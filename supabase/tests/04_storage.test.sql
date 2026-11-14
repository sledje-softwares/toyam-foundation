-- Supabase Storage buckets and storage.objects policies (email-raw, reports)
-- Self-contained: fixture below is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

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

-- D44: the office user owns c1 (its email and report objects); c2, c3 are unassigned
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'FIX-1', 'health', 'assigned', '10000000-0000-4000-8000-0000000000a3'),
       ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'FIX-2', 'motor',  'field_in_progress', null),
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

insert into public.emails (id, gmail_message_id, from_address, received_at, case_id, raw_storage_path)
values ('60000000-0000-4000-8000-000000000001', 'fixture-msg-1', 'a@fixture.example', now(), '30000000-0000-4000-8000-000000000001',
        'emails/60000000-0000-4000-8000-000000000001/message.eml');
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

-- Objects created by the owner (as the intake service / a staff upload would)
insert into storage.objects (bucket_id, name, owner_id)
values ('email-raw', 'emails/60000000-0000-4000-8000-000000000001/message.eml', null),
       ('reports',   'cases/30000000-0000-4000-8000-000000000001/report-v1.docx', '10000000-0000-4000-8000-0000000000a3');

select results_eq($$select id, public from storage.buckets order by id$$,
    $$values ('email-raw'::text, false), ('report-templates', false), ('reports', false)$$,
    'only the private email-raw, report-templates and reports buckets exist (evidence files live in R2)');
select ok((select 'application/pdf' = any(allowed_mime_types) and not 'text/html' = any(allowed_mime_types)
             from storage.buckets where id = 'reports'), 'reports MIME allow-list');

-- =====================================================================
-- Field user 1: nothing in either bucket
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is_empty($$select 1 from storage.objects$$, 'field cannot see email-raw or report objects');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('reports', 'x.docx', '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'field cannot write reports');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('email-raw', 'x.eml', '10000000-0000-4000-8000-0000000000f1')$$,
    '42501', null::text, 'field cannot write email-raw');
-- let the statement reach RLS (the Storage API sets this flag itself)
set local storage.allow_delete_query = 'true';
update storage.objects set metadata = '{"x":1}';
delete from storage.objects;

-- =====================================================================
-- Office (staff)
-- =====================================================================
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'email-raw'), 1, 'staff read email-raw');
select is((select count(*)::int from storage.objects where bucket_id = 'reports'), 1, 'staff read reports');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('email-raw', 'emails/x/y.eml', '10000000-0000-4000-8000-0000000000a3')$$,
    '42501', null::text, 'staff cannot write email-raw (service role only)');
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('reports', 'cases/30000000-0000-4000-8000-000000000001/report-v2.docx', '10000000-0000-4000-8000-0000000000a3')$$,
    'staff can upload reports');
select lives_ok($$update storage.objects set metadata = '{"note":"x"}' where bucket_id = 'reports'$$, 'staff can update reports');
update storage.objects set metadata = '{"x":1}' where bucket_id = 'email-raw';
delete from storage.objects;

-- =====================================================================
-- Owner checks
-- =====================================================================
reset role;
set local request.jwt.claims to '';
select is((select count(*)::int from storage.objects where bucket_id = 'email-raw' and metadata is null), 1,
    'field and staff could not modify or delete email-raw objects');
select is((select count(*)::int from storage.objects where bucket_id = 'reports'), 2, 'reports are not deletable via the API');

select * from finish();
rollback;
