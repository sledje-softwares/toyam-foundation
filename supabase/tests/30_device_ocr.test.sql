-- record_device_ocr (20261119600000): device OCR of the 1600 px copy, masking, idempotency, access
-- (owner operator, other operator, staff, anon, D43 late window), field cannot read OCR, the legacy
-- `ocr` item and direct inserts are dropped, the server OCR job is skipped. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(38);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','30500000-0000-4000-8000-0000000000b1','authenticated','authenticated','do-off@example.com',null,'{"role":"office","full_name":"DO Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','30500000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870003001','{"role":"field","full_name":"DO Field One"}','{}'),
 ('00000000-0000-0000-0000-000000000000','30500000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870003002','{"role":"field","full_name":"DO Field Two"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('30600000-0000-4000-8000-000000000001', 'DO Insurer', 'DOI', 10);
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, office_owner_id)
values ('30700000-0000-4000-8000-000000000001', '30600000-0000-4000-8000-000000000001', 'DO-1', 'motor', '30500000-0000-4000-8000-0000000000b1');
insert into public.tasks (id, case_id, title, assignee_id)
values ('30800000-0000-4000-8000-000000000001', '30700000-0000-4000-8000-000000000001', 'Garage visit', '30500000-0000-4000-8000-0000000000f1');

create temp table t_files (k text primary key, v jsonb) on commit drop;
insert into t_files
select k, jsonb_build_object('evidence_type', t, 'capture_source', 'camera', 'sha256', sha, 'mime_type', m,
          'size_bytes', 1000, 'device_captured_at', now() - interval '1 minute', 'category_code', null,
          'storage_path', 'cases/30700000-0000-4000-8000-000000000001/tasks/30800000-0000-4000-8000-000000000001/' || sha || '.' || x)
       || case when k = 'p4' then jsonb_build_object('ocr', jsonb_build_object('engine', 'mlkit_device', 'text', 'legacy 234567890123')) else '{}'::jsonb end
  from (values ('p1', 'photo', repeat('d1', 32), 'image/jpeg', 'jpg'),
               ('p2', 'photo', repeat('d2', 32), 'image/jpeg', 'jpg'),
               ('p3', 'photo', repeat('d3', 32), 'image/jpeg', 'jpg'),
               ('p4', 'photo', repeat('d4', 32), 'image/jpeg', 'jpg'),
               ('p5', 'photo', repeat('d5', 32), 'image/jpeg', 'jpg'),
               ('d1', 'document', repeat('de', 32), 'application/pdf', 'pdf')) f (k, t, sha, m, x);
grant select on t_files to authenticated;

create temp table t_out (k text primary key, v jsonb) on commit drop;
grant all on t_out to authenticated;

-- [1-2] grants
select ok(not has_function_privilege('anon', 'public.record_device_ocr(uuid,text,int,text,text,text,jsonb,real,text)', 'execute'), 'anon cannot call it');
select ok(has_function_privilege('authenticated', 'public.record_device_ocr(uuid,text,int,text,text,text,jsonb,real,text)', 'execute'), 'signed-in users can call it (the function checks the role)');

set local role authenticated;
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
-- [3-4] p1, p2, p4, p5, d1 in one message (p4 carries a legacy `ocr` item); p3 alone (withdrawn below)
select lives_ok($$select public.post_thread_message('30700000-0000-4000-8000-000000000001', '30900000-0000-4000-8000-000000000001',
                  'media', null, '30800000-0000-4000-8000-000000000001', null,
                  (select jsonb_agg(v order by k) from t_files where k <> 'p3'))$$,
    'the operator stored photos and a document (one with a legacy ocr item)');
select lives_ok($$select public.post_thread_message('30700000-0000-4000-8000-000000000001', '30900000-0000-4000-8000-000000000002',
                  'media', null, '30800000-0000-4000-8000-000000000001', null,
                  (select jsonb_agg(v) from t_files where k = 'p3'))$$, 'a second message with one photo');
reset role;
-- [5] legacy path dropped
select is((select count(*)::int from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id
            where e.sha256 = repeat('d4', 32)), 0, 'OCR sent inside post_thread_message by a field user is dropped (no unmasked text)');

set local role authenticated;
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
-- [6] direct insert dropped
select lives_ok($$insert into public.evidence_ocr (evidence_id, engine, text)
                  select e.id, 'mlkit_device', 'direct 234567890123' from public.evidence e where e.sha256 = repeat('d5', 32)$$,
    'a direct insert by a field user does not fail the request');
-- [7-9] record
select lives_ok($$insert into t_out select 'r1', public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d1', 32), 1600,
                  'mlkit-text-16.0.1+deva-16.0.1', 'latin+devanagari',
                  E'MH 12 AB 3456\nAadhaar 2345 6789 0123\nरजिस्ट्रेशन',
                  '[{"text":"MH 12 AB 3456","bbox":[10,20,300,40],"conf":0.95,"line":0},
                    {"text":"Aadhaar 2345 6789 0123","bbox":[10,80,500,40],"conf":0.9,"line":1},
                    {"text":"रजिस्ट्रेशन","bbox":[10,140,200,40],"conf":null,"line":2}]'::jsonb,
                  0.92, 'Registration certificate; text read from the 1600 px copy: MH 12 AB 3456 · Aadhaar 2345-6789-0123')$$,
    'the operator records the OCR of their photo');
select is((select v->>'recorded' from t_out where k = 'r1'), 'true', 'recorded = true on the first call');
select is((select v->>'server_ocr_skipped' from t_out where k = 'r1'), 'true', 'confident text skips the queued server OCR job');
-- [10] field cannot read OCR
select is((select count(*)::int from public.evidence_ocr), 0, 'field users cannot read OCR rows (rule 4)');
-- [11-12] retry
select lives_ok($$insert into t_out select 'r2', public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d1', 32), 1600,
                  'other', 'latin', 'different text', '[]'::jsonb, 0.5, 'other')$$, 'a retry lives');
