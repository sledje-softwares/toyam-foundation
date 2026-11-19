-- Field thread attachments (20261119810000): a field operator reads the shrunk-copy rows of the evidence
-- they can see (own files, files of visible office messages) and nothing else; what the thread reads for
-- ticks (v_evidence_processing) and the unread rules of field_case_list() (own messages never count;
-- mark_thread_read clears the badge). Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','32500000-0000-4000-8000-0000000000b1','authenticated','authenticated','tf-off@example.com',null,'{"role":"office","full_name":"TF Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','32500000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870003201','{"role":"field","full_name":"TF Field One"}','{}'),
 ('00000000-0000-0000-0000-000000000000','32500000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870003202','{"role":"field","full_name":"TF Field Two"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('32600000-0000-4000-8000-000000000001', 'TF Insurer', 'TFI', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, office_owner_id)
values ('32700000-0000-4000-8000-000000000001', '32600000-0000-4000-8000-000000000001', 'TF-1', 'motor', '32500000-0000-4000-8000-0000000000b1'),
       ('32700000-0000-4000-8000-000000000002', '32600000-0000-4000-8000-000000000001', 'TF-2', 'motor', '32500000-0000-4000-8000-0000000000b1');
insert into public.tasks (id, case_id, title, assignee_id)
values ('32800000-0000-4000-8000-000000000001', '32700000-0000-4000-8000-000000000001', 'Garage visit', '32500000-0000-4000-8000-0000000000f1'),
       ('32800000-0000-4000-8000-000000000002', '32700000-0000-4000-8000-000000000002', 'Spot visit', '32500000-0000-4000-8000-0000000000f2');

create temp table t_files (k text primary key, v jsonb) on commit drop;
insert into t_files
select k, jsonb_build_object('evidence_type', t, 'capture_source', 'camera', 'sha256', sha, 'mime_type', m,
          'size_bytes', 1000, 'device_captured_at', now() - interval '1 minute', 'category_code', null,
          'storage_path', 'cases/32700000-0000-4000-8000-000000000001/tasks/32800000-0000-4000-8000-000000000001/' || sha || '.' || x)
  from (values ('p1', 'photo', repeat('a1', 32), 'image/jpeg', 'jpg'),
               ('d1', 'document', repeat('a2', 32), 'application/pdf', 'pdf')) f (k, t, sha, m, x);
grant select on t_files to authenticated;

-- [1-3] the operator sends a photo and a PDF, and records both copies of the photo
set local role authenticated;
set local request.jwt.claims to '{"sub":"32500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$select public.post_thread_message('32700000-0000-4000-8000-000000000001', '32900000-0000-4000-8000-000000000001',
                  'media', 'Garage front', '32800000-0000-4000-8000-000000000001', null, (select jsonb_agg(v order by k) from t_files))$$,
    'the operator stored a photo and a document');
select lives_ok($$select public.record_device_derivative('32700000-0000-4000-8000-000000000001', repeat('a1', 32), 384,
                  'derived/32700000-0000-4000-8000-000000000001/' || repeat('a1', 32) || '/w384-' || repeat('c1', 32) || '.jpg',
                  repeat('c1', 32), 3000, 384, 288)$$, 'the 384 px copy is recorded');
select lives_ok($$select public.record_device_derivative('32700000-0000-4000-8000-000000000001', repeat('a1', 32), 1600,
                  'derived/32700000-0000-4000-8000-000000000001/' || repeat('a1', 32) || '/w1600-' || repeat('c2', 32) || '.jpg',
                  repeat('c2', 32), 90000, 1600, 1200)$$, 'the 1600 px copy is recorded');
reset role;

-- office files: one in a message to the field (visible), one in a staff-only note (hidden)
select private.post_system_message('32700000-0000-4000-8000-000000000001', 'Office photo for the field', null, 'text',
                                   '32500000-0000-4000-8000-0000000000b1', 'all');
select private.post_system_message('32700000-0000-4000-8000-000000000001', 'Staff-only photo', null, 'text',
                                   '32500000-0000-4000-8000-0000000000b1', 'staff');
