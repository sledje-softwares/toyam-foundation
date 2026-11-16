-- device_derivative_target (20261117300000): which originals the caller may attach shrunk copies to,
-- which copies are already recorded, and whether uploads are allowed. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','26500000-0000-4000-8000-0000000000b1','authenticated','authenticated','dd-off@example.com',null,'{"role":"office","full_name":"DD Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','26500000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870002601','{"role":"field","full_name":"DD Field One"}','{}'),
 ('00000000-0000-0000-0000-000000000000','26500000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870002602','{"role":"field","full_name":"DD Field Two"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('26600000-0000-4000-8000-000000000001', 'DD Insurer', 'DDI', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('26700000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000001', 'DD-1', 'motor');
insert into public.tasks (id, case_id, title, assignee_id)
values ('26800000-0000-4000-8000-000000000001', '26700000-0000-4000-8000-000000000001', 'Garage visit', '26500000-0000-4000-8000-0000000000f1');

create temp table t_files (k text primary key, v jsonb) on commit drop;
insert into t_files
select k, jsonb_build_object('evidence_type', t, 'capture_source', 'camera', 'sha256', sha, 'mime_type', m,
          'size_bytes', 1000, 'device_captured_at', now() - interval '1 minute', 'category_code', null,
          'storage_path', 'cases/26700000-0000-4000-8000-000000000001/tasks/26800000-0000-4000-8000-000000000001/' || sha || '.' || x)
  from (values ('p1', 'photo', repeat('b1', 32), 'image/jpeg', 'jpg'),
               ('p2', 'photo', repeat('b2', 32), 'image/jpeg', 'jpg'),
               ('d1', 'document', repeat('b3', 32), 'application/pdf', 'pdf')) f (k, t, sha, m, x);
grant select on t_files to authenticated;

select ok(not has_function_privilege('anon', 'public.device_derivative_target(uuid,text[])', 'execute'), 'anon cannot call it');

set local role authenticated;
set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$select public.post_thread_message('26700000-0000-4000-8000-000000000001', '26900000-0000-4000-8000-000000000001',
                  'media', null, '26800000-0000-4000-8000-000000000001', null, (select jsonb_agg(v order by k) from t_files))$$,
    'the operator stored two photos and a document');
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32), repeat('b3', 32), repeat('00', 32)])) -> 'originals',
    jsonb_build_object(repeat('b1', 32), '[]'::jsonb), 'only photos of the caller are listed (no document, no unknown hash), none recorded yet');
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32)])) ->> 'case_id',
    '26700000-0000-4000-8000-000000000001', 'the task''s case is returned');
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32)])) ->> 'allowed', 'true', 'allowed on an open task');
select lives_ok($$select public.record_device_derivative('26700000-0000-4000-8000-000000000001', repeat('b1', 32), 384,
                  'derived/26700000-0000-4000-8000-000000000001/' || repeat('b1', 32) || '/w384-' || repeat('c', 64) || '.jpg',
                  repeat('c', 64), 3000, 384, 288)$$, 'a copy is recorded');
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32), repeat('b2', 32)])) -> 'originals',
    jsonb_build_object(repeat('b1', 32), '[384]'::jsonb, repeat('b2', 32), '[]'::jsonb), 'recorded widths are reported per original');

select throws_ok($$select public.device_derivative_target('26800000-0000-4000-8000-000000000001', array['ABC'])$$, '22023', null::text, 'malformed hash rejected');
select throws_ok($$select public.device_derivative_target('26800000-0000-4000-8000-000000000001', '{}'::text[])$$, '22023', null::text, 'empty list rejected');

set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok($$select public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32)])$$,
    '42501', null::text, 'an operator without the task learns nothing');

set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b1', 32)])$$,
    '42501', null::text, 'staff do not upload copies');

-- the task moves to f2: f1 keeps the D43 window, f2 does not own the photos
reset role;
update public.tasks set assignee_id = '26500000-0000-4000-8000-0000000000f2' where id = '26800000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b2', 32)])) ->> 'allowed', 'true',
    'the previous assignee is inside the late window');
set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b2', 32)])) -> 'originals', '{}'::jsonb,
    'the new assignee does not own the photos');

reset role;
update public.task_holds set held_from = now() - interval '200 hours', held_until = now() - interval '100 hours'
 where profile_id = '26500000-0000-4000-8000-0000000000f1' and task_id = '26800000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"26500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((public.device_derivative_target('26800000-0000-4000-8000-000000000001', array[repeat('b2', 32)])) ->> 'allowed', 'false',
    'not allowed once the late window has passed');

select * from finish();
rollback;
