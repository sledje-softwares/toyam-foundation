-- Revised workflow (20261113000100_revised_flow.sql): automatic assignment, reassignment,
-- field tasks, case thread, withdraw, templates, field values, processing queue, labels,
-- approval and submission, notifications. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(93);

-- ---------------------------------------------------------------------
-- Fixture. IDs (prefix 17/27/37...):
--   a1 admin, o1 orchestrator, b1/b2/b3 office (b2 on leave), f1/f2 field
--   insurer RVF with an assignment rule (b1, b2, b3; least loaded)
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000a1','authenticated','authenticated','r-admin@example.com',null,'{"role":"admin","full_name":"R Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000c1','authenticated','authenticated','r-orch@example.com',null,'{"role":"orchestrator","full_name":"R Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000b1','authenticated','authenticated','r-off1@example.com',null,'{"role":"office","full_name":"R Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000b2','authenticated','authenticated','r-off2@example.com',null,'{"role":"office","full_name":"R Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000b3','authenticated','authenticated','r-off3@example.com',null,'{"role":"office","full_name":"R Office 3"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870000001','{"role":"field","full_name":"R Field 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','17000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919870000002','{"role":"field","full_name":"R Field 2"}','{}');
update public.profiles set availability = 'on_leave' where id = '17000000-0000-4000-8000-0000000000b2';

insert into public.insurers (id, name, code, tat_days) values ('27000000-0000-4000-8000-000000000001', 'Revised Insurer', 'RVF', 10);
insert into public.evidence_categories (code, name) values ('r_vehicle_photo', 'Vehicle photo'), ('r_dl_extract', 'DL extract');
insert into public.assignment_rules (id, name, insurer_id, strategy)
values ('28000000-0000-4000-8000-000000000001', 'RVF office pool', '27000000-0000-4000-8000-000000000001', 'least_loaded');
insert into public.assignment_rule_members (rule_id, profile_id) values
 ('28000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b1'),
 ('28000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b2'),
 ('28000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b3');

-- =====================================================================
-- F. Automatic assignment (cases inserted by the intake service)
-- =====================================================================
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('37000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001', 'RVF-1', 'motor');
select is((select office_owner_id from public.cases where id = '37000000-0000-4000-8000-000000000001'),
          '17000000-0000-4000-8000-0000000000b1'::uuid, 'new case auto-assigned to the first eligible rule member');
select is((select status::text || '/' || assignment_method from public.cases where id = '37000000-0000-4000-8000-000000000001'),
          'assigned/auto', 'auto-assigned case is assigned, method auto');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('37000000-0000-4000-8000-000000000002', '27000000-0000-4000-8000-000000000001', 'RVF-2', 'motor');
select is((select office_owner_id from public.cases where id = '37000000-0000-4000-8000-000000000002'),
          '17000000-0000-4000-8000-0000000000b3'::uuid, 'least loaded member gets the next case; member on leave is skipped');
select is((select count(*)::int from public.case_assignments where case_id = '37000000-0000-4000-8000-000000000001' and method = 'auto'), 1,
          'assignment history recorded');
select ok(exists (select 1 from public.case_messages where case_id = '37000000-0000-4000-8000-000000000001' and kind = 'system'
                  and body like 'Case assigned automatically to R Office 1%'), 'system message posted on assignment');
select ok(exists (select 1 from public.notifications where user_id = '17000000-0000-4000-8000-0000000000b1'
                  and kind = 'case_assigned' and case_id = '37000000-0000-4000-8000-000000000001'), 'assignee notified');

-- nobody available: case stays unassigned and orchestrators are notified
update public.profiles set availability = 'unavailable' where role = 'office';
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('37000000-0000-4000-8000-000000000003', '27000000-0000-4000-8000-000000000001', 'RVF-3', 'motor');
select is((select status::text || '/' || coalesce(office_owner_id::text, 'none') from public.cases where id = '37000000-0000-4000-8000-000000000003'),
          'received/none', 'no available staff: case stays received and unassigned');
select ok(exists (select 1 from public.notifications where user_id = '17000000-0000-4000-8000-0000000000c1'
                  and kind = 'case_unassigned' and case_id = '37000000-0000-4000-8000-000000000003'), 'orchestrator notified of unassigned case');
update public.profiles set availability = 'available' where role = 'office' and id <> '17000000-0000-4000-8000-0000000000b2';

-- =====================================================================
-- Reassignment
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$update public.cases set office_owner_id = '17000000-0000-4000-8000-0000000000b3' where id = '37000000-0000-4000-8000-000000000001'$$,
    '42501', null::text, 'office cannot change the assigned employee directly');
select throws_ok($$select public.reassign_case('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b3', 'Busy')$$,
    '42501', null::text, 'office cannot reassign');
select throws_ok($$select public.retry_auto_assign('37000000-0000-4000-8000-000000000003')$$,
    '42501', null::text, 'office cannot run assignment');
select lives_ok($$select public.set_availability('17000000-0000-4000-8000-0000000000b1', 'available')$$, 'user can set own availability');
select throws_ok($$select public.set_availability('17000000-0000-4000-8000-0000000000b3', 'on_leave')$$,
    '42501', null::text, 'office cannot set another user''s availability');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.reassign_case('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b3', 'x')$$,
    '22023', null::text, 'reassignment needs a reason');
select throws_ok($$select public.reassign_case('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000f1', 'Field user')$$,
    '22023', null::text, 'cannot reassign to a field operator');
select lives_ok($$select public.reassign_case('37000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-0000000000b1', 'Office 3 overloaded')$$,
    'orchestrator can reassign');
select is((select office_owner_id::text || '/' || assignment_method from public.cases where id = '37000000-0000-4000-8000-000000000002'),
          '17000000-0000-4000-8000-0000000000b1/manual', 'reassignment applied as manual');
select isnt((select public.retry_auto_assign('37000000-0000-4000-8000-000000000003')), null::uuid,
          'orchestrator can retry automatic assignment once staff are available');

-- =====================================================================
-- I. Field tasks
-- =====================================================================
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b3', 'Visit garage')$$,
    '22023', null::text, 'field task must go to a field operator');
select lives_ok($$select public.create_field_task('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000f1',
                  'Visit garage and spot', 'Check damage and spot', null, 'initial', null, 'Satna')$$,
    'office assigns field work');
select is((select status::text from public.cases where id = '37000000-0000-4000-8000-000000000001'), 'field_in_progress',
          'case moves to field_in_progress when field work is assigned');
select ok(exists (select 1 from public.case_messages where case_id = '37000000-0000-4000-8000-000000000001'
                  and kind = 'system' and body like 'Field work assigned to R Field 1%'), 'assignment posted to the thread');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.create_field_task('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000f1', 'Self task')$$,
    '42501', null::text, 'field cannot create tasks');
