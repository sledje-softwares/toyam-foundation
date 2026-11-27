-- File comments (20261127100000, D54): a field operator with a task comments on files they can see in the
-- case thread; idempotent on client_comment_id; other operators, staff-only and withdrawn files refused;
-- staff read in scope (D44); append-only; the file's label job is re-queued (and a running one re-queued
-- when it finishes); field users read labels + LLM description but never OCR. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','33500000-0000-4000-8000-0000000000b1','authenticated','authenticated','ec-off@example.com',null,'{"role":"office","full_name":"EC Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','33500000-0000-4000-8000-0000000000b2','authenticated','authenticated','ec-off2@example.com',null,'{"role":"office","full_name":"EC Office Two"}','{}'),
 ('00000000-0000-0000-0000-000000000000','33500000-0000-4000-8000-0000000000c1','authenticated','authenticated','ec-orch@example.com',null,'{"role":"orchestrator","full_name":"EC Orchestrator"}','{}'),
 ('00000000-0000-0000-0000-000000000000','33500000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870003301','{"role":"field","full_name":"EC Field One"}','{}'),
 ('00000000-0000-0000-0000-000000000000','33500000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870003302','{"role":"field","full_name":"EC Field Two"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('33600000-0000-4000-8000-000000000001', 'EC Insurer', 'ECI', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, office_owner_id)
values ('33700000-0000-4000-8000-000000000001', '33600000-0000-4000-8000-000000000001', 'EC-1', 'motor', '33500000-0000-4000-8000-0000000000b1'),
       ('33700000-0000-4000-8000-000000000002', '33600000-0000-4000-8000-000000000001', 'EC-2', 'motor', '33500000-0000-4000-8000-0000000000b1');
insert into public.tasks (id, case_id, title, assignee_id)
values ('33800000-0000-4000-8000-000000000001', '33700000-0000-4000-8000-000000000001', 'Garage visit', '33500000-0000-4000-8000-0000000000f1'),
       ('33800000-0000-4000-8000-000000000002', '33700000-0000-4000-8000-000000000002', 'Spot visit', '33500000-0000-4000-8000-0000000000f2');
insert into public.evidence_categories (id, code, name) values ('33a00000-0000-4000-8000-000000000001', 'ec_test_front', 'EC test front');

create temp table t_files (k text primary key, v jsonb) on commit drop;
insert into t_files
select k, jsonb_build_object('evidence_type', 'photo', 'capture_source', 'camera', 'sha256', sha, 'mime_type', 'image/jpeg',
          'size_bytes', 1000, 'device_captured_at', now() - interval '1 minute', 'category_code', null,
          'storage_path', 'cases/33700000-0000-4000-8000-000000000001/tasks/33800000-0000-4000-8000-000000000001/' || sha || '.jpg')
  from (values ('p1', repeat('e1', 32)), ('p2', repeat('e2', 32))) f (k, sha);
grant select on t_files to authenticated;

create temp table t_out (k text primary key, v uuid) on commit drop;
grant all on t_out to authenticated;

-- [1-3] grants and realtime
select ok(not has_function_privilege('anon', 'public.add_evidence_comment(uuid,text,uuid)', 'execute'), 'anon cannot call add_evidence_comment');
select ok(has_function_privilege('authenticated', 'public.add_evidence_comment(uuid,text,uuid)', 'execute'), 'signed-in users can call it (the function checks the role)');
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'evidence_comments'), 'evidence_comments is in the realtime publication');

-- the operator sends p1, and p2 in a second message which they withdraw
set local role authenticated;
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select public.post_thread_message('33700000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000001',
       'media', 'Garage front', '33800000-0000-4000-8000-000000000001', null, (select jsonb_agg(v) from t_files where k = 'p1'));
select public.post_thread_message('33700000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000002',
       'media', null, '33800000-0000-4000-8000-000000000001', null, (select jsonb_agg(v) from t_files where k = 'p2'));
select public.withdraw_message((select id from public.case_messages where client_message_id = '33900000-0000-4000-8000-000000000002'));
reset role; reset request.jwt.claims;

-- office files: one in a message to the field (visible), one in a staff-only note (hidden)
select private.post_system_message('33700000-0000-4000-8000-000000000001', 'EC office photo for the field', null, 'text',
                                   '33500000-0000-4000-8000-0000000000b1', 'all');
select private.post_system_message('33700000-0000-4000-8000-000000000001', 'EC staff-only photo', null, 'text',
                                   '33500000-0000-4000-8000-0000000000b1', 'staff');
insert into public.evidence (case_id, message_id, evidence_type, capture_source, storage_path, mime_type, size_bytes, sha256, captured_by)
select '33700000-0000-4000-8000-000000000001', m.id, 'photo', 'web_upload',
       'cases/33700000-0000-4000-8000-000000000001/files/' || sha || '.jpg', 'image/jpeg', 2000, sha, '33500000-0000-4000-8000-0000000000b1'
  from (values ('EC office photo for the field', repeat('e3', 32)), ('EC staff-only photo', repeat('e4', 32))) v (body, sha)
  join public.case_messages m on m.body = v.body and m.case_id = '33700000-0000-4000-8000-000000000001';
