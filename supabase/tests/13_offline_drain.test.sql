-- D43 (20261114400000_offline_drain.sql): task holds, late uploads after a task closed or was
-- reassigned, deactivation time, field devices and the remote-sign-out drain, outbox status.
-- Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(70);

-- ---------------------------------------------------------------------
-- Fixture (prefix 1d/2d/3d...): a1 admin, b1 office, f1/f2/f3 field; insurer DRN; case C;
-- task T1 for f1 (later reassigned to f2), task T3 for f3 (f3 is deactivated later).
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000a1','authenticated','authenticated','d-admin@example.com',null,'{"role":"admin","full_name":"D Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000b1','authenticated','authenticated','d-off@example.com',null,'{"role":"office","full_name":"D Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919860000001','{"role":"field","full_name":"Ravi Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919860000002','{"role":"field","full_name":"Mohan Field"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1d000000-0000-4000-8000-0000000000f3','authenticated','authenticated',null,'919860000003','{"role":"field","full_name":"Dev Field"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('2d000000-0000-4000-8000-000000000001', 'Drain Insurer', 'DRN', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('3d200000-0000-4000-8000-000000000001', '2d000000-0000-4000-8000-000000000001', 'DRN-1', 'motor');
insert into public.tasks (id, case_id, title, assignee_id) values
 ('3d300000-0000-4000-8000-000000000001', '3d200000-0000-4000-8000-000000000001', 'Garage visit', '1d000000-0000-4000-8000-0000000000f1'),
 ('3d300000-0000-4000-8000-000000000003', '3d200000-0000-4000-8000-000000000001', 'Spot visit',   '1d000000-0000-4000-8000-0000000000f3');

-- files: key -> items json (task, sha, device capture time relative to the transaction clock)
create temp table t_items (k text primary key, v jsonb) on commit drop;
insert into t_items
select k, jsonb_build_array(jsonb_build_object(
          'evidence_type', 'photo', 'capture_source', 'gallery', 'sha256', sha, 'mime_type', 'image/jpeg', 'size_bytes', 1000,
          'storage_path', 'cases/3d200000-0000-4000-8000-000000000001/tasks/' || task || '/' || sha || '.jpg',
          'device_captured_at', at))
  from (values
    ('late_ok',      '3d300000-0000-4000-8000-000000000001', repeat('d1', 32), now() - interval '2 days'),
    ('late_after',   '3d300000-0000-4000-8000-000000000001', repeat('d2', 32), now() - interval '12 hours'),
    ('late_before',  '3d300000-0000-4000-8000-000000000001', repeat('d3', 32), now() - interval '6 days'),
    ('late_auto',    '3d300000-0000-4000-8000-000000000001', repeat('d4', 32), now() - interval '3 days'),
    ('late_future',  '3d300000-0000-4000-8000-000000000001', repeat('d5', 32), now() + interval '1 hour'),
    ('late_grace',   '3d300000-0000-4000-8000-000000000001', repeat('d6', 32), now() - interval '5 days'),
    ('drain_ok',     '3d300000-0000-4000-8000-000000000003', repeat('e1', 32), now() - interval '2 days'),
    ('drain_after',  '3d300000-0000-4000-8000-000000000003', repeat('e2', 32), now() - interval '12 hours'),
    ('drain_late',   '3d300000-0000-4000-8000-000000000003', repeat('e3', 32), now() - interval '9 days')
  ) x (k, task, sha, at);
insert into t_items values
 ('no_time', jsonb_build_array(jsonb_build_object('evidence_type', 'photo', 'capture_source', 'camera', 'sha256', repeat('d7', 32),
   'storage_path', 'cases/3d200000-0000-4000-8000-000000000001/tasks/3d300000-0000-4000-8000-000000000001/' || repeat('d7', 32) || '.jpg'))),
 ('bad_path', jsonb_build_array(jsonb_build_object('evidence_type', 'photo', 'capture_source', 'camera', 'sha256', repeat('d8', 32),
   'storage_path', 'elsewhere/' || repeat('d8', 32) || '.jpg', 'device_captured_at', now() - interval '2 days')));
grant select on t_items to authenticated, service_role;

-- =====================================================================
-- C. Task holds
-- =====================================================================
select is((select count(*)::int from public.task_holds where task_id = '3d300000-0000-4000-8000-000000000001' and held_until is null
           and profile_id = '1d000000-0000-4000-8000-0000000000f1'), 1, 'new task opens a hold for its assignee');
update public.tasks set assignee_id = '1d000000-0000-4000-8000-0000000000f2' where id = '3d300000-0000-4000-8000-000000000001';
select is((select held_until from public.task_holds where task_id = '3d300000-0000-4000-8000-000000000001'
           and profile_id = '1d000000-0000-4000-8000-0000000000f1'), now(), 'reassignment closes the old hold at server time');
select is((select count(*)::int from public.task_holds where task_id = '3d300000-0000-4000-8000-000000000001' and held_until is null
           and profile_id = '1d000000-0000-4000-8000-0000000000f2'), 1, 'reassignment opens a hold for the new assignee');
select is((select count(*)::int from public.task_holds where task_id = '3d300000-0000-4000-8000-000000000001'), 2, 'one row per holder');

-- backdate: f1 held T1 from 5 days ago until 1 day ago; f3 holds T3 from 5 days ago
update public.task_holds set held_from = now() - interval '5 days', held_until = now() - interval '1 day'
 where task_id = '3d300000-0000-4000-8000-000000000001' and profile_id = '1d000000-0000-4000-8000-0000000000f1';
update public.task_holds set held_from = now() - interval '5 days'
 where task_id = '3d300000-0000-4000-8000-000000000003';

set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select ok((select count(*) from public.task_holds) >= 3, 'staff read task holds');
select throws_ok($$insert into public.task_holds (task_id, profile_id) values ('3d300000-0000-4000-8000-000000000001', '1d000000-0000-4000-8000-0000000000b1')$$,
    '42501', null::text, 'staff cannot write task holds');
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.task_holds), 0, 'field users read no task holds');