select ok(exists (select 1 from public.notifications where kind = 'task_assigned'), 'field operator notified of the task');
select results_eq($$select case_id, list from public.field_case_list()$$,
    $$values ('37000000-0000-4000-8000-000000000001'::uuid, 'open'::text)$$, 'field case list shows the case as open');

-- =====================================================================
-- G. Thread
-- =====================================================================
select lives_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000001', 'text', 'Reached the garage')$$,
    'field posts a text message');
select lives_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000001', 'text', 'Reached the garage')$$,
    'resending the same client message id is accepted');
select is((select count(*)::int from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000001'), 1,
          'resend does not duplicate the message');
select throws_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000009', 'media', null)$$,
    '22023', null::text, 'media message needs files');
select lives_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000002', 'media', 'Garage photos', null, null,
    jsonb_build_array(
      jsonb_build_object('evidence_type','photo','capture_source','camera',
        'storage_path','cases/37000000-0000-4000-8000-000000000001/tasks/' || (select id from public.tasks where case_id = '37000000-0000-4000-8000-000000000001') || '/' || repeat('a1', 32) || '.jpg',
        'sha256', repeat('a1', 32), 'latitude', 24.5, 'longitude', 80.8, 'category_code', 'r_vehicle_photo',
        'ocr', jsonb_build_object('engine','mlkit_device','text','MP19ZS1887','blocks','[]'::jsonb)),
      jsonb_build_object('evidence_type','photo','capture_source','gallery',
        'storage_path','cases/37000000-0000-4000-8000-000000000001/tasks/' || (select id from public.tasks where case_id = '37000000-0000-4000-8000-000000000001') || '/' || repeat('a2', 32) || '.jpg',
        'sha256', repeat('a2', 32)),
      jsonb_build_object('evidence_type','document','capture_source','share','original_filename','estimate.pdf',
        'storage_path','cases/37000000-0000-4000-8000-000000000001/tasks/' || (select id from public.tasks where case_id = '37000000-0000-4000-8000-000000000001') || '/' || repeat('a3', 32) || '.pdf',
        'sha256', repeat('a3', 32))))$$,
    'field posts camera, gallery and shared files in one message');