select is((select v->>'recorded' from t_out where k = 'r2'), 'false', 'a retry returns recorded = false');
reset role;

-- [13-21] what was stored
select is((select count(*)::int from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)), 1,
    'one row per photo despite the retry');
select is((select count(*)::int from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d5', 32)), 0,
    'the direct insert stored nothing');
select is((select o.text from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    E'MH 12 AB 3456\nAadhaar XXXX XXXX 0123\nरजिस्ट्रेशन', 'Aadhaar-like number masked in the text, other numbers kept');
select is((select o.blocks->1->>'text' from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    'Aadhaar XXXX XXXX 0123', 'masked in the blocks');
select is((select o.blocks->0 from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    '{"text":"MH 12 AB 3456","bbox":[10,20,300,40],"conf":0.95,"line":0}'::jsonb, 'block shape kept');
select is((select o.summary from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    'Registration certificate; text read from the 1600 px copy: MH 12 AB 3456 · Aadhaar XXXX XXXX 0123', 'masked in the description');
select is((select row(o.engine, o.page_no, o.source_width, o.is_current, o.created_by::text, o.lang)::text
             from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    row('mlkit_device', 1, 1600, true, '30500000-0000-4000-8000-0000000000f1', 'latin+devanagari')::text, 'engine, page, source copy, current, author');
select is((select row(j.status, j.last_error)::text from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.sha256 = repeat('d1', 32) and j.stage = 'ocr'), row('skipped', 'device OCR present')::text, 'server OCR job skipped with the reason');
select is((select j.status::text from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.sha256 = repeat('d1', 32) and j.stage = 'label'), 'queued', 'the label job is untouched');
select is(private.mask_aadhaar('a 234567890123 b 1234 5678 9012 c 98765432101234 d 2345-6789-0123'),
    'a XXXX XXXX 0123 b 1234 5678 9012 c 98765432101234 d XXXX XXXX 0123', 'masking: 12 digits starting 2-9, plain or grouped, not inside longer numbers');

-- [22-23] staff read it
set local role authenticated;
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select o.summary from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d1', 32)),
    'Registration certificate; text read from the 1600 px copy: MH 12 AB 3456 · Aadhaar XXXX XXXX 0123', 'the case owner reads the summary');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    '42501', null::text, 'staff do not record device OCR');

-- [24-30] refusals for the operator
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 384, null, null, 'x', '[]', 0.9, null)$$,
    '22023', null::text, 'only the 1600 px copy');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600, null, null, repeat('x', 20001), '[]', 0.9, null)$$,
    '22023', null::text, 'text over 20000 characters');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600, null, null, 'x',
                   (select jsonb_agg(jsonb_build_object('text', 'a', 'bbox', '[0,0,1,1]'::jsonb, 'conf', 0.5, 'line', g)) from generate_series(1, 2001) g), 0.9, null)$$,
    '22023', null::text, 'more than 2000 blocks');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600, null, null, 'x',
                   '[{"text":"a","bbox":[0,0,1],"conf":0.5,"line":0}]', 0.9, null)$$,
    '22023', null::text, 'malformed block');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('de', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    '22023', null::text, 'documents are not read on the phone');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('00', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    'P0002', null::text, 'unknown photo');
select lives_ok($$select public.withdraw_message((select id from public.case_messages where client_message_id = '30900000-0000-4000-8000-000000000002'))$$,
    'the operator withdraws the single-photo message');
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d3', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    '55000', null::text, 'withdrawn photo');

-- [32] another operator
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    'P0002', null::text, 'another operator cannot record OCR on someone else''s photo');

-- [33-35] server OCR already current; low confidence; D43 late window
reset role;
set local request.jwt.claims to '{}';
insert into public.evidence_ocr (evidence_id, engine, text)
select e.id, 'paddleocr', 'server text' from public.evidence e where e.sha256 = repeat('d2', 32);
update public.tasks set assignee_id = '30500000-0000-4000-8000-0000000000f2' where id = '30800000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$insert into t_out select 'r3', public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d2', 32), 1600,
                  null, null, 'low', '[]', 0.3, null)$$, 'the previous assignee records inside the late window');
reset role;
select is((select row(o.is_current, j.status)::text from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id
             join public.processing_jobs j on j.evidence_id = e.id and j.stage = 'ocr'
            where e.sha256 = repeat('d2', 32) and o.engine = 'mlkit_device'),
    row(false, 'queued')::text, 'beside a current server row the device row is not current, and low confidence skips nothing');
select is((select o.engine from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d2', 32) and o.is_current),
    'paddleocr', 'the server row stays current');
set local request.jwt.claims to '{}';
update public.task_holds set held_from = now() - interval '200 hours', held_until = now() - interval '100 hours'
 where profile_id = '30500000-0000-4000-8000-0000000000f1' and task_id = '30800000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"30500000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.record_device_ocr('30700000-0000-4000-8000-000000000001', repeat('d5', 32), 1600, null, null, 'x', '[]', 0.9, null)$$,
    '42501', null::text, 'refused once the late window has passed');

-- [38] staff insert (server path) is unaffected by the field guard
reset role;
set local request.jwt.claims to '{}';
select is((select count(*)::int from public.evidence_ocr o join public.evidence e on e.id = o.evidence_id where e.sha256 = repeat('d2', 32)), 2,
    'service-role (pipeline) inserts are not dropped by the field guard');

select * from finish();
rollback;
