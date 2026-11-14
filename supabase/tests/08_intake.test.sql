-- M3 intake: intake_config(), intake_ingest(), confirm_intake(), reject_intake().
-- Decisions are written here as the parser (supabase/functions/_shared/intake) produces them.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

-- ---------------------------------------------------------------------
-- Fixture: office b1 (rule member), orchestrator o1, field f1; insurer TIN with one template
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','18000000-0000-4000-8000-0000000000b1','authenticated','authenticated','i-off@example.com',null,'{"role":"office","full_name":"I Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','18000000-0000-4000-8000-0000000000c1','authenticated','authenticated','i-orch@example.com',null,'{"role":"orchestrator","full_name":"I Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','18000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919860000001','{"role":"field","full_name":"I Field"}','{}');
insert into public.insurers (id, name, code, sender_domains) values ('28000000-0000-4000-8000-0000000000a1', 'Intake Insurer', 'TIN', '{tin.example}');
insert into public.assignment_rules (id, name, insurer_id) values ('28100000-0000-4000-8000-000000000001', 'TIN pool', '28000000-0000-4000-8000-0000000000a1');
insert into public.assignment_rule_members values ('28100000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-0000000000b1');
create temp table t_tpl as
select (r).template_id as id from (select public.load_case_template('{
  "insurer_code":"TIN","claim_type":"motor","variant":"od","name":"TIN OD",
  "intake_rules":{"subject_pattern":"^(?:re:\\s*)*OD \\|\\| (\\d+)","subject_groups":{"insurer_claim_no":1}},
  "sections":[{"key":"insured","title":"Insured","fields":[
      {"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true},
      {"key":"insured_name","label":"Insured","source":"intake","required":true,"extract":{"labels":["Insured Name"]}},
      {"key":"policy_no","label":"Policy","source":"intake","required":true,"extract":{"labels":["Policy Number"]}},
      {"key":"insured_mobile","label":"Mobile","source":"intake","extract":{"labels":["Mobile Number"],"within":"Insured Details"}},
      {"key":"investigation_points","label":"Points","type":"long_text","source":"intake"},
      {"key":"driver_name","label":"Driver","source":"intake"},
      {"key":"odometer","label":"Odometer"}]}]}') r) x;
grant select on t_tpl to authenticated, service_role;

-- decision builder (shape of IntakeDecision)
create function pg_temp.decision(p_msg text, p_action text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'parser_version','rules-v1','message_id',p_msg,'thread_id',null,'in_reply_to',null,'references','[]'::jsonb,
    'from_address','rcu@tin.example','from_name','RCU','to','["toyaminvestigation@gmail.com"]'::jsonb,'cc','[]'::jsonb,
    'subject','OD || 9100000001 || Test Insured','received_at','2026-11-13T05:00:00Z','body_text','Dear team',
    'raw_storage_path','emails/2026/11/' || md5(p_msg) || '/message.eml','raw_sha256', encode(extensions.digest(p_msg, 'sha256'), 'hex'),
    'is_internal',false,'insurer_id','28000000-0000-4000-8000-0000000000a1','template_id',(select id from t_tpl),
    'classification','new_case','action',p_action,'claim_no','9100000001',
    'fields', jsonb_build_object(
        'insurer_claim_no', jsonb_build_object('value','9100000001','confidence',1,'source','subject'),
        'insured_name', jsonb_build_object('value','Test Insured','confidence',0.95,'source','table'),
        'policy_no', jsonb_build_object('value','POL-0001','confidence',0.95,'source','table'),
        'insured_mobile', jsonb_build_object('value','9000000001','confidence',0.95,'source','table'),
        'investigation_points', jsonb_build_object('value','1. Verify the driver','confidence',0.9,'source','block'),
        'driver_name', jsonb_build_object('value','Test Driver','confidence',0.95,'source','table')),
    'missing_required','[]'::jsonb,
    'attachments', jsonb_build_array(
        jsonb_build_object('filename','Front View(1).jpg','mime_type','image/jpeg','size_bytes',120000,
            'sha256', encode(extensions.digest(p_msg || 'a1', 'sha256'), 'hex'), 'storage_path','emails/x/' || md5(p_msg) || '/a1.jpg',
            'content_id',null,'is_inline',false,'evidence',true),
        jsonb_build_object('filename','image001.png','mime_type','image/png','size_bytes',3000,
            'sha256', encode(extensions.digest(p_msg || 'logo', 'sha256'), 'hex'), 'storage_path','emails/x/' || md5(p_msg) || '/logo.png',
            'content_id','logo','is_inline',true,'evidence',false)),
    'notes','[]'::jsonb) || p_extra;
$$;
grant execute on function pg_temp.decision(text, text, jsonb) to authenticated, service_role;

-- =====================================================================
-- Access
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.intake_config()$$, '42501', null::text, 'staff cannot read the intake config');
select throws_ok($$select public.intake_ingest(pg_temp.decision('m-x@tin', 'create_case'))$$, '42501', null::text, 'staff cannot ingest');
reset role;

set local role service_role;
set local request.jwt.claims to '';
select is((select jsonb_array_length(t->'fields') from jsonb_array_elements(public.intake_config()->'templates') t
            where t->>'insurer_code' = 'TIN'), 6, 'config carries the intake fields only');
select ok((select public.intake_config()->'internal_domains' ? 'toyaminvestigation.in'), 'config carries the firm''s domains');
select ok(exists (select 1 from jsonb_array_elements(public.intake_config()->'insurers') i
                   where i->>'code' = 'TIN' and i->'domains' ? 'tin.example'), 'config carries insurer domains');

-- =====================================================================
-- New case
-- =====================================================================
select is((select public.intake_ingest(pg_temp.decision('m-1@tin', 'create_case'))->>'result'), 'created', 'complete intimation creates a case');
reset role;
create temp table t_case as select id from public.cases where insurer_claim_no = '9100000001';
grant select on t_case to authenticated, service_role;
select is((select count(*)::int from t_case), 1, 'one case');
select is((select template_id from public.cases where id = (select id from t_case)), (select id from t_tpl), 'case carries the template');
select is((select policy_no || '/' || suspicion_summary from public.cases where id = (select id from t_case)),
          'POL-0001/1. Verify the driver', 'policy number and investigation points copied to the case');
select is((select count(*)::int from public.case_field_values where case_id = (select id from t_case)), 6, 'intake values stored');
select is((select v.source::text from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
            where v.case_id = (select id from t_case) and f.key = 'insured_name'), 'email_parser', 'value source recorded');
select is((select string_agg(role::text || ':' || name, ',' order by role) from public.parties where case_id = (select id from t_case)),
          'insured:Test Insured,driver:Test Driver', 'insured and driver parties created');
select is((select office_owner_id from public.cases where id = (select id from t_case)),
          '18000000-0000-4000-8000-0000000000b1'::uuid, 'new case auto-assigned');
select is((select status::text || '/' || classification::text from public.emails where gmail_message_id = 'm-1@tin'),
          'processed/new_case', 'email processed and classified');
select is((select case_id from public.emails where gmail_message_id = 'm-1@tin'), (select id from t_case), 'email linked to the case');
select is((select count(*)::int from public.email_attachments a join public.emails e on e.id = a.email_id where e.gmail_message_id = 'm-1@tin'), 2,
          'both attachments recorded');
select is((select count(*)::int from public.evidence where case_id = (select id from t_case)), 1, 'only the evidence attachment became evidence');
select is((select capture_source::text || '/' || storage_backend || '/' || original_filename from public.evidence where case_id = (select id from t_case)),
          'email_attachment/supabase/Front View(1).jpg', 'insurer file stored as email_attachment evidence');
select is((select count(*)::int from public.processing_jobs j join public.evidence e on e.id = j.evidence_id where e.case_id = (select id from t_case)), 3,
          'insurer photo queued for processing');
select is((select x.status::text from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-1@tin'),
          'confirmed', 'parser output kept as a confirmed extraction');

-- =====================================================================
-- Duplicates and follow-ups
-- =====================================================================
set local role service_role;
select is((select public.intake_ingest(pg_temp.decision('m-1@tin', 'create_case'))->>'result'), 'duplicate', 'same Message-ID is a duplicate');
select is((select public.intake_ingest(pg_temp.decision('m-2@tin', 'attach_to_case', jsonb_build_object(
            'subject','RE: OD || 9100000001 || Test Insured','in_reply_to','m-1@tin','classification','reminder','claim_no',null,'fields','{}'::jsonb)))->>'result'),
          'attached', 'reply on the thread is attached to the case');
select is((select public.intake_ingest(pg_temp.decision('m-3@tin', 'attach_to_case', jsonb_build_object(
            'classification','additional_docs','fields','{}'::jsonb)))->>'result'),
          'attached', 'follow-up without thread headers is matched by claim number');
select is((select public.intake_ingest(pg_temp.decision('m-4@tin', 'create_case'))->>'result'), 'attached',
          'intimation re-sent for an existing claim is attached, not a second case');
select is((select public.intake_ingest(pg_temp.decision('m-5@firm', 'internal', jsonb_build_object(
            'is_internal',true,'insurer_id',null,'from_address','gi@toyaminvestigation.in','in_reply_to','m-1@tin','classification','other')))->>'result'),
          'internal_linked', 'firm''s own reply is linked to the case');
select is((select public.intake_ingest(pg_temp.decision('m-6@shop', 'unmatched', jsonb_build_object(
            'insurer_id',null,'template_id',null,'claim_no',null,'from_address','promo@shop.example')))->>'result'),
          'unmatched', 'unknown sender is unmatched');
reset role;
select is((select count(*)::int from public.cases where insurer_claim_no = '9100000001'), 1, 'still one case');
select is((select string_agg(classification::text, ',' order by gmail_message_id) from public.emails where case_id = (select id from t_case)),
          'new_case,reminder,additional_docs,other,other', 'follow-ups linked and classified');
select is((select count(*)::int from public.evidence where case_id = (select id from t_case)), 4,
          'insurer follow-ups add their files (firm mail does not)');
select ok(exists (select 1 from public.notifications where user_id = '18000000-0000-4000-8000-0000000000b1' and kind = 'insurer_email'),
          'case owner notified of insurer emails');
select is((select status::text || '/' || coalesce(case_id::text, 'none') from public.emails where gmail_message_id = 'm-6@shop'),
          'ignored/none', 'unmatched email ignored');

-- =====================================================================
-- Review queue
-- =====================================================================
set local role service_role;
select is((select public.intake_ingest(pg_temp.decision('m-7@tin', 'review', jsonb_build_object(
            'subject','OD || 9100000007 || Second','claim_no','9100000007','missing_required','["policy_no"]'::jsonb,
            'notes','["Missing required: policy_no"]'::jsonb)))->>'result'),
          'review', 'missing required field goes to review');
select is((select public.intake_ingest(pg_temp.decision('m-8@tin', 'create_case', jsonb_build_object(
            'claim_no','9100000008','template_id','00000000-0000-4000-8000-000000000000')))->>'result'),
          'review', 'unknown template id is downgraded to review');
select is((select public.intake_ingest(pg_temp.decision('m-9@tin', 'attach_to_case', jsonb_build_object(
            'claim_no','9199999999','in_reply_to','not-known@tin')))->>'result'),
          'review', 'reply for an unknown case goes to review');
reset role;
select is((select count(*)::int from public.cases where insurer_claim_no in ('9100000007', '9100000008', '9199999999')), 0, 'review items create no case');
select ok(exists (select 1 from public.notifications where user_id = '18000000-0000-4000-8000-0000000000c1' and kind = 'intake_review'),
          'orchestrator notified of review items');

set local role authenticated;
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.confirm_intake((select x.id from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-7@tin'),
                   (select id from t_tpl), '{"insurer_claim_no":"9100000007"}')$$, '42501', null::text, 'field cannot confirm intake');
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.confirm_intake((select x.id from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-7@tin'),
                   (select id from t_tpl), '{"insurer_claim_no":"9100000007","insured_name":"Second"}')$$, '22023', null::text,
                 'confirmation needs every required field');
select isnt((select public.confirm_intake((select x.id from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-7@tin'),
                   (select id from t_tpl), '{"insurer_claim_no":"9100000007","insured_name":"Second","policy_no":"POL-0007"}')), null::uuid,
            'office confirms a corrected review item');
select is((select x.status::text || '/' || (x.reviewed_by = '18000000-0000-4000-8000-0000000000b1') from public.intake_extractions x
             join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-7@tin'), 'confirmed/true', 'confirmation recorded with reviewer');
select is((select c.policy_no from public.cases c join public.emails e on e.case_id = c.id where e.gmail_message_id = 'm-7@tin'), 'POL-0007',
          'confirmed case created from the corrected values');
select is((select v.source::text from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
             join public.cases c on c.id = v.case_id where c.insurer_claim_no = '9100000007' and f.key = 'policy_no'), 'office',
          'corrected values recorded as office input');
select lives_ok($$select public.reject_intake((select x.id from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-8@tin'), 'Duplicate of an earlier mail')$$,
    'office dismisses a review item');
select is((select x.status::text || '/' || e.status::text from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-8@tin'),
          'rejected/ignored', 'dismissed item and its email are closed');
select throws_ok($$select public.reject_intake((select x.id from public.intake_extractions x join public.emails e on e.id = x.email_id where e.gmail_message_id = 'm-8@tin'), 'again')$$,
    'P0002', null::text, 'a dismissed item cannot be dismissed twice');

-- =====================================================================
-- Failures and retry
-- =====================================================================
reset role;
set local role service_role;
select isnt((select public.intake_record_failure('m-bad@tin', 'emails/2026/11/bad/message.eml', 'Malformed MIME', 'Broken', 'rcu@tin.example')), null::uuid,
            'parser failure recorded');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.intake_retry((select id from public.emails where gmail_message_id = 'm-bad@tin'))$$, '42501', null::text,
                 'field cannot retry intake');
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select status::text || '/' || error from public.emails where gmail_message_id = 'm-bad@tin'), 'failed/Malformed MIME', 'failed email visible to staff');
select is((select public.intake_retry((select id from public.emails where gmail_message_id = 'm-bad@tin'))), 'emails/2026/11/bad/message.eml',
          'retry clears the failed row and returns the raw path');
select throws_ok($$select public.intake_retry((select id from public.emails where gmail_message_id = 'm-1@tin'))$$, '22023', null::text,
                 'processed emails cannot be retried');

-- =====================================================================
-- Field users never see insurer files
-- =====================================================================
select lives_ok($$select public.create_field_task((select id from t_case), '18000000-0000-4000-8000-0000000000f1', 'Visit the garage')$$,
    'office assigns field work on the intake case');
set local request.jwt.claims to '{"sub":"18000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.evidence where case_id = (select id from t_case)), 0, 'field operator cannot see insurer attachments');
select is((select count(*)::int from public.emails), 0, 'field operator cannot see emails');

select * from finish();
rollback;