-- =====================================================================
-- D/E. Late uploads (f1, task T1 reassigned to f2 one day ago, grace 72 h)
-- =====================================================================
select ok(public.can_upload_evidence_at('3d300000-0000-4000-8000-000000000001', now() - interval '2 days'),
    'presigner check: capture inside the old hold is allowed');
select ok(not public.can_upload_evidence_at('3d300000-0000-4000-8000-000000000001', now() - interval '12 hours'),
    'presigner check: capture after the reassignment is refused');
select ok(not public.can_upload_evidence('3d300000-0000-4000-8000-000000000001'), 'old open-task check stays false for f1');

select lives_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001',
    'media', 'Garage photos from yesterday', '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_ok'))$$,
    'late upload inside the window is accepted');
reset role;
select is((select captured_by from public.evidence where sha256 = repeat('d1', 32)), '1d000000-0000-4000-8000-0000000000f1'::uuid,
    'late file is captured by the original holder');
select is((select task_id from public.evidence where sha256 = repeat('d1', 32)), '3d300000-0000-4000-8000-000000000001'::uuid,
    'late file is attached to the task it was captured for');
select is((select m.visibility || '/' || m.sender_id from public.case_messages m where m.client_message_id = '4d000000-0000-4000-8000-000000000001'),
    'all/1d000000-0000-4000-8000-0000000000f1', 'late message is an ordinary thread message (not marked in the UI)');
select ok(exists (select 1 from public.audit_log a where a.action = 'LATE_UPLOAD' and a.actor_id = '1d000000-0000-4000-8000-0000000000f1'
                  and a.record_id = (select id from public.evidence where sha256 = repeat('d1', 32))
                  and a.new_data ? 'held_until'), 'late upload is written to the audit log');
select is((select status::text from public.tasks where id = '3d300000-0000-4000-8000-000000000001'), 'pending',
    'a late upload does not change the task status');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
create temp table t_retry on commit drop as
    select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000001',
        'media', 'again', '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_ok')) as id;