select is((select count(*)::int from public.evidence where case_id = '37000000-0000-4000-8000-000000000001' and not is_flagged), 3,
          'gallery and shared files are stored without a flag (D18)');
select is((select status::text from public.tasks where case_id = '37000000-0000-4000-8000-000000000001'), 'in_progress',
          'first upload starts the task');
reset role;
select is((select count(*)::int from public.evidence_ocr where text = 'MP19ZS1887'), 1, 'device OCR stored with the evidence');
set local role authenticated;
select is((select count(*)::int from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.case_id = '37000000-0000-4000-8000-000000000001'), 10, 'processing jobs queued (3 per photo, 4 per document)');
select throws_ok($$insert into public.case_messages (case_id, sender_id, kind, body)
                   values ('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000f1', 'system', 'fake')$$,
    '42501', null::text, 'field cannot write system messages');
select throws_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000002', '47000000-0000-4000-8000-000000000003', 'text', 'hello')$$,
    '42501', null::text, 'field cannot post to a case without a task');
update public.case_messages set body = 'edited' where client_message_id = '47000000-0000-4000-8000-000000000001';
select lives_ok($$select public.mark_thread_read('37000000-0000-4000-8000-000000000001')$$, 'field marks the thread read');

-- second operator on the same case sees the thread and the posted evidence
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select body from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000001'), 'Reached the garage',
          'messages cannot be edited');
select lives_ok($$select public.create_field_task('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000f2', 'Meet the insured')$$,
    'second operator assigned');
select lives_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000004', 'text', 'Please collect the DL extract')$$,
    'office replies in the thread');
select ok((select staff_last_read_at is null and field_last_read_at is not null from public.case_thread_state('37000000-0000-4000-8000-000000000001')),
          'thread state reports read times by role');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.evidence where case_id = '37000000-0000-4000-8000-000000000001'), 3,
          'second operator sees evidence posted in the thread');
select is((select count(*)::int from public.case_messages where case_id = '37000000-0000-4000-8000-000000000002'), 0,
          'operator sees no messages of other cases');
select throws_ok($$select public.withdraw_message((select id from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000002'))$$,
    '42501', null::text, 'only the sender can withdraw');
update public.evidence set relevance = 'not_relevant' where case_id = '37000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.evidence where relevance = 'not_relevant'), 0, 'field cannot mark relevance');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$select public.withdraw_message((select id from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000002'))$$,
    'sender withdraws within the window');
select is((select count(*)::int from public.evidence where withdrawn_at is not null and case_id = '37000000-0000-4000-8000-000000000001'), 3,
          'withdrawing a message withdraws its files');
