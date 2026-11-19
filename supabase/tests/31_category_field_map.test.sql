-- Category → field map per template version (20261119500000_category_field_map.sql, docs/14 gap 26).
-- Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','31000000-0000-4000-8000-0000000000a1','authenticated','authenticated','m-o1@example.com',null,'{"role":"office","full_name":"M Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','31000000-0000-4000-8000-0000000000a2','authenticated','authenticated','m-o2@example.com',null,'{"role":"office","full_name":"M Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','31000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870000031','{"role":"field","full_name":"M Field"}','{}');
insert into public.insurers (id, name, code) values ('31100000-0000-4000-8000-000000000001', 'Map Insurer', 'MAP');

select public.load_evidence_categories($j$[
 {"code":"dl_document","name":"Driving licence","default_evidence_type":"document","filename_patterns":["driving licen[cs]e"]},
 {"code":"policy_document","name":"Policy copy","default_evidence_type":"document","filename_patterns":["policy"]},
 {"code":"rc_document","name":"RC","default_evidence_type":"document","filename_patterns":["\\brc\\b"]},
 {"code":"id_document","name":"Identity document","default_evidence_type":"document","filename_patterns":["aadhaar"]},
 {"code":"vehicle_photo","name":"Vehicle photo","filename_patterns":["front view"]}]$j$::jsonb);

create function pg_temp.cfg(p_variant text, p_map text) returns jsonb language sql as $$
    select ('{"insurer_code":"MAP","claim_type":"motor","variant":"' || p_variant || '","name":"Map ' || p_variant || '",
      "sections":[{"key":"driver","title":"Driver","categories":["dl_document"],
                   "fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"},
                             {"key":"dl_number","label":"DL no."},{"key":"driver_name","label":"Driver name"}]},
                  {"key":"vehicle","title":"Vehicle","fields":[{"key":"vehicle_no","label":"Vehicle no."},
                                                              {"key":"policy_no","label":"Policy no."}]}]'
      || coalesce(', "category_fields":' || p_map, '') || '}')::jsonb $$;

create temp table r (tag text, template_id uuid, version int, created boolean);
insert into r select 'v1', * from public.load_case_template(pg_temp.cfg('od',
  '{"dl_document":{"dl_number":0.95,"driver_name":0.8},"policy_document":{"policy_no":0.9},
    "rc_document":{"vehicle_no":0.9},"id_document":{"driver_name":0.5}}'));

create function pg_temp.map_score(p_tag text, p_cat text, p_key text) returns real language sql as $$
    select m.score from public.case_template_category_fields m
      join r on r.template_id = m.template_id and r.tag = p_tag
      join public.evidence_categories c on c.id = m.category_id and c.code = p_cat
      join public.case_template_fields f on f.id = m.field_id and f.key = p_key $$;

-- A. loader
select is((select count(*)::int from public.case_template_category_fields m join r on r.template_id = m.template_id and r.tag = 'v1'),
          5, 'the map is stored with the template version');
select is(pg_temp.map_score('v1', 'dl_document', 'dl_number'), 0.95::real, 'score kept as given');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad1', '{"nope":{"dl_number":0.9}}'))$$,
    '22023', 'category_fields: unknown evidence category nope', 'unknown category fails the load');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad2', '{"dl_document":{"dl_nmber":0.9}}'))$$,
    '22023', 'category_fields.dl_document: unknown field dl_nmber', 'unknown field fails the load');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad3', '{"dl_document":{"dl_number":1.5}}'))$$,
    '22023', 'category_fields.dl_document.dl_number: score must be a number in (0, 1]', 'score above 1 fails');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad4', '{"dl_document":{"dl_number":0}}'))$$,
    '22023', 'category_fields.dl_document.dl_number: score must be a number in (0, 1]', 'score 0 fails');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad5', '{"dl_document":{"dl_number":"high"}}'))$$,
    '22023', 'category_fields.dl_document.dl_number: score must be a number in (0, 1]', 'non-numeric score fails');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad6', '[1]'))$$,
    '22023', 'category_fields must be an object', 'non-object map fails');
select throws_ok($$select public.load_case_template(pg_temp.cfg('bad7', '{"dl_document":[1]}'))$$,
    '22023', 'category_fields.dl_document: must be an object of field key → score', 'non-object entry fails');