insert into t_out select 'e' || right(e.sha256, 1), e.id from public.evidence e
 where e.sha256 in (repeat('e1', 32), repeat('e2', 32), repeat('e3', 32), repeat('e4', 32));

-- the worker already labelled p1 (job done, LLM label with a description, server OCR row)
update public.processing_jobs j set status = 'done', attempts = 1, finished_at = now() - interval '1 hour',
       locked_by = 'w1', last_error = 'old'
 where j.evidence_id = (select v from t_out where k = 'e1') and j.stage = 'label';
insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, description, model)
values ((select v from t_out where k = 'e1'), '33a00000-0000-4000-8000-000000000001', 0.9, 'llm', 'v1',
        'Front of a white hatchback, bumper dented', 'test/model');
insert into public.evidence_ocr (evidence_id, engine, text)
values ((select v from t_out where k = 'e1'), 'paddleocr', 'MH 12 AB 3456');
-- the office photo's label job is running right now (claimed a minute ago)
update public.processing_jobs j set status = 'running', attempts = 1, locked_at = now() - interval '1 minute',
       locked_by = 'w1', started_at = now() - interval '1 minute'
 where j.evidence_id = (select v from t_out where k = 'e3') and j.stage = 'label';

-- [4-12] the operator comments on their photo
set local role authenticated;
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$insert into t_out select 'c1', public.add_evidence_comment((select v from t_out where k = 'e1'),
                  '  Rear bumper dent, owner says old damage  ', '33b00000-0000-4000-8000-000000000001')$$,
    'the operator adds a comment to their photo');
select is((select body from public.evidence_comments where id = (select v from t_out where k = 'c1')),
    'Rear bumper dent, owner says old damage', 'the body is stored trimmed');
select is((select case_id from public.evidence_comments where id = (select v from t_out where k = 'c1')),
    '33700000-0000-4000-8000-000000000001'::uuid, 'case_id is taken from the file');
select is((select author_id from public.evidence_comments where id = (select v from t_out where k = 'c1')),
    '33500000-0000-4000-8000-0000000000f1'::uuid, 'the author is the caller');
select is(public.add_evidence_comment((select v from t_out where k = 'e1'), 'different text on a retry', '33b00000-0000-4000-8000-000000000001'),
    (select v from t_out where k = 'c1'), 'a retry with the same client_comment_id returns the stored id');
select is((select count(*)::int from public.evidence_comments where evidence_id = (select v from t_out where k = 'e1')), 1,
    'the retry stored nothing new');
select lives_ok($$insert into t_out select 'c2', public.add_evidence_comment((select v from t_out where k = 'e3'),
                  'Same car, other side', '33b00000-0000-4000-8000-000000000002')$$,
    'the operator comments on a file the office posted to the field');
select is((select count(*)::int from public.evidence_comments), 2, 'the operator reads the comments of files they can see');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), 'x', '33b00000-0000-4000-8000-000000000002')$$,
    '23505', 'client_comment_id is already used for another comment', 'a client_comment_id used on another file is refused');

-- [13-18] refused files and bodies
select throws_ok($$select public.add_evidence_comment('33400000-0000-4000-8000-000000000004'::uuid, 'x', gen_random_uuid())$$,
    'P0002', 'File not found', 'an unknown file is not found');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e2'), 'x', gen_random_uuid())$$,
    '55000', 'This file was withdrawn', 'a withdrawn file is refused');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), '   ', gen_random_uuid())$$,
    '22023', 'A comment needs some text', 'a blank comment is refused');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), repeat('a', 1001), gen_random_uuid())$$,
    '22023', 'A comment can be at most 1000 characters', 'a comment over 1000 characters is refused');
select lives_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), '  ' || repeat('a', 1000) || '  ', gen_random_uuid())$$,
    'a 1000-character comment (surrounding spaces trimmed) is accepted');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), 'x', null)$$,
    '22023', 'client_comment_id is required', 'client_comment_id is required');
-- [19] staff-only file
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e4'), 'x', gen_random_uuid())$$,
    'P0002', 'File not found', 'a file in a staff-only message is refused as not found (rule 4, D32)');

-- [20-22] append-only, no direct writes
select throws_ok($$insert into public.evidence_comments (evidence_id, case_id, author_id, body, client_comment_id)
                   values ((select v from t_out where k = 'e1'), '33700000-0000-4000-8000-000000000001',
                           '33500000-0000-4000-8000-0000000000f1', 'direct', gen_random_uuid())$$,
    '42501', null::text, 'a direct insert is refused');