select ok((select id from t_retry) is not null, 'late upload retry succeeds (the reassigned operator can no longer read the thread)');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000002',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_after'))$$,
    '42501', 'File captured outside the upload window', 'capture after the reassignment is refused');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000003',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_before'))$$,
    '42501', 'File captured outside the upload window', 'capture before the hold started (task creation) is refused');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000004',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_future'))$$,
    '42501', 'File captured outside the upload window', 'capture time in the future is refused');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000005',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'no_time'))$$,
    '42501', 'File captured outside the upload window', 'late file without a capture time is refused');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000006',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'bad_path'))$$,
    '22023', null::text, 'late file with a foreign storage path is refused');
select lives_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000007',
    'media', null, null, null, (select v from t_items where k = 'late_auto'))$$,
    'without a task id the late path finds the task the files were captured for');
select lives_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000008',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_ok'))$$,
    'a file already stored is skipped, not an error');
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-000000000009',
    'text', 'hello', '3d300000-0000-4000-8000-000000000001')$$,
    '23514', null::text, 'reassigned operator cannot post text on the case (task no longer visible)');
select throws_ok($$select private.post_field_files('1d000000-0000-4000-8000-0000000000f2', 'late', null, '3d200000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'media', null, null, null, '[]')$$, '42501', null::text, 'field users cannot call the shared insert path');
reset role;
select is((select id from t_retry), (select id from public.case_messages where client_message_id = '4d000000-0000-4000-8000-000000000001'),
    'late upload retry returned the stored message');
select ok(exists (select 1 from public.audit_log where action = 'LATE_UPLOAD_DUPLICATE' and actor_id = '1d000000-0000-4000-8000-0000000000f1'),
    'skipped duplicate is audited');
select is((select count(*)::int from public.evidence where sha256 = repeat('d4', 32) and task_id = '3d300000-0000-4000-8000-000000000001'), 1,
    'auto-picked late task is T1');

-- grace window over: hold ended 4 days ago
update public.task_holds set held_from = now() - interval '10 days', held_until = now() - interval '4 days'
 where task_id = '3d300000-0000-4000-8000-000000000001' and profile_id = '1d000000-0000-4000-8000-0000000000f1';
set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.post_thread_message('3d200000-0000-4000-8000-000000000001', '4d000000-0000-4000-8000-00000000000a',
    'media', null, '3d300000-0000-4000-8000-000000000001', null, (select v from t_items where k = 'late_grace'))$$,
    '42501', 'File captured outside the upload window', 'after 72 h the late upload is refused');
select ok(not public.can_upload_evidence_at('3d300000-0000-4000-8000-000000000001', now() - interval '5 days'),
    'presigner check refuses after the grace window');
-- the new holder f2 still uses the normal open-task path
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select ok(public.can_upload_evidence_at('3d300000-0000-4000-8000-000000000001', null), 'current holder passes the open-task rule');
reset role;

-- =====================================================================
-- F. Devices (f3 registers while active)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f3","role":"authenticated"}';
select lives_ok($$select public.register_field_device('5d000000-0000-4000-8000-000000000003',
    encode(extensions.digest(repeat('ab', 32), 'sha256'), 'hex'))$$, 'active operator registers a device');
select lives_ok($$select public.register_field_device('5d000000-0000-4000-8000-000000000003',
    encode(extensions.digest(repeat('ab', 32), 'sha256'), 'hex'))$$, 'registering again is idempotent');
select throws_ok($$select public.register_field_device('5d000000-0000-4000-8000-000000000004', 'not-a-hash')$$,
    '22023', null::text, 'secret hash must be SHA-256 hex');
select throws_ok($$select * from public.field_devices$$, '42501', null::text, 'field users cannot read field_devices');
select lives_ok($$select public.report_outbox_status('5d000000-0000-4000-8000-000000000003', 12, 24000000, now() - interval '2 days')$$,
    'operator reports the outbox of the own device');
select throws_ok($$select public.report_outbox_status('5d000000-0000-4000-8000-000000000003', -1, 0)$$,
    '22023', null::text, 'negative counts are refused');
select throws_ok($$select public.drain_status('5d000000-0000-4000-8000-000000000003', repeat('ab', 32))$$,
    '42501', null::text, 'drain functions are not callable with a user JWT');
select is((select count(*)::int from public.device_outbox_status), 1, 'field user reads the own outbox row');
select throws_ok($$update public.device_outbox_status set pending_count = 0$$, '42501', null::text, 'outbox rows are not writable directly');

set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.register_field_device('5d000000-0000-4000-8000-000000000003',
    encode(extensions.digest(repeat('cd', 32), 'sha256'), 'hex'))$$, '42501', null::text, 'another operator cannot take over a device id');
