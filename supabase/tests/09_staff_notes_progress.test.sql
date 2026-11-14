-- D30-D32: staff-only messages, report progress / field history, LLM label descriptions,
-- field matches, realtime publication.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000b1','authenticated','authenticated','n-off@example.com',null,'{"role":"office","full_name":"N Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000c1','authenticated','authenticated','n-orch@example.com',null,'{"role":"orchestrator","full_name":"N Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000001','{"role":"field","full_name":"N Field"}','{}');
insert into public.insurers (id, name, code) values ('29000000-0000-4000-8000-0000000000a1', 'Notes Insurer', 'NTS');
insert into public.assignment_rules (id, name, insurer_id) values ('29100000-0000-4000-8000-000000000001', 'NTS pool', '29000000-0000-4000-8000-0000000000a1');
insert into public.assignment_rule_members values ('29100000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000b1');
select public.load_case_template('{"insurer_code":"NTS","claim_type":"motor","variant":"od","name":"NTS OD","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[
      {"key":"insurer_claim_no","label":"Claim","source":"intake","required":true},
      {"key":"insured_name","label":"Name","source":"intake","required":true}]},
    {"key":"garage","title":"Garage","fields":[
      {"key":"odometer","label":"Odometer","required":true},
      {"key":"job_card_no","label":"Job card"}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, orchestrator_id)
select '39000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-0000000000a1', 'NTS-1', 'motor', t.id,
       '19000000-0000-4000-8000-0000000000c1'
  from public.case_templates t join public.insurers i on i.id = t.insurer_id where i.code = 'NTS' and t.is_active;

-- =====================================================================
-- A. Staff-only messages
-- =====================================================================
select is((select visibility from public.case_messages where case_id = '39000000-0000-4000-8000-000000000001'
            and body like 'Case assigned automatically%'), 'staff', 'assignment event is staff-only');

set local role authenticated;
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.create_field_task('39000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000f1', 'Visit garage')$$,
    'office assigns field work');
select is((select visibility from public.case_messages where case_id = '39000000-0000-4000-8000-000000000001'
            and body like 'Field work assigned%'), 'all', 'task event is visible to everyone on the case');
select lives_ok($$select public.post_staff_note('39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001',
                  'Use the second DL photo, the first is blurred')$$, 'office writes a staff note');
select lives_ok($$select public.post_staff_note('39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001',
                  'Use the second DL photo, the first is blurred')$$, 'resending the note is accepted');
select is((select count(*)::int from public.case_messages where client_message_id = '49000000-0000-4000-8000-000000000001'), 1,
          'note stored once');
select throws_ok($$select public.post_staff_note('39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000002', '  ')$$,
    '22023', null::text, 'empty note rejected');
-- staff-only media message with a case-level file
select lives_ok($$insert into public.case_messages (id, case_id, sender_id, kind, body, visibility)
                  values ('49100000-0000-4000-8000-000000000001', '39000000-0000-4000-8000-000000000001',
                          '19000000-0000-4000-8000-0000000000b1', 'media', 'internal reference', 'staff')$$,
    'office posts a staff-only media message');
select lives_ok($$insert into public.evidence (case_id, message_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                  values ('39000000-0000-4000-8000-000000000001', '49100000-0000-4000-8000-000000000001', 'photo', 'web_upload',
                          'cases/39000000-0000-4000-8000-000000000001/files/' || repeat('c1', 32) || '.jpg', repeat('c1', 32),
                          '19000000-0000-4000-8000-0000000000b1')$$,
    'with a file');
select is((select count(*)::int from public.notifications where kind = 'staff_note'), 0,
          'the author of a note is not notified');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select public.post_staff_note('39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000003',
                  'Garage section still empty — please check')$$, 'orchestrator replies with a staff note');
select ok(exists (select 1 from public.notifications where kind = 'staff_note' and title like '%note from N Office'),
          'case orchestrator notified of the office note');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select ok(exists (select 1 from public.notifications where kind = 'staff_note' and title like '%note from N Orch'),
          'case owner notified of the orchestrator''s note');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.case_messages where case_id = '39000000-0000-4000-8000-000000000001'), 1,
          'field user sees only the task event, no staff messages');
select is((select count(*)::int from public.evidence where case_id = '39000000-0000-4000-8000-000000000001'), 0,
          'files in staff-only messages are hidden from field users');
select is((select last_message_preview from public.field_case_list() where case_id = '39000000-0000-4000-8000-000000000001'),
          'Field work assigned to N Field: Visit garage', 'field case list ignores staff messages');