select throws_ok($$update public.evidence_comments set body = 'edited'$$, '42501', null::text, 'field users cannot edit comments');
select throws_ok($$delete from public.evidence_comments$$, '42501', null::text, 'field users cannot delete comments');

-- [23-24] D54: labels + description readable, OCR not
select is((select description from public.evidence_labels where evidence_id = (select v from t_out where k = 'e1') and is_active),
    'Front of a white hatchback, bumper dented', 'the operator reads the label and LLM description of their file');
select is((select count(*)::int from public.evidence_ocr), 0, 'the operator still cannot read OCR (rule 4)');

-- [25-26] the comment cap: 50 per file and author
select lives_ok($o$do $d$ begin
                    for i in 2..50 loop
                      perform public.add_evidence_comment((select v from t_out where k = 'e3'), 'note ' || i, gen_random_uuid());
                    end loop; end $d$$o$, 'the operator adds up to 50 comments to one file');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e3'), 'one too many', gen_random_uuid())$$,
    '54000', 'At most 50 comments per file', 'the 51st comment on a file is refused');

-- [27-29] another operator without a task on the case
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_comments), 0, 'an operator without a task on the case reads no comments');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), 'x', gen_random_uuid())$$,
    'P0002', 'File not found', 'and cannot comment on its files');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), 'x', '33b00000-0000-4000-8000-000000000001')$$,
    '23505', 'client_comment_id is already used for another comment', 'another author cannot reuse a client_comment_id');

-- [30-33] staff
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_comments), 52, 'the case owner reads every comment');
select throws_ok($$select public.add_evidence_comment((select v from t_out where k = 'e1'), 'x', gen_random_uuid())$$,
    '42501', 'Only field operators can comment on a file', 'staff cannot add file comments');
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_comments), 0, 'an office user who does not own the case reads none (D44)');
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_comments), 52, 'the orchestrator reads every comment');
reset role; reset request.jwt.claims;

-- [34-37] label job re-queued
select is((select status::text from public.processing_jobs
            where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'), 'queued',
    'the done label job of the commented file is queued again');
select ok((select run_after > now() and attempts = 0 and locked_by is null and last_error is null and finished_at is null
             from public.processing_jobs where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'),
    'run_after is in the future, attempts and lock cleared');
select is((select status::text from public.processing_jobs
            where evidence_id = (select v from t_out where k = 'e3') and stage = 'label'), 'running',
    'a running label job is left alone when a comment arrives');
select is((select array_agg(status::text order by stage) from public.processing_jobs
            where evidence_id = (select v from t_out where k = 'e1') and stage <> 'label'),
    array['queued', 'queued'], 'other stages are untouched');

-- [38-40] the running job finishes: a comment arrived after it started, so it goes back to the queue
select lives_ok($$select public.complete_processing_job((select id from public.processing_jobs
                   where evidence_id = (select v from t_out where k = 'e3') and stage = 'label'), 'done', null)$$,
    'the worker finishes the running label job');
select ok((select status = 'queued' and attempts = 0 and run_after > now() and locked_at is null and finished_at is null
             from public.processing_jobs where evidence_id = (select v from t_out where k = 'e3') and stage = 'label'),
    'it is queued again because a comment arrived while it ran');
-- a job that started after the last comment finishes normally
update public.processing_jobs j set status = 'running', attempts = 1, locked_at = now() + interval '1 minute',
       locked_by = 'w1', started_at = now() + interval '1 minute'
 where j.evidence_id = (select v from t_out where k = 'e1') and j.stage = 'label';
select public.complete_processing_job((select id from public.processing_jobs
        where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'), 'done', null);
select is((select status::text from public.processing_jobs
            where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'), 'done',
    'a label job that started after the last comment finishes as done');

-- [41-42] skipped label job stays skipped; files without a label job get none
update public.processing_jobs j set status = 'skipped', finished_at = now()
 where j.evidence_id = (select v from t_out where k = 'e1') and j.stage = 'label';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select public.add_evidence_comment((select v from t_out where k = 'e1'), 'after skip', gen_random_uuid());
reset role; reset request.jwt.claims;
select is((select status::text from public.processing_jobs
            where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'), 'skipped',
    'a skipped label job is not re-queued');
select is((select count(*)::int from public.processing_jobs where evidence_id = (select v from t_out where k = 'e1') and stage = 'label'), 1,
    'no extra label job is created');

-- [43-45] append-only for every writer (table owner included)
select throws_ok($$update public.evidence_comments set body = 'edited'$$, '42501', 'File comments cannot be edited',
    'the guard refuses an update even for the table owner');
select throws_ok($$delete from public.evidence_comments$$, '42501', 'File comments cannot be deleted',
    'the guard refuses a delete even for the table owner');
select is((select count(*)::int from public.audit_log where table_name = 'evidence_comments'
            and record_id = (select v from t_out where k = 'c1')), 1, 'the insert is in the audit log');

select * from finish();
rollback;
