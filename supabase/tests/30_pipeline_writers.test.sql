-- M6 pipeline worker writers: record_llm_labels (atomic LLM answer, escalation, humans decide) and
-- record_field_suggestions (replace pending rule suggestions, keep decided ones). Service role only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','29000000-0000-4000-8000-0000000000a1','authenticated','authenticated','p-o1@example.com',null,'{"role":"office","full_name":"P Office"}','{}');
insert into public.insurers (id, name, code) values ('29100000-0000-4000-8000-000000000001', 'P Insurer', 'PWR');
select public.load_evidence_categories('[
    {"code":"p_vehicle","name":"Vehicle photo"},
    {"code":"p_odometer","name":"Odometer photo","ocr":true},
    {"code":"p_dl","name":"Driving licence","default_evidence_type":"document"},
    {"code":"p_old","name":"Retired","is_active":false}]');
select public.load_case_template('{"insurer_code":"PWR","claim_type":"motor","variant":"od","name":"PWR OD","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[{"key":"insurer_claim_no","label":"Claim","source":"intake","required":true}]},
              {"key":"driver","title":"Driver","fields":[{"key":"dl_number","label":"DL number"},{"key":"driver_dob","label":"DOB","type":"date"}]},
              {"key":"garage","title":"Garage","fields":[{"key":"odometer_at_entry","label":"Odometer"}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id)
select '29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000001', 'PWR-1', 'motor', t.id,
       '29000000-0000-4000-8000-0000000000a1'
  from public.case_templates t join public.insurers i on i.id = t.insurer_id where i.code = 'PWR' and t.is_active;
insert into public.evidence (id, case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256, captured_by)
values ('29500000-0000-4000-8000-000000000001', '29300000-0000-4000-8000-000000000001', 'photo', 'web_upload', 'supabase',
        'cases/p/1', 'image/jpeg', repeat('b1', 32), '29000000-0000-4000-8000-0000000000a1'),
       ('29500000-0000-4000-8000-000000000002', '29300000-0000-4000-8000-000000000001', 'document', 'web_upload', 'supabase',
        'cases/p/2', 'application/pdf', repeat('b2', 32), '29000000-0000-4000-8000-0000000000a1');

create function pg_temp.active(p_ev uuid) returns text language sql as $$
    select coalesce(string_agg(c.code || ':' || l.pipeline_version || ':' || l.model, ',' order by c.code), '')
      from public.evidence_labels l join public.evidence_categories c on c.id = l.category_id
     where l.evidence_id = p_ev and l.is_active and l.source = 'llm' $$;
create function pg_temp.matches(p_ev uuid) returns text language sql as $$
    select coalesce(string_agg(f.key || '@' || m.pipeline_version, ',' order by f.key), '')
      from public.evidence_field_matches m join public.case_template_fields f on f.id = m.field_id
     where m.evidence_id = p_ev $$;

-- =====================================================================
-- A. Privileges
-- =====================================================================
select ok(not has_function_privilege('authenticated', 'public.record_llm_labels(uuid, jsonb, jsonb)', 'execute'),
          'signed-in users cannot record LLM labels');
select ok(not has_function_privilege('anon', 'public.record_llm_labels(uuid, jsonb, jsonb)', 'execute'), 'anon cannot either');
select ok(has_function_privilege('service_role', 'public.record_llm_labels(uuid, jsonb, jsonb)', 'execute'), 'the worker can');
select ok(not has_function_privilege('authenticated', 'public.record_field_suggestions(uuid, jsonb)', 'execute'),
          'signed-in users cannot record suggestions');
select ok(has_function_privilege('service_role', 'public.record_field_suggestions(uuid, jsonb)', 'execute'), 'the worker can');

set local role service_role;
set local request.jwt.claims to '';

-- =====================================================================
-- B. One answer
-- =====================================================================
select is((public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{
    "pipeline_version":"v1","model":"anthropic/claude-haiku-5-5",
    "labels":[{"code":"p_odometer","confidence":0.92},{"code":"p_vehicle","confidence":0.4}],
    "fields":[{"key":"odometer_at_entry","confidence":0.9}],
    "needs_detail":true,"detail_reason":"odometer reading","description":"Odometer close-up."}'))->>'labels', '2',
    'two labels stored');
select is(pg_temp.active('29500000-0000-4000-8000-000000000001'),
    'p_odometer:v1:anthropic/claude-haiku-5-5,p_vehicle:v1:anthropic/claude-haiku-5-5', 'labels active with version and model');
select is((select count(*)::int from public.evidence_labels where evidence_id = '29500000-0000-4000-8000-000000000001'
            and description is not null), 1, 'description only on one row');
select is((select c.code from public.evidence_labels l join public.evidence_categories c on c.id = l.category_id
            where l.evidence_id = '29500000-0000-4000-8000-000000000001' and l.description is not null), 'p_odometer',
          'description on the first (best) label');
select ok((select bool_and(needs_detail and detail_reason = 'odometer reading') from public.evidence_labels
            where evidence_id = '29500000-0000-4000-8000-000000000001'), 'needs_detail and reason on every row');
select is(pg_temp.matches('29500000-0000-4000-8000-000000000001'), 'odometer_at_entry@v1', 'field match stored');
select is((select score from public.evidence_field_matches where evidence_id = '29500000-0000-4000-8000-000000000001'), 0.9::real,
          'score is the model confidence');
select ok(public.ocr_wanted('29500000-0000-4000-8000-000000000001'), 'needs_detail makes OCR wanted');

-- =====================================================================
-- C. A retried job: same version again, no duplicate active labels
-- =====================================================================
select lives_ok($$select public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{
    "pipeline_version":"v1","model":"anthropic/claude-haiku-5-5",
    "labels":[{"code":"p_odometer","confidence":0.95}],"fields":[{"key":"odometer_at_entry","confidence":0.8},{"key":"dl_number","confidence":0.1}],
    "needs_detail":false,"detail_reason":null,"description":null}')$$, 'retry with the same version works');
select is(pg_temp.active('29500000-0000-4000-8000-000000000001'), 'p_odometer:v1:anthropic/claude-haiku-5-5', 'only the new answer is active');
select is((select count(*)::int from public.evidence_labels where evidence_id = '29500000-0000-4000-8000-000000000001'
            and not is_active), 2, 'earlier rows kept, inactive');
select is(pg_temp.matches('29500000-0000-4000-8000-000000000001'), 'dl_number@v1,odometer_at_entry@v1', 'field matches replaced');

-- =====================================================================
-- D. Escalation (D37): first model kept inactive, second active under a new version
-- =====================================================================
select is((public.record_llm_labels('29500000-0000-4000-8000-000000000002', '{
    "pipeline_version":"v1+esc","model":"anthropic/claude-sonnet-5-5",
    "labels":[{"code":"p_dl","confidence":0.97}],"fields":[{"key":"dl_number","confidence":0.95},{"key":"driver_dob","confidence":0.9}],
    "needs_detail":true,"detail_reason":"DL number","description":null}',
    '{"pipeline_version":"v1","model":"anthropic/claude-haiku-5-5","labels":[{"code":"p_vehicle","confidence":0.3}],
      "needs_detail":true,"detail_reason":null,"description":"Unclear document."}'))->>'superseded', '1',
    'first model answer stored');
select is(pg_temp.active('29500000-0000-4000-8000-000000000002'), 'p_dl:v1+esc:anthropic/claude-sonnet-5-5', 'second model active');
select is((select string_agg(c.code || ':' || l.pipeline_version || ':' || l.model, ',') from public.evidence_labels l
             join public.evidence_categories c on c.id = l.category_id
            where l.evidence_id = '29500000-0000-4000-8000-000000000002' and not l.is_active),
          'p_vehicle:v1:anthropic/claude-haiku-5-5', 'first model row kept inactive');
select is((select description from public.evidence_labels where evidence_id = '29500000-0000-4000-8000-000000000002' and not is_active),
          'Unclear document.', 'first model description kept');
select is(pg_temp.matches('29500000-0000-4000-8000-000000000002'), 'dl_number@v1+esc,driver_dob@v1+esc', 'matches of the accepted answer only');

-- matches from another source (category -> field map) are neither replaced nor duplicated
insert into public.evidence_field_matches (evidence_id, field_id, score, model, pipeline_version)
select '29500000-0000-4000-8000-000000000002', f.id, 1, 'category_map', v
  from public.case_template_fields f join public.case_templates t on t.id = f.template_id
  cross join (values ('map-v1'), ('v3')) x(v)
 where t.name = 'PWR OD' and f.key = 'dl_number';
select is((public.record_llm_labels('29500000-0000-4000-8000-000000000002', '{
    "pipeline_version":"v3","model":"anthropic/claude-haiku-5-5",
    "labels":[{"code":"p_dl","confidence":0.97}],"fields":[{"key":"dl_number","confidence":0.9},{"key":"driver_dob","confidence":0.8}],
    "needs_detail":true}'))->>'field_matches', '1', 'an LLM match colliding with a map row is not written twice');
select is((select string_agg(f.key || '@' || m.pipeline_version || ':' || m.model, ',' order by f.key, m.pipeline_version)
             from public.evidence_field_matches m join public.case_template_fields f on f.id = m.field_id
            where m.evidence_id = '29500000-0000-4000-8000-000000000002'),
          'dl_number@map-v1:category_map,dl_number@v3:category_map,driver_dob@v3:anthropic/claude-haiku-5-5',
          'map rows kept; earlier LLM matches (Sonnet, v1+esc) replaced');

-- =====================================================================
-- E. Validation
-- =====================================================================
select throws_ok($$select public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{"pipeline_version":"v1","model":"m","labels":[{"code":"nope","confidence":1}]}')$$,
    '22023', 'Unknown category: nope', 'unknown category refused');
select throws_ok($$select public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{"pipeline_version":"v1","model":"m","labels":[{"code":"p_old","confidence":1}]}')$$,
    '22023', 'Unknown category: p_old', 'inactive category refused');
select throws_ok($$select public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{"pipeline_version":"v1","model":"m","labels":[{"code":"p_dl","confidence":1}],"fields":[{"key":"reg_number","confidence":1}]}')$$,
    '22023', 'Unknown field for the case template: reg_number', 'field outside the case template refused');
select throws_ok($$select public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{"pipeline_version":"v1","model":"m","labels":[]}')$$,
    '22023', 'At least one label is required', 'empty answer refused');
select throws_ok($$select public.record_llm_labels(gen_random_uuid(), '{"pipeline_version":"v1","model":"m","labels":[{"code":"p_dl"}]}')$$,
    'P0002', 'Evidence not found', 'unknown file refused');

-- =====================================================================
-- F. Humans decide: after an office correction new LLM labels are stored inactive
-- =====================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"29000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select public.set_evidence_labels('29500000-0000-4000-8000-000000000001', array[(select id from public.evidence_categories where code = 'p_vehicle')]);
reset role;
set local role service_role;
set local request.jwt.claims to '';
select is((public.record_llm_labels('29500000-0000-4000-8000-000000000001', '{"pipeline_version":"v2","model":"anthropic/claude-haiku-5-5",
    "labels":[{"code":"p_odometer","confidence":0.99}],"needs_detail":true}'))->>'held_for_review', 'true', 'reported as held for review');
select is(pg_temp.active('29500000-0000-4000-8000-000000000001'), '', 'LLM label not active over a human label');
select is((select string_agg(c.code, ',') from public.evidence_labels l join public.evidence_categories c on c.id = l.category_id
            where l.evidence_id = '29500000-0000-4000-8000-000000000001' and l.is_active), 'p_vehicle', 'the human label stays');

-- =====================================================================
-- G. Field suggestions
-- =====================================================================
insert into public.evidence_ocr (id, evidence_id, page_no, engine, text, blocks)
values ('29600000-0000-4000-8000-000000000001', '29500000-0000-4000-8000-000000000002', 1, 'pdf_text_layer', 'DL No MH1220110012345',
        '[{"text":"DL No MH1220110012345","bbox":[0,0,10,10],"conf":1,"line":1}]');
select is(public.record_field_suggestions('29500000-0000-4000-8000-000000000002', '[
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"dl_number","value":"MH1220110012345","confidence":0.8,"block_index":0},
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"dl_number","value":"MH1220110012345","confidence":0.6,"block_index":0},
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"driver_dob","value":"1990-01-02","confidence":0.5,"block_index":0}]'), 2,
    'suggestions stored, duplicates merged');
update public.field_suggestions set status = 'rejected'
 where evidence_id = '29500000-0000-4000-8000-000000000002' and value = '1990-01-02';
select is(public.record_field_suggestions('29500000-0000-4000-8000-000000000002', '[
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"dl_number","value":"MH1220110012345","confidence":0.8,"block_index":0},
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"driver_dob","value":"1990-01-02","confidence":0.5,"block_index":0}]'), 1,
    're-run replaces pending suggestions and does not repeat a decided value');
select is((select string_agg(status::text || ':' || value, ',' order by value) from public.field_suggestions
            where evidence_id = '29500000-0000-4000-8000-000000000002'), 'rejected:1990-01-02,pending:MH1220110012345',
          'decided suggestion kept, one pending');
select throws_ok($$select public.record_field_suggestions('29500000-0000-4000-8000-000000000001', '[
    {"ocr_id":"29600000-0000-4000-8000-000000000001","field_key":"dl_number","value":"X","confidence":0.8,"block_index":0}]')$$,
    '22023', 'OCR row does not belong to the file', 'OCR row of another file refused');

reset role;
select * from finish();
rollback;
