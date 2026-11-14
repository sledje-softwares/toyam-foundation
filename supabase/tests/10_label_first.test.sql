-- D34: label before OCR, categories that need OCR, labeller detail flag and model, OCR skip rule.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1a000000-0000-4000-8000-0000000000b1','authenticated','authenticated','l-off@example.com',null,'{"role":"office","full_name":"L Office"}','{}');
insert into public.insurers (id, name, code) values ('2a000000-0000-4000-8000-0000000000a1', 'Label Insurer', 'LBL');
select public.load_case_template('{"insurer_code":"LBL","claim_type":"motor","variant":"od","name":"LBL OD","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[{"key":"insurer_claim_no","label":"Claim","source":"intake","required":true}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id)
select '3a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-0000000000a1', 'LBL-1', 'motor', t.id
  from public.case_templates t join public.insurers i on i.id = t.insurer_id where i.code = 'LBL' and t.is_active;

-- =====================================================================
-- A. Categories that need OCR
-- =====================================================================
select ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'evidence_categories'
                    and column_name = 'needs_ocr'), 'categories record whether their files need OCR');
select is((select public.load_evidence_categories('[
    {"code":"l_vehicle","name":"Vehicle photo"},
    {"code":"l_odometer","name":"Odometer photo","ocr":true},
    {"code":"l_rc","name":"RC","default_evidence_type":"document"},
    {"code":"l_scan","name":"Scanned annexure","default_evidence_type":"document","ocr":false}]')), 4, 'categories loaded');
select results_eq($$select code || '=' || needs_ocr from public.evidence_categories where code like 'l\_%' order by code$$,
    array['l_odometer=true', 'l_rc=true', 'l_scan=false', 'l_vehicle=false'],
    'needs_ocr: documents by default, photos only when set, explicit false wins');
select is((select public.load_evidence_categories('[{"code":"l_vehicle","name":"Vehicle photo","ocr":true}]')), 1, 'reload');
select is((select needs_ocr from public.evidence_categories where code = 'l_vehicle'), true, 'reload updates needs_ocr');
select public.load_evidence_categories('[{"code":"l_vehicle","name":"Vehicle photo"}]');

-- =====================================================================
-- B. Stage order: label before OCR
-- =====================================================================
select results_eq($$select s::text from unnest(enum_range(null::public.processing_stage)) s order by private.stage_rank(s)$$,
    array['text_extract', 'label', 'ocr', 'field_suggest'], 'run order is text_extract, label, ocr, field_suggest');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1a000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
insert into public.case_messages (id, case_id, sender_id, kind, body)
values ('4a000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001',
        '1a000000-0000-4000-8000-0000000000b1', 'media', 'files');
insert into public.evidence (case_id, message_id, evidence_type, capture_source, storage_path, sha256, captured_by)
select '3a000000-0000-4000-8000-000000000001', '4a000000-0000-4000-8000-000000000001', t::public.evidence_type, 'web_upload',
       'cases/3a000000-0000-4000-8000-000000000001/files/' || repeat(h, 32) || x, repeat(h, 32), '1a000000-0000-4000-8000-0000000000b1'
  from (values ('a1', 'photo', '.jpg'), ('a2', 'photo', '.jpg'), ('a3', 'photo', '.jpg'),
               ('a4', 'document', '.pdf'), ('a5', 'photo', '.jpg')) v(h, t, x);
reset role;

set local role service_role;
set local request.jwt.claims to '';
select is((select count(*)::int from public.claim_processing_jobs(array['ocr']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.case_id = '3a000000-0000-4000-8000-000000000001'), 0,
          'no OCR job is claimable while labels are queued');
select is((select count(*)::int from public.claim_processing_jobs(array['label']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id
           where e.case_id = '3a000000-0000-4000-8000-000000000001' and e.evidence_type = 'photo'), 4,
          'photo labels are claimable first');
select is((select count(*)::int from public.claim_processing_jobs(array['label']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.sha256 = repeat('a4', 32)), 0,
          'a document label waits for the PDF text layer');

-- =====================================================================
-- C. Labeller output: detail flag and model
-- =====================================================================
select lives_ok($$insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version,
                                                      description, needs_detail, detail_reason, model)
                  select e.id, c.id, v.conf, 'llm', 'v1', v.descr, v.nd, v.reason, 'anthropic/claude-haiku-5-5'
                    from (values (repeat('a1', 32), 'l_vehicle',  0.97::real, 'Front of a white hatchback, bumper dented', false, null),
                                 (repeat('a2', 32), 'l_vehicle',  0.91::real, 'Rear of the vehicle, number plate readable', true, 'number plate'),
                                 (repeat('a3', 32), 'l_odometer', 0.95::real, 'Digital odometer', false, null)) v(sha, code, conf, descr, nd, reason)
                    join public.evidence e on e.sha256 = v.sha
                    join public.evidence_categories c on c.code = v.code$$,
    'pipeline stores labels with needs_detail, reason and model');
select is((select count(*)::int from public.evidence_labels where model = 'anthropic/claude-haiku-5-5'), 3, 'model recorded');
select throws_ok($$insert into public.evidence_labels (evidence_id, category_id, source, detail_reason)
                   select e.id, c.id, 'llm', repeat('x', 301) from public.evidence e, public.evidence_categories c
                    where e.sha256 = repeat('a5', 32) and c.code = 'l_vehicle'$$,
    '23514', null::text, 'detail reason is short');

-- =====================================================================
-- D. OCR skip rule
-- =====================================================================
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a1', 32))), false,
          'plain vehicle photo: OCR skipped');
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a2', 32))), true,
          'labeller asked for detail: OCR wanted');
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a3', 32))), true,
          'category needs OCR: OCR wanted');
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a4', 32))), true,
          'documents always get OCR');
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a5', 32))), true,
          'unlabelled file: OCR wanted to be safe');
select is(public.ocr_wanted('00000000-0000-4000-8000-000000000000'), false, 'unknown file: not wanted');
reset role;

-- office corrects a1 to odometer: the human label decides
set local role authenticated;
set local request.jwt.claims to '{"sub":"1a000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select public.set_evidence_labels((select id from public.evidence where sha256 = repeat('a1', 32)),
                                  array[(select id from public.evidence_categories where code = 'l_odometer')]);
reset role;
select is(public.ocr_wanted((select id from public.evidence where sha256 = repeat('a1', 32))), true,
          'after an office correction to a category that needs OCR, OCR is wanted');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1a000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.ocr_wanted((select id from public.evidence where sha256 = repeat('a1', 32)))$$,
    '42501', null::text, 'only the worker calls ocr_wanted');
reset role;

select * from finish();
rollback;