insert into public.evidence (case_id, message_id, evidence_type, capture_source, storage_path, mime_type, size_bytes, sha256, captured_by)
select '32700000-0000-4000-8000-000000000001', m.id, 'photo', 'web_upload',
       'cases/32700000-0000-4000-8000-000000000001/files/' || sha || '.jpg', 'image/jpeg', 2000, sha, '32500000-0000-4000-8000-0000000000b1'
  from (values ('Office photo for the field', repeat('a3', 32)), ('Staff-only photo', repeat('a4', 32))) v (body, sha)
  join public.case_messages m on m.body = v.body and m.case_id = '32700000-0000-4000-8000-000000000001';
insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height)
select e.id, 384, private.derivative_path(e.case_id, e.sha256, 384, repeat(right(e.sha256, 2), 32)), repeat(right(e.sha256, 2), 32), 3000, 384, 288
  from public.evidence e where e.sha256 in (repeat('a3', 32), repeat('a4', 32));

-- [4-8] what the operator reads
set local role authenticated;
set local request.jwt.claims to '{"sub":"32500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select array_agg(d.width order by d.width) from public.evidence_derivatives d
             join public.evidence e on e.id = d.evidence_id where e.sha256 = repeat('a1', 32)),
    array[384, 1600], 'the operator reads both copy rows of their own photo');
select is((select count(*)::int from public.evidence_derivatives d join public.evidence e on e.id = d.evidence_id
            where e.sha256 = repeat('a3', 32)), 1, 'and the copy of a photo the office posted to the field');
select is((select count(*)::int from public.evidence_derivatives), 3, 'no copy of a staff-only file (rule 4, D32)');
select is((select count(*)::int from public.evidence where sha256 = repeat('a4', 32)), 0, 'the staff-only file itself stays hidden');
select is((select count(*)::int from public.v_evidence_processing p join public.evidence e on e.id = p.evidence_id
            where e.message_id = (select id from public.case_messages where client_message_id = '32900000-0000-4000-8000-000000000001')),
    2, 'processing states of the operator''s message files are readable (✓✓)');
select is((select array_agg(e.sha256 order by e.sha256) from public.evidence e
            where e.message_id = (select id from public.case_messages where client_message_id = '32900000-0000-4000-8000-000000000001')),
    array[repeat('a1', 32), repeat('a2', 32)], 'the message''s files are found by message_id');

-- [9-10] no writes
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   select e.id, 384, 'x', repeat('dd', 32) from public.evidence e where e.sha256 = repeat('a2', 32)$$,
    '42501', null::text, 'field users cannot insert copy rows directly');

-- another operator on another case
set local request.jwt.claims to '{"sub":"32500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_derivatives), 0, 'an operator without a task on the case reads no copies');

-- [11] staff read as before
set local request.jwt.claims to '{"sub":"32500000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_derivatives), 4, 'the case owner reads every copy');
reset role;

-- [12-17] unread badge: own messages never count; mark_thread_read clears it
insert into public.case_thread_reads (case_id, user_id, last_read_at)
values ('32700000-0000-4000-8000-000000000001', '32500000-0000-4000-8000-0000000000f1', now() - interval '1 hour');
set local role authenticated;
set local request.jwt.claims to '{"sub":"32500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
-- visible since the last read: the system "Field work assigned" message and the office's message to the field
select is((select unread_count from public.field_case_list() where case_id = '32700000-0000-4000-8000-000000000001'),
    2, 'office and system messages since the last read count');
select is((select count(*)::int from public.case_messages where case_id = '32700000-0000-4000-8000-000000000001'
              and sender_id = '32500000-0000-4000-8000-0000000000f1'), 1, 'the operator''s own message is in the thread');
select lives_ok($$select public.post_thread_message('32700000-0000-4000-8000-000000000001', '32900000-0000-4000-8000-000000000002',
                  'text', 'Reached the garage', null, null, '[]'::jsonb)$$, 'the operator sends a text message');
select is((select unread_count from public.field_case_list() where case_id = '32700000-0000-4000-8000-000000000001'),
    2, 'own messages do not raise the badge (gap 9)');
select lives_ok($$select public.mark_thread_read('32700000-0000-4000-8000-000000000001')$$, 'the app marks the thread read when it is open');
select is((select unread_count from public.field_case_list() where case_id = '32700000-0000-4000-8000-000000000001'),
    0, 'the badge is cleared');
reset role;

select * from finish();
rollback;
