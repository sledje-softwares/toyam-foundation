-- Signed-in presigner support (20261114500000_evidence_upload.sql): evidence_upload_target() and
-- post_thread_message skipping files already stored on the case. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1e500000-0000-4000-8000-0000000000b1','authenticated','authenticated','u-off@example.com',null,'{"role":"office","full_name":"U Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e500000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870000001','{"role":"field","full_name":"U Field One"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e500000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870000002','{"role":"field","full_name":"U Field Two"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('2e500000-0000-4000-8000-000000000001', 'Upload Insurer', 'UPL', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('3e500000-0000-4000-8000-000000000001', '2e500000-0000-4000-8000-000000000001', 'UPL-1', 'motor');
insert into public.tasks (id, case_id, title, assignee_id)
values ('3e600000-0000-4000-8000-000000000001', '3e500000-0000-4000-8000-000000000001', 'Garage visit', '1e500000-0000-4000-8000-0000000000f1');

create temp table t_files (k text primary key, v jsonb) on commit drop;
insert into t_files
select k, jsonb_build_object('evidence_type', 'photo', 'capture_source', 'camera', 'sha256', sha, 'mime_type', 'image/jpeg',
          'size_bytes', 1000, 'device_captured_at', now() - interval '1 minute', 'category_code', null,
          'storage_path', 'cases/3e500000-0000-4000-8000-000000000001/tasks/3e600000-0000-4000-8000-000000000001/' || sha || '.jpg')
  from (values ('x', repeat('a1', 32)), ('y', repeat('a2', 32))) f (k, sha);
grant select on t_files to authenticated;

-- ---------------------------------------------------------------------
select is((select prosecdef from pg_proc where oid = 'public.evidence_upload_target(uuid,text[])'::regprocedure), true,
    'evidence_upload_target is security definer');
select ok((select 'search_path=""' = any (proconfig) from pg_proc where oid = 'public.evidence_upload_target(uuid,text[])'::regprocedure),
    'evidence_upload_target pins an empty search_path');
select ok(not has_function_privilege('anon', 'public.evidence_upload_target(uuid,text[])', 'execute'), 'anon cannot call it');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1e500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select results_eq($$select case_id, stored_sha256 from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', array[repeat('a1', 32)])$$,
    $$values ('3e500000-0000-4000-8000-000000000001'::uuid, '{}'::text[])$$, 'assignee gets the case and no stored hashes');
select throws_ok($$select * from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', array['ABC'])$$,
    '22023', null::text, 'malformed hash rejected');
select throws_ok($$select * from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', '{}'::text[])$$,
    '22023', null::text, 'empty list rejected');
select throws_ok($$select * from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001',
                    array(select repeat('a1', 32) from generate_series(1, 31)))$$,
    '22023', null::text, 'more than 30 hashes rejected');

select lives_ok($$select public.post_thread_message('3e500000-0000-4000-8000-000000000001', '4e500000-0000-4000-8000-000000000001',
                  'media', null, '3e600000-0000-4000-8000-000000000001', null, (select jsonb_build_array(v) from t_files where k = 'x'))$$,
    'first upload of file x stored');
select results_eq($$select stored_sha256 from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001',
                    array[repeat('a1', 32), repeat('a2', 32)])$$,
    $$values (array[repeat('a1', 32)])$$, 'stored hashes are reported, new ones are not');

select lives_ok($$select public.post_thread_message('3e500000-0000-4000-8000-000000000001', '4e500000-0000-4000-8000-000000000002',
                  'media', 'again', '3e600000-0000-4000-8000-000000000001', null,
                  (select jsonb_agg(v order by k) from t_files))$$,
    'a message repeating an already stored file is accepted');
select is((select count(*)::int from public.evidence where case_id = '3e500000-0000-4000-8000-000000000001' and sha256 = repeat('a1', 32)),
    1, 'the repeated file is not stored twice');
select is((select message_id from public.evidence where case_id = '3e500000-0000-4000-8000-000000000001' and sha256 = repeat('a2', 32)),
    (select id from public.case_messages where client_message_id = '4e500000-0000-4000-8000-000000000002'),
    'the new file of that message is stored with it');

set local request.jwt.claims to '{"sub":"1e500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok($$select * from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', array[repeat('a1', 32)])$$,
    '42501', null::text, 'an operator without the task learns nothing');

set local request.jwt.claims to '{"sub":"1e500000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select results_eq($$select stored_sha256 from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', array[repeat('a2', 32)])$$,
    $$values (array[repeat('a2', 32)])$$, 'staff may ask');
reset role;
update public.tasks set assignee_id = '1e500000-0000-4000-8000-0000000000f2' where id = '3e600000-0000-4000-8000-000000000001';
set local role authenticated;

set local request.jwt.claims to '{"sub":"1e500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select results_eq($$select case_id from public.evidence_upload_target('3e600000-0000-4000-8000-000000000001', array[repeat('a1', 32)])$$,
    $$values ('3e500000-0000-4000-8000-000000000001'::uuid)$$, 'a former holder may still ask (late uploads, D43)');
select throws_ok($$select * from public.evidence_upload_target('3e600000-0000-4000-8000-0000000000ff', array[repeat('a1', 32)])$$,
    '42501', null::text, 'unknown task refused');

select * from finish();
rollback;