select is((select body from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000002'), null::text,
          'withdrawn message body is cleared');
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select is((select count(*)::int from public.evidence where case_id = '37000000-0000-4000-8000-000000000001'), 0,
          'withdrawn files are hidden from other operators');

-- post again (kept) for the rest of the tests
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select lives_ok($$select public.post_thread_message('37000000-0000-4000-8000-000000000001', '47000000-0000-4000-8000-000000000005', 'media', null, null, null,
    jsonb_build_array(jsonb_build_object('evidence_type','photo','capture_source','camera',
        'storage_path','cases/37000000-0000-4000-8000-000000000001/tasks/' || (select id from public.tasks where case_id = '37000000-0000-4000-8000-000000000001' and assignee_id = '17000000-0000-4000-8000-0000000000f1') || '/' || repeat('b1', 32) || '.jpg',
        'sha256', repeat('b1', 32), 'category_code', 'r_vehicle_photo')))$$,
    'field posts a new photo');
reset role;
update public.app_settings set value = '-1' where key = 'withdraw_window_minutes';
set local role authenticated;
select throws_ok($$select public.withdraw_message((select id from public.case_messages where client_message_id = '47000000-0000-4000-8000-000000000005'))$$,
    '42501', null::text, 'withdraw is refused after the window');
reset role;
update public.app_settings set value = '10' where key = 'withdraw_window_minutes';

-- =====================================================================
-- C/D. Categories and templates
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.load_evidence_categories('[{"code":"r_x","name":"X"}]')$$, '42501', null::text, 'office cannot load categories');
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select is((select public.load_evidence_categories('[{"code":"r_vehicle_photo","name":"Vehicle photo","filename_patterns":["front view"]},
                                                    {"code":"r_dl_extract","name":"DL extract","default_evidence_type":"document"}]')), 2,
          'admin loads categories (upsert by code)');
select is((select (t).version from (select public.load_case_template(
    '{"insurer_code":"RVF","claim_type":"motor","variant":"od","name":"RVF Motor OD","output_formats":["pdf"],
      "sections":[{"key":"insured","title":"Insured details","fields":[{"key":"insured_name","label":"Insured name","source":"intake","required":true}]},
                  {"key":"vehicle","title":"Vehicle","categories":["r_vehicle_photo"],"fields":[{"key":"odometer","label":"Odometer"}]}]}', 'rvf-od.yaml') t) x), 1,
          'admin loads a template (version 1)');
select is((select (t).created from (select public.load_case_template(
    '{"insurer_code":"RVF","claim_type":"motor","variant":"od","name":"RVF Motor OD","output_formats":["pdf"],
      "sections":[{"key":"insured","title":"Insured details","fields":[{"key":"insured_name","label":"Insured name","source":"intake","required":true}]},
                  {"key":"vehicle","title":"Vehicle","categories":["r_vehicle_photo"],"fields":[{"key":"odometer","label":"Odometer"}]}]}', 'rvf-od.yaml') t) x), false,
          'loading the identical config again creates nothing');
select throws_ok($$select public.load_case_template('{"insurer_code":"RVF","claim_type":"motor","variant":"od","name":"Bad",
      "sections":[{"key":"s","title":"S","categories":["no_such_cat"]}]}')$$, '22023', null::text, 'unknown category rejected');
select is((select (t).version from (select public.load_case_template(
    '{"insurer_code":"RVF","claim_type":"motor","variant":"od","name":"RVF Motor OD v2","output_formats":["pdf","docx"],
      "sections":[{"key":"insured","title":"Insured","fields":[{"key":"insured_name","label":"Insured name","source":"intake"}]}]}') t) x), 2,
          'changed config creates version 2');
select is((select count(*)::int from public.case_templates where insurer_id = '27000000-0000-4000-8000-000000000001' and is_active), 1,
          'only one active version per insurer/claim type/variant');
reset role;
update public.cases set template_id = (select id from public.case_templates where insurer_id = '27000000-0000-4000-8000-000000000001' and version = 1)
 where id = '37000000-0000-4000-8000-000000000001';

-- values are written by intake (definer functions) or save_case_field_values (19_report_guards); here as the system
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into public.case_field_values (case_id, field_id, value, source)
                  select '37000000-0000-4000-8000-000000000001', f.id, 'Ravi S', 'email_parser'
                    from public.case_template_fields f join public.case_templates t on t.id = f.template_id
                   where t.version = 1 and t.insurer_id = '27000000-0000-4000-8000-000000000001' and f.key = 'insured_name'$$,
    'intake field value stored');
select lives_ok($$insert into public.case_field_values (case_id, field_id, value)
                  select '37000000-0000-4000-8000-000000000001', f.id, '3267 KM'
                    from public.case_template_fields f join public.case_templates t on t.id = f.template_id
                   where t.version = 1 and t.insurer_id = '27000000-0000-4000-8000-000000000001' and f.key = 'odometer'$$,
    'office field value stored');
select throws_ok($$insert into public.case_field_values (case_id, field_id, value)
                   select '37000000-0000-4000-8000-000000000001', f.id, 'x'
                     from public.case_template_fields f join public.case_templates t on t.id = f.template_id
                    where t.version = 2 and t.insurer_id = '27000000-0000-4000-8000-000000000001' and f.key = 'insured_name'$$,
    '23514', null::text, 'field of another template version rejected');
set local role authenticated;
select lives_ok($$select public.set_evidence_labels((select id from public.evidence where sha256 = repeat('b1', 32)),
                  array[(select id from public.evidence_categories where code = 'r_dl_extract')])$$, 'office corrects labels');
select is((select string_agg(l.source::text || ':' || l.is_active, ',' order by l.source) from public.evidence_labels l
            join public.evidence e on e.id = l.evidence_id where e.sha256 = repeat('b1', 32)),
          'operator:false,human:true', 'correction keeps the operator tag inactive and adds a human label');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select results_eq($$select value from public.case_field_values$$, array['Ravi S'], 'field sees intake fields only');
select results_eq($$select list from public.field_case_list()$$, array['open'], 'case still open for the operator');
select throws_ok($$select public.set_evidence_labels((select id from public.evidence where sha256 = repeat('b1', 32)), '{}')$$,
    '42501', null::text, 'field cannot correct labels');
select throws_ok($$select * from public.claim_processing_jobs(array['ocr']::public.processing_stage[], 5, 'x')$$,
    '42501', null::text, 'field cannot claim processing jobs');

-- =====================================================================
-- H. Processing queue (service role)
-- =====================================================================
reset role;
set local role service_role;
set local request.jwt.claims to '';
select is((select count(*)::int from public.claim_processing_jobs(array['ocr']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.sha256 = repeat('b1', 32)), 0,
          'OCR waits until the label is no longer queued (D34)');
select is((select count(*)::int from public.claim_processing_jobs(array['label']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.sha256 = repeat('b1', 32)), 1, 'label job claimed');
select lives_ok($$select public.complete_processing_job((select j.id from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
                  where e.sha256 = repeat('b1', 32) and j.stage = 'label'), 'failed', 'timeout')$$, 'failed job is accepted');
select is((select status::text from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.sha256 = repeat('b1', 32) and j.stage = 'label'), 'queued', 'failed job is re-queued with back-off');
reset role;
update public.processing_jobs set run_after = now() where status = 'queued';
set local role service_role;
select is((select count(*)::int from public.claim_processing_jobs(array['label']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.sha256 = repeat('b1', 32)), 1, 'retried job claimed again');
select lives_ok($$select public.complete_processing_job((select j.id from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
                  where e.sha256 = repeat('b1', 32) and j.stage = 'label'), 'done')$$, 'label done');
select is((select count(*)::int from public.claim_processing_jobs(array['ocr']::public.processing_stage[], 50, 'w1') j
            join public.evidence e on e.id = j.evidence_id where e.sha256 = repeat('b1', 32)), 1, 'OCR claimable after the label');
select ok((select public.escalate_unattended_cases() >= 0), 'service role can run escalation');
reset role;

-- =====================================================================
-- Task completion -> office review; approval; submission
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.escalate_unattended_cases()$$, '42501', null::text, 'authenticated users cannot run escalation');
-- field users finish work through complete_field_task (20261119100000); a direct update is refused
select public.complete_field_task(t.id) from public.tasks t where t.assignee_id = '17000000-0000-4000-8000-0000000000f1' and t.status in ('pending', 'in_progress');
select is((select status::text from public.cases where id = '37000000-0000-4000-8000-000000000001'), 'field_in_progress',
          'case stays in field work while another task is open');
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select public.complete_field_task(t.id) from public.tasks t where t.assignee_id = '17000000-0000-4000-8000-0000000000f2' and t.status in ('pending', 'in_progress');
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select results_eq($$select list from public.field_case_list()$$, array['completed'], 'case listed as completed for the operator');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select status::text from public.cases where id = '37000000-0000-4000-8000-000000000001'), 'office_review',
          'all field work done: case moves to office review');
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin)
values ('57000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000001', 1,
        'cases/37000000-0000-4000-8000-000000000001/report-v1.pdf', '17000000-0000-4000-8000-0000000000b1', 'uploaded');
-- (an uploaded version: generated versions are recorded only by create_report_version, 20261117000000)
select throws_ok($$insert into public.report_annexures (report_id, evidence_id, position)
                   values ('57000000-0000-4000-8000-000000000001', (select id from public.evidence where sha256 = repeat('a1', 32)), 1)$$,
    '23514', null::text, 'withdrawn evidence cannot be annexed');
select lives_ok($$insert into public.report_annexures (report_id, evidence_id, position)
                  values ('57000000-0000-4000-8000-000000000001', (select id from public.evidence where sha256 = repeat('b1', 32)), 1)$$,
    'evidence annexed to the report');
select throws_ok($$insert into public.submissions (case_id, report_id, channel, submitted_by, formats)
                   values ('37000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000001', 'email', '17000000-0000-4000-8000-0000000000b1', '{pdf}')$$,
    '42501', null::text, 'report cannot be sent before approval');
select lives_ok($$insert into public.report_approvals (case_id, report_id, requested_by)
                  values ('37000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-0000000000b1')$$,
    'office requests approval');
select is((select status::text from public.cases where id = '37000000-0000-4000-8000-000000000001'), 'orchestrator_review',
          'case moves to orchestrator review');
update public.report_approvals set decision = 'approved' where report_id = '57000000-0000-4000-8000-000000000001';
select is((select decision::text from public.report_approvals where report_id = '57000000-0000-4000-8000-000000000001'), 'pending',
          'office cannot approve');

set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$update public.report_approvals set decision = 'approved', comments = 'OK' where report_id = '57000000-0000-4000-8000-000000000001'$$,
    'orchestrator approves');
select is((select decided_by from public.report_approvals where report_id = '57000000-0000-4000-8000-000000000001'),
          '17000000-0000-4000-8000-0000000000c1'::uuid, 'decision stamped with the approver');
select throws_ok($$insert into public.submissions (case_id, report_id, channel, submitted_by, formats)
                   values ('37000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000001', 'email', '17000000-0000-4000-8000-0000000000c1', '{docx}')$$,
    '23514', null::text, 'format not offered by the template is rejected');
select lives_ok($$insert into public.submissions (case_id, report_id, channel, submitted_by, formats, to_addresses)
                  values ('37000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000001', 'email', '17000000-0000-4000-8000-0000000000c1', '{pdf}', '{rcu@insurer.example}')$$,
    'approved report sent as PDF');
select is((select status::text from public.cases where id = '37000000-0000-4000-8000-000000000001'), 'submitted', 'case marked submitted');

-- =====================================================================
-- Notifications and anon
-- =====================================================================
set local request.jwt.claims to '{"sub":"17000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.notifications where user_id <> '17000000-0000-4000-8000-0000000000f1'), 0,
          'users see only their own notifications');
select throws_ok($$update public.notifications set title = 'x' where user_id = '17000000-0000-4000-8000-0000000000f1'$$,
    '42501', null::text, 'notification content cannot be changed');
reset role;
set local role anon;
select throws_ok($$select 1 from public.case_messages$$, '42501', null::text, 'anon has no access to the thread');

select * from finish();
rollback;