select is((select count(*)::int from public.case_templates t where t.variant like 'bad%'), 0, 'failed loads leave no template');

insert into r select 'same', * from public.load_case_template(pg_temp.cfg('od',
  '{"dl_document":{"dl_number":0.95,"driver_name":0.8},"policy_document":{"policy_no":0.9},
    "rc_document":{"vehicle_no":0.9},"id_document":{"driver_name":0.5}}'));
select ok((select not created from r where tag = 'same'), 'identical map is a no-op');
insert into r select 'v2', * from public.load_case_template(pg_temp.cfg('od', '{"dl_document":{"dl_number":0.9}}'));
select is((select version from r where tag = 'v2'), 2, 'a map change makes a new template version');
select is((select count(*)::int from public.case_template_category_fields m join r on r.template_id = m.template_id and r.tag = 'v2'),
          1, 'the new version has its own map');
select is(pg_temp.map_score('v1', 'dl_document', 'dl_number'), 0.95::real, 'the earlier version keeps its map');
insert into r select 'nomap', * from public.load_case_template(pg_temp.cfg('nomap', null));
select is((select count(*)::int from public.case_template_category_fields m join r on r.template_id = m.template_id and r.tag = 'nomap'),
          0, 'a template without category_fields loads with no map');
select throws_ok($$insert into public.case_template_category_fields (template_id, category_id, field_id, score)
    select (select template_id from r where tag = 'nomap'), (select id from public.evidence_categories where code = 'dl_document'),
           f.id, 0.5 from public.case_template_fields f join r on r.template_id = f.template_id and r.tag = 'v1' where f.key = 'dl_number'$$,
    '23503', null::text, 'a map row cannot point at a field of another template version');

-- B. case + files on template v1
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id, template_id)
values ('31300000-0000-4000-8000-000000000001', '31100000-0000-4000-8000-000000000001', 'MAP-1', 'motor', 'assigned',
        '31000000-0000-4000-8000-0000000000a1', (select template_id from r where tag = 'v1')),
       ('31300000-0000-4000-8000-000000000002', '31100000-0000-4000-8000-000000000001', 'MAP-2', 'motor', 'assigned',
        '31000000-0000-4000-8000-0000000000a1', null);
insert into public.tasks (id, case_id, title, assignee_id)
values ('31400000-0000-4000-8000-000000000001', '31300000-0000-4000-8000-000000000001', 'Visit', '31000000-0000-4000-8000-0000000000f1');
insert into public.emails (id, gmail_message_id, from_address, received_at, case_id, raw_storage_path)
values ('31600000-0000-4000-8000-000000000001', 'm-mail-1', 'a@insurer.example', now(), '31300000-0000-4000-8000-000000000001',
        'emails/m/message.eml');

create function pg_temp.add_file(p_name text, p_n int, p_source text default 'email_attachment',
                                 p_case uuid default '31300000-0000-4000-8000-000000000001') returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_att uuid := gen_random_uuid(); v_sha text := repeat(lpad(p_n::text, 2, '0'), 32);
begin
    if p_source = 'email_attachment' then
        insert into public.email_attachments (id, email_id, filename, mime_type, storage_path, sha256)
        values (v_att, '31600000-0000-4000-8000-000000000001', p_name, 'image/jpeg', 'emails/m/att/' || p_n, v_sha);
        insert into public.evidence (id, case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256,
                                     original_filename, email_attachment_id, captured_by)
        values (v_id, p_case, 'photo', 'email_attachment', 'supabase', 'emails/m/att/' || p_n,
                'image/jpeg', v_sha, p_name, v_att, null);
    else
        insert into public.evidence (id, case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256,
                                     original_filename, captured_by)
        values (v_id, p_case, 'photo', p_source::public.capture_source, 'supabase',
                'cases/m/' || p_n, 'image/jpeg', v_sha, p_name, '31000000-0000-4000-8000-0000000000f1');
    end if;
    return v_id;
end $$;
create function pg_temp.ev(p_name text) returns uuid language sql as $$
    select id from public.evidence where original_filename = p_name $$;
create function pg_temp.cat(p_code text) returns uuid language sql as $$
    select id from public.evidence_categories where code = p_code $$;
