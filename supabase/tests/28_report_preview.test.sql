-- Report preview for locked cases (20261117500000_report_preview.sql, D51): prepare_report_preview gives the
-- same payload as prepare_report_version in every status for the people who may manage the case, keeps the
-- access rules, and leaves generating (prepare_report_version, create_report_version) strict.
-- Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','28000000-0000-4000-8000-0000000000b1','authenticated','authenticated','rp-off1@example.com',null,'{"role":"office","full_name":"RP Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','28000000-0000-4000-8000-0000000000b2','authenticated','authenticated','rp-off2@example.com',null,'{"role":"office","full_name":"RP Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','28000000-0000-4000-8000-0000000000c1','authenticated','authenticated','rp-orch@example.com',null,'{"role":"orchestrator","full_name":"RP Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','28000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000281','{"role":"field","full_name":"RP Field"}','{}');
insert into public.insurers (id, name, code) values ('28100000-0000-4000-8000-000000000001', 'Report Preview Insurer', 'RPV');
select public.load_case_template('{"insurer_code":"RPV","claim_type":"motor","variant":"od","name":"RPV od","requires_approval":true,
  "output_formats":["pdf"],"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true}]}]}',
  'config/templates/rpv-motor-od.yaml');
insert into public.cases (id, case_ref, insurer_id, insurer_claim_no, claim_type, status, template_id, office_owner_id)
select v.id::uuid, v.ref, '28100000-0000-4000-8000-000000000001', v.ref, 'motor', v.status::public.case_status, t.id, '28000000-0000-4000-8000-0000000000b1'
  from (values ('28300000-0000-4000-8000-000000000001', 'RPV-1', 'office_review'),
               ('28300000-0000-4000-8000-000000000002', 'RPV-2', 'submitted'),
               ('28300000-0000-4000-8000-000000000003', 'RPV-3', 'orchestrator_review')) v(id, ref, status),
       public.case_templates t where t.source_file = 'config/templates/rpv-motor-od.yaml' and t.is_active;
insert into public.cases (id, case_ref, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('28300000-0000-4000-8000-000000000004', 'RPV-4', '28100000-0000-4000-8000-000000000001', 'RPV-4', 'motor', 'office_review', '28000000-0000-4000-8000-0000000000b1');

set local role authenticated;
set local request.jwt.claims to '{"sub":"28000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is(public.prepare_report_preview('28300000-0000-4000-8000-000000000001') ->> 'next_version', '1', 'preview: editable case works');
select is(public.prepare_report_preview('28300000-0000-4000-8000-000000000002') #>> '{case,status}', 'submitted', 'preview: a submitted case works');
select is(public.prepare_report_preview('28300000-0000-4000-8000-000000000003') #>> '{case,status}', 'orchestrator_review', 'preview: a case waiting for approval works');

-- generating stays strict, also right after a preview in the same transaction
select throws_ok($$select public.prepare_report_version('28300000-0000-4000-8000-000000000002')$$, '55000', null, 'generate: prepare still refuses a submitted case after a preview');
select throws_ok($$select public.create_report_version('28300000-0000-4000-8000-000000000002', gen_random_uuid(), 'v1:x', '[]'::jsonb, '[]'::jsonb)$$, '55000', null, 'generate: create still refuses a submitted case');

-- access rules unchanged
select throws_ok($$select public.prepare_report_preview('28300000-0000-4000-8000-000000000004')$$, '22023', null, 'preview: a case without a template is refused');
select throws_ok($$select public.prepare_report_preview('28300000-0000-4000-8000-0000000000ff')$$, 'P0002', null, 'preview: unknown case');
set local request.jwt.claims to '{"sub":"28000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.prepare_report_preview('28300000-0000-4000-8000-000000000001')$$, '42501', null, 'preview: another office user is refused');
set local request.jwt.claims to '{"sub":"28000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.prepare_report_preview('28300000-0000-4000-8000-000000000001')$$, '42501', null, 'preview: field users are refused');
set local request.jwt.claims to '{"sub":"28000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is(public.prepare_report_preview('28300000-0000-4000-8000-000000000002') #>> '{case,status}', 'submitted', 'preview: an orchestrator may preview any case');

select * from finish();
rollback;