select throws_ok($$select public.report_outbox_status('5d000000-0000-4000-8000-000000000003', 0, 0)$$,
    '42501', null::text, 'another operator cannot report for a foreign device');
select is((select count(*)::int from public.device_outbox_status), 0, 'field users cannot read other operators'' outbox rows');
select is((select count(*)::int from public.case_outbox_status('3d200000-0000-4000-8000-000000000001')), 0,
    'case outbox status shows a field user nobody else');

set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select results_eq($$select full_name, pending_count, pending_bytes, reported_at from public.case_outbox_status('3d200000-0000-4000-8000-000000000001')$$,
    $$values ('Dev Field'::text, 12, 24000000::bigint, now())$$, 'staff see files waiting on an operator''s phone, server-stamped');
reset role;
set local role anon;
select throws_ok($$select public.case_outbox_status('3d200000-0000-4000-8000-000000000001')$$, '42501', null::text, 'anon cannot read outbox status');
reset role;

set local role service_role;
select is((select state from public.drain_status('5d000000-0000-4000-8000-000000000003', repeat('ab', 32))), 'active',
    'drain status of an active operator is active');
select throws_ok($$select public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    gen_random_uuid(), 'media', null, '3d300000-0000-4000-8000-000000000003', null, (select v from t_items where k = 'drain_ok'))$$,
    '42501', 'Operator is active; use the normal upload path', 'no drain while the operator is active');
reset role;

-- =====================================================================
-- B. Deactivation time
-- =====================================================================
update public.profiles set is_active = false where id = '1d000000-0000-4000-8000-0000000000f3';
select is((select deactivated_at from public.profiles where id = '1d000000-0000-4000-8000-0000000000f3'), now(),
    'deactivation is stamped with server time');
set local role authenticated;
set local request.jwt.claims to '{"sub":"1d000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok($$update public.profiles set deactivated_at = now() + interval '1 year' where id = '1d000000-0000-4000-8000-0000000000f3'$$,
    '42501', 'deactivated_at is set by the server', 'admins cannot move the deactivation time');
reset role;
-- backdate: device registered 3 days ago, deactivated 1 day ago
update public.field_devices set registered_at = now() - interval '3 days' where device_id = '5d000000-0000-4000-8000-000000000003';
update public.profiles set deactivated_at = now() - interval '1 day' where id = '1d000000-0000-4000-8000-0000000000f3';

-- =====================================================================
-- F. Drain (service role = field-drain function)
-- =====================================================================
set local role service_role;
select is((select state from public.drain_status('5d000000-0000-4000-8000-000000000003', repeat('ab', 32))), 'drain',
    'deactivated operator''s device is in drain mode');
select throws_ok($$select public.drain_status('5d000000-0000-4000-8000-000000000003', repeat('cd', 32))$$,
    '42501', 'Unknown device', 'wrong secret is refused like an unknown device');
select is(public.drain_authorize_upload('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d300000-0000-4000-8000-000000000003',
    repeat('e1', 32), now() - interval '2 days'), '3d200000-0000-4000-8000-000000000001'::uuid, 'presign allowed for a file captured before deactivation');
select throws_ok($$select public.drain_authorize_upload('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d300000-0000-4000-8000-000000000003',
    repeat('e2', 32), now() - interval '12 hours')$$, '42501', 'File captured outside the upload window', 'presign refused for a file captured after deactivation');