select throws_ok($$select public.post_staff_note('39000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000004', 'hi')$$,
    '42501', null::text, 'field cannot write staff notes');
select throws_ok($$insert into public.case_messages (case_id, sender_id, kind, body, visibility)
                   values ('39000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-0000000000f1', 'text', 'x', 'staff')$$,
    '42501', null::text, 'field cannot post staff-only messages');

-- =====================================================================
-- B. Report progress and field history
-- =====================================================================
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
insert into public.case_field_values (case_id, field_id, value, source)
select '39000000-0000-4000-8000-000000000001', f.id, v.val, v.src::public.field_value_source
  from public.case_template_fields f
  join public.cases c on c.template_id = f.template_id and c.id = '39000000-0000-4000-8000-000000000001'
  join (values ('insurer_claim_no', 'NTS-1', 'email_parser'), ('insured_name', 'Test Person', 'email_parser'), ('odometer', '3,200 km', 'suggestion')) v(key, val, src)
    on v.key = f.key;
update public.case_field_values set value = '3,267 km', source = 'office'
 where case_id = '39000000-0000-4000-8000-000000000001'
   and field_id = (select f.id from public.case_template_fields f join public.cases c on c.template_id = f.template_id
                    where c.id = '39000000-0000-4000-8000-000000000001' and f.key = 'odometer');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select results_eq($$select section_key, fields_total::int, required_total::int, fields_filled::int, required_filled::int
                      from public.v_report_progress where case_id = '39000000-0000-4000-8000-000000000001' order by position$$,
    $$values ('insured'::text, 2, 2, 2, 2), ('garage'::text, 2, 1, 1, 1)$$, 'orchestrator sees progress per section');
select results_eq($$select from_email::int, entered::int from public.v_report_progress
                      where case_id = '39000000-0000-4000-8000-000000000001' order by position$$,
    $$values (2, 0), (0, 1)$$, 'progress shows where values came from');
select is((select last_updated_by from public.v_report_progress where case_id = '39000000-0000-4000-8000-000000000001' and section_key = 'garage'),
          '19000000-0000-4000-8000-0000000000b1'::uuid, 'progress shows who last changed a section');
select results_eq($$select field_key, actor_name, old_value, new_value from public.case_field_history('39000000-0000-4000-8000-000000000001')
                      where action = 'UPDATE'$$,
    $$values ('odometer'::text, 'N Office'::text, '3,200 km'::text, '3,267 km'::text)$$, 'orchestrator sees who changed which value');
select is((select count(*)::int from public.case_field_history('39000000-0000-4000-8000-000000000001')), 4,
          'history lists every change');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.v_report_progress), 0, 'field users see no report progress');
select is((select count(*)::int from public.case_field_history('39000000-0000-4000-8000-000000000001')), 0, 'field users see no field history');

-- =====================================================================
-- C. LLM labels and field matches
-- =====================================================================
reset role;
set local role service_role;
set local request.jwt.claims to '';
insert into public.evidence_categories (code, name) values ('n_odometer', 'Odometer') on conflict do nothing;
select lives_ok($$insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, description)
                  select e.id, c.id, 0.93, 'llm', 'v1', 'Odometer of a two-wheeler showing 3,267 km'
                    from public.evidence e, public.evidence_categories c where e.sha256 = repeat('c1', 32) and c.code = 'n_odometer'$$,
    'pipeline stores an LLM label with a description');
select lives_ok($$insert into public.evidence_field_matches (evidence_id, field_id, score, model)
                  select e.id, f.id, 0.88, 'cross-encoder-test'
                    from public.evidence e, public.case_template_fields f join public.cases c on c.template_id = f.template_id
                   where e.sha256 = repeat('c1', 32) and c.id = '39000000-0000-4000-8000-000000000001' and f.key = 'odometer'$$,
    'pipeline stores a field match');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select m.score from public.evidence_field_matches m join public.case_template_fields f on f.id = m.field_id where f.key = 'odometer'),
          0.88::real, 'office reads field matches');
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_field_matches), 0, 'field users cannot read field matches');

-- =====================================================================
-- D. Realtime
-- =====================================================================
reset role;
select results_eq($$select tablename::text collate "default" from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
                      and tablename in ('case_messages', 'case_field_values', 'evidence_labels', 'notifications') order by 1$$,
    array['case_field_values', 'case_messages', 'evidence_labels', 'notifications'], 'thread, values, labels and notifications are published');

select * from finish();
rollback;