-- map rows of a file as 'field=score@category' (score to 3 decimals), sorted
create function pg_temp.maps(p_name text) returns text language sql as $$
    select coalesce(string_agg(f.key || '=' || round(m.score::numeric, 3) || '@' || c.code, ',' order by f.key), '')
      from public.evidence_field_matches m
      join public.case_template_fields f on f.id = m.field_id
      join public.evidence_categories c on c.id = m.category_id
     where m.evidence_id = pg_temp.ev(p_name) and m.model = 'category_map' $$;
create function pg_temp.model_rows(p_name text) returns int language sql as $$
    select count(*)::int from public.evidence_field_matches m where m.evidence_id = pg_temp.ev(p_name) and m.model <> 'category_map' $$;
create function pg_temp.fld(p_key text) returns uuid language sql as $$
    select f.id from public.case_template_fields f join r on r.template_id = f.template_id and r.tag = 'v1' where f.key = p_key $$;

-- C. a filename_rule label gets matches from the map: score = map score × confidence (0.9)
select pg_temp.add_file('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg', 1);
select is(pg_temp.maps('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), 'dl_number=0.855@dl_document,driver_name=0.720@dl_document',
          'filename-rule DL attachment gets its fields from the map');
select is((select string_agg(distinct m.pipeline_version || '/' || m.model, ',') from public.evidence_field_matches m
            where m.evidence_id = pg_temp.ev('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg')),
          'map-v1/category_map', 'map rows are model category_map, pipeline_version map-v1');
select is(private.derive_category_field_matches(pg_temp.ev('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg')), 2,
          'deriving again keeps the same rows');
select is(pg_temp.maps('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), 'dl_number=0.855@dl_document,driver_name=0.720@dl_document',
          'idempotent');

-- D. operator tag (confidence null → 1); two categories on the same field → best one wins
select pg_temp.add_file('IMG_0001.jpg', 2, 'camera');
insert into public.evidence_labels (evidence_id, category_id, confidence, source)
values (pg_temp.ev('IMG_0001.jpg'), pg_temp.cat('id_document'), null, 'operator'),
       (pg_temp.ev('IMG_0001.jpg'), pg_temp.cat('dl_document'), null, 'operator');
select is(pg_temp.maps('IMG_0001.jpg'), 'dl_number=0.950@dl_document,driver_name=0.800@dl_document',
          'operator tags: confidence null counts as 1, best category per field');

-- E. a model match next to non-LLM labels leaves the map rows alone
insert into public.evidence_field_matches (evidence_id, field_id, score, model)
values (pg_temp.ev('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), pg_temp.fld('policy_no'), 0.6, 'anthropic/claude-haiku-5-5');
select is(pg_temp.maps('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), 'dl_number=0.855@dl_document,driver_name=0.720@dl_document',
          'map rows from a rule label stay when the model also matched fields');
select throws_ok($$insert into public.evidence_field_matches (evidence_id, field_id, score, model)
    values (pg_temp.ev('IMG_0001.jpg'), pg_temp.fld('vehicle_no'), 0.5, 'category_map')$$,
    '23514', null::text, 'a category_map row needs its category');

-- F. office correction: removed categories' map rows go, new ones come, model rows stay
set local role authenticated;
set local request.jwt.claims to '{"sub":"31000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select public.set_evidence_labels(pg_temp.ev('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), array[pg_temp.cat('rc_document')])$$,
                'office corrects the label to RC');
reset role;
set local request.jwt.claims to '{}';
select is(pg_temp.maps('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), 'vehicle_no=0.900@rc_document',
          'after the correction the map rows follow the human label only');
select is(pg_temp.model_rows('DRIVING LICENSE(1)_1699999999_1_MAP1.jpg'), 1, 'the model''s own match is not touched');
set local role authenticated;
set local request.jwt.claims to '{"sub":"31000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select public.set_evidence_labels(pg_temp.ev('IMG_0001.jpg'), '{}')$$, 'office clears all labels');
reset role;
set local request.jwt.claims to '{}';
select is(pg_temp.maps('IMG_0001.jpg'), '', 'no active label, no map rows');

-- G. LLM labels: the map is a fallback only while the model returned no fields
select pg_temp.add_file('IMG_0002.jpg', 3, 'camera');
insert into public.evidence_labels (evidence_id, category_id, confidence, source, model)
values (pg_temp.ev('IMG_0002.jpg'), pg_temp.cat('dl_document'), 0.8, 'llm', 'anthropic/claude-haiku-5-5');
select is(pg_temp.maps('IMG_0002.jpg'), 'dl_number=0.760@dl_document,driver_name=0.640@dl_document',
          'LLM label without model fields gets the map as fallback');
insert into public.evidence_field_matches (evidence_id, field_id, score, model)
values (pg_temp.ev('IMG_0002.jpg'), pg_temp.fld('driver_name'), 0.7, 'anthropic/claude-haiku-5-5');
select is(pg_temp.maps('IMG_0002.jpg'), '', 'the model''s fields replace the fallback');
select is(pg_temp.model_rows('IMG_0002.jpg'), 1, 'model row kept');
select pg_temp.add_file('IMG_0003.jpg', 4, 'camera');
insert into public.evidence_field_matches (evidence_id, field_id, score, model)
values (pg_temp.ev('IMG_0003.jpg'), pg_temp.fld('dl_number'), 0.9, 'anthropic/claude-haiku-5-5');
insert into public.evidence_labels (evidence_id, category_id, confidence, source, model)
values (pg_temp.ev('IMG_0003.jpg'), pg_temp.cat('dl_document'), 0.9, 'llm', 'anthropic/claude-haiku-5-5');
select is(pg_temp.maps('IMG_0003.jpg'), '', 'no fallback when the model fields arrived first');

-- H. a case without a template gets no map rows
select pg_temp.add_file('POLICY(1)_1699999999_5_MAP2.jpg', 5, 'email_attachment', '31300000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.evidence_labels where evidence_id = pg_temp.ev('POLICY(1)_1699999999_5_MAP2.jpg') and is_active),
          1, 'the policy attachment is rule-labelled');
select is(pg_temp.maps('POLICY(1)_1699999999_5_MAP2.jpg'), '', 'no template, no map rows');

-- I. visibility: owner sees map matches; another office employee and the operator do not; map table staff-only
set local role authenticated;
set local request.jwt.claims to '{"sub":"31000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select ok((select count(*) from public.evidence_field_matches where model = 'category_map') > 0, 'case owner sees map matches');
select ok((select count(*) from public.case_template_category_fields) >= 5, 'office staff read the template map');
select throws_ok($$insert into public.case_template_category_fields (template_id, category_id, field_id, score)
    select m.template_id, m.category_id, m.field_id, 0.5 from public.case_template_category_fields m limit 1$$,
    '42501', null::text, 'office staff cannot write the map');
select throws_ok($$select public.backfill_category_field_matches(10)$$, '42501', null::text,
                 'backfill is not callable by a signed-in user');
set local request.jwt.claims to '{"sub":"31000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_field_matches where model = 'category_map'), 0,
          'another office employee sees none (D44)');
set local request.jwt.claims to '{"sub":"31000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_field_matches), 0, 'field operator sees no field matches');
select is((select count(*)::int from public.case_template_category_fields), 0, 'field operator cannot read the template map');
reset role;
set local request.jwt.claims to '{}';
select ok(not has_table_privilege('anon', 'public.case_template_category_fields', 'select'), 'anon has no access to the map');

-- J. backfill (service role) for evidence labelled before the map existed
alter table public.evidence_labels disable trigger trg_evidence_labels_category_map;
select pg_temp.add_file('POLICY(1)_1699999999_6_MAP1.jpg', 6);
alter table public.evidence_labels enable trigger trg_evidence_labels_category_map;
select is(pg_temp.maps('POLICY(1)_1699999999_6_MAP1.jpg'), '', 'labelled while the trigger was off: no map rows');
set local role service_role;
select ok(public.backfill_category_field_matches(100) >= 1, 'backfill fills files labelled before the map');
select is(public.backfill_category_field_matches(100), 0, 'a second backfill has nothing left');
reset role;
set local request.jwt.claims to '{}';
select is(pg_temp.maps('POLICY(1)_1699999999_6_MAP1.jpg'), 'policy_no=0.810@policy_document', 'backfilled rows');

-- K. objects
select has_trigger('public', 'evidence_labels', 'trg_evidence_labels_category_map', 'label trigger exists');
select has_trigger('public', 'evidence_field_matches', 'trg_field_matches_model', 'model match trigger exists');
select policies_are('public', 'case_template_category_fields', array['p_ctcf_read', 'p_ctcf_admin'], 'map policies');

select * from finish();
rollback;