select lives_ok($$select public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    '4d000000-0000-4000-8000-0000000000e1', 'media', 'Spot photos', '3d300000-0000-4000-8000-000000000003', null, (select v from t_items where k = 'drain_ok'))$$,
    'drain accepts a file captured before deactivation');
select throws_ok($$select public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    '4d000000-0000-4000-8000-0000000000e2', 'media', null, '3d300000-0000-4000-8000-000000000003', null, (select v from t_items where k = 'drain_after'))$$,
    '42501', 'File captured outside the upload window', 'drain refuses a file captured after deactivation');
select throws_ok($$select public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    '4d000000-0000-4000-8000-0000000000e3', 'text', 'hello', '3d300000-0000-4000-8000-000000000003')$$,
    '22023', null::text, 'drain carries files only');
select lives_ok($$select public.drain_report_outbox('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), 1, 2000, now() - interval '12 hours')$$,
    'drained phone reports its outbox');
reset role;
select ok(exists (select 1 from public.audit_log where action = 'DRAIN_UPLOAD' and actor_id = '1d000000-0000-4000-8000-0000000000f3'
                  and new_data->>'device_id' = '5d000000-0000-4000-8000-000000000003'
                  and record_id = (select id from public.evidence where sha256 = repeat('e1', 32))), 'drained file is audited with the device');
select ok(exists (select 1 from public.audit_log where action = 'DRAIN_PRESIGN' and actor_id = '1d000000-0000-4000-8000-0000000000f3'),
    'drain presign is audited');
select is((select captured_by from public.evidence where sha256 = repeat('e1', 32)), '1d000000-0000-4000-8000-0000000000f3'::uuid,
    'drained file is captured by the deactivated operator');

-- window over: deactivated 8 days ago
update public.profiles set deactivated_at = now() - interval '8 days' where id = '1d000000-0000-4000-8000-0000000000f3';
update public.field_devices set registered_at = now() - interval '12 days' where device_id = '5d000000-0000-4000-8000-000000000003';
update public.task_holds set held_from = now() - interval '14 days' where task_id = '3d300000-0000-4000-8000-000000000003';
set local role service_role;
select is((select state from public.drain_status('5d000000-0000-4000-8000-000000000003', repeat('ab', 32))), 'closed',
    'after 7 days the drain is closed');
select throws_ok($$select public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    '4d000000-0000-4000-8000-0000000000e4', 'media', null, '3d300000-0000-4000-8000-000000000003', null, (select v from t_items where k = 'drain_late'))$$,
    '42501', 'The sending window after sign-out has closed', 'drain refused after the window');
select is(public.drain_post_message('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), '3d200000-0000-4000-8000-000000000001',
    '4d000000-0000-4000-8000-0000000000e1', 'media', 'Spot photos', '3d300000-0000-4000-8000-000000000003', null, (select v from t_items where k = 'drain_ok')),
    (select id from public.case_messages where client_message_id = '4d000000-0000-4000-8000-0000000000e1'),
    'retry of a stored drained message still returns its id');
select lives_ok($$select public.drain_finish('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), 0)$$, 'drain finish');
select lives_ok($$select public.drain_finish('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), 0)$$, 'drain finish is idempotent');
select throws_ok($$select public.drain_report_outbox('5d000000-0000-4000-8000-000000000003', repeat('ab', 32), 1, 1)$$,
    '42501', 'This device has finished sending', 'finished device cannot report again');
reset role;
select is((select pending_count from public.device_outbox_status where device_id = '5d000000-0000-4000-8000-000000000003'), 0,
    'finish clears the outbox count');

-- reactivation clears the deactivation time
update public.profiles set is_active = true where id = '1d000000-0000-4000-8000-0000000000f3';
select is((select deactivated_at from public.profiles where id = '1d000000-0000-4000-8000-0000000000f3'), null::timestamptz,
    'reactivation clears deactivated_at');

select * from finish();
rollback;
