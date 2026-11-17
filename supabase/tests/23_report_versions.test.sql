-- Report versions and shrunk image copies (20261117000000_report_versions.sql, D51, gaps G1 / G2):
-- evidence_derivatives (RLS, server / device RPCs, path scheme, idempotency, skipped → ready),
-- prepare_report_version (scope, status guards, default photo selection), create_report_version
-- (values token, files, photos, snapshot, audit, idempotent retry), generated versions are records,
-- `reports` storage for generated files, approval / portal pack / manual submission on a generated
-- version. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(112);

-- ---------------------------------------------------------------------
-- Fixture: a1 admin, c1 orchestrator, b1 office (owns R1–R6), b2 office (owns R7), f1 / f2 field.
-- Insurer RVT. Template "free" (pdf + docx, approval): sections claim (insurer_claim_no, required),
-- vehicle [rv_vehicle, rv_dl] (odometer), driver [rv_dl] (driver_name, required). Template "pdfonly".
--   R1 free, office_review → field_in_progress by task T1 (f1)   R2 free, submitted
--   R3 free, orchestrator_review   R5 pdfonly, office_review   R6 free, T6 f1 → reassigned to f2
--   R7 free, owned by b2
-- R1 files (f1 unless noted): E1 vehicle, E7 vehicle, E9 vehicle (b1 web upload), E2 dl (description),
--   E3 vehicle not relevant, E6 vehicle withdrawn, E4 unlabelled photo, E5 pdf (rv_doc)
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000a1','authenticated','authenticated','rv-admin@example.com',null,'{"role":"admin","full_name":"RV Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000c1','authenticated','authenticated','rv-orch@example.com',null,'{"role":"orchestrator","full_name":"RV Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000b1','authenticated','authenticated','rv-off1@example.com',null,'{"role":"office","full_name":"RV Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000b2','authenticated','authenticated','rv-off2@example.com',null,'{"role":"office","full_name":"RV Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000231','{"role":"field","full_name":"RV Field 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','23000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919850000232','{"role":"field","full_name":"RV Field 2"}','{}');
insert into public.insurers (id, name, code) values ('23100000-0000-4000-8000-000000000001', 'Report Version Insurer', 'RVT');
insert into public.evidence_categories (id, code, name) values
 ('23900000-0000-4000-8000-000000000001', 'rv_vehicle', 'Vehicle photo'),
 ('23900000-0000-4000-8000-000000000002', 'rv_dl', 'Driving licence'),
 ('23900000-0000-4000-8000-000000000003', 'rv_doc', 'Claim document');
select public.load_case_template('{"insurer_code":"RVT","claim_type":"motor","variant":"free","name":"RVT free","requires_approval":true,
  "output_formats":["pdf","docx"],"sections":[
    {"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true}]},
    {"key":"vehicle","title":"Vehicle","categories":["rv_vehicle","rv_dl"],"fields":[{"key":"odometer","label":"Odometer","type":"number"}]},
    {"key":"driver","title":"Driver","categories":["rv_dl"],"fields":[{"key":"driver_name","label":"Driver name","required":true}]}]}',
  'config/templates/rvt-motor-free.yaml');
select public.load_case_template('{"insurer_code":"RVT","claim_type":"motor","variant":"pdfonly","name":"RVT pdf","requires_approval":true,
  "output_formats":["pdf"],"sections":[{"key":"claim","title":"Claim","categories":["rv_vehicle"],
    "fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true}]}]}');
update public.case_templates set report_layout = '{"pages":[{"kind":"cover"}]}' where variant = 'free'
   and insurer_id = '23100000-0000-4000-8000-000000000001';

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select v.id::uuid, '23100000-0000-4000-8000-000000000001', v.claim, 'motor', t.id, v.owner::uuid, v.st::public.case_status
  from (values ('23300000-0000-4000-8000-000000000001', 'RVT-1', 'free',    'office_review',       '23000000-0000-4000-8000-0000000000b1'),
               ('23300000-0000-4000-8000-000000000002', 'RVT-2', 'free',    'submitted',           '23000000-0000-4000-8000-0000000000b1'),
               ('23300000-0000-4000-8000-000000000003', 'RVT-3', 'free',    'orchestrator_review', '23000000-0000-4000-8000-0000000000b1'),
               ('23300000-0000-4000-8000-000000000005', 'RVT-5', 'pdfonly', 'office_review',       '23000000-0000-4000-8000-0000000000b1'),
               ('23300000-0000-4000-8000-000000000006', 'RVT-6', 'free',    'office_review',       '23000000-0000-4000-8000-0000000000b1'),
               ('23300000-0000-4000-8000-000000000007', 'RVT-7', 'free',    'office_review',       '23000000-0000-4000-8000-0000000000b2')) v(id, claim, variant, st, owner)
  join public.case_templates t on t.variant = v.variant and t.is_active and t.insurer_id = '23100000-0000-4000-8000-000000000001';
insert into public.case_field_values (case_id, field_id, value)
select c.id, f.id, case f.key when 'insurer_claim_no' then c.insurer_claim_no else 'Ramesh K' end
  from public.cases c join public.case_template_fields f on f.template_id = c.template_id
 where c.insurer_id = '23100000-0000-4000-8000-000000000001' and c.id in ('23300000-0000-4000-8000-000000000001', '23300000-0000-4000-8000-000000000005')
   and f.key in ('insurer_claim_no', 'driver_name');

insert into public.tasks (id, case_id, title, assignee_id) values
 ('23400000-0000-4000-8000-000000000001', '23300000-0000-4000-8000-000000000001', 'Spot visit', '23000000-0000-4000-8000-0000000000f1'),
 ('23400000-0000-4000-8000-000000000006', '23300000-0000-4000-8000-000000000006', 'Garage visit', '23000000-0000-4000-8000-0000000000f1');

create temp table ev (k text primary key, id uuid, sha text, typ text, by_f1 boolean) on commit drop;
insert into ev values
 ('e1', '23800000-0000-4000-8000-000000000001', md5('rv-e1') || md5('rv-e1'), 'photo', true),
 ('e2', '23800000-0000-4000-8000-000000000002', md5('rv-e2') || md5('rv-e2'), 'photo', true),
 ('e3', '23800000-0000-4000-8000-000000000003', md5('rv-e3') || md5('rv-e3'), 'photo', true),
 ('e4', '23800000-0000-4000-8000-000000000004', md5('rv-e4') || md5('rv-e4'), 'photo', true),
 ('e5', '23800000-0000-4000-8000-000000000005', md5('rv-e5') || md5('rv-e5'), 'document', true),
 ('e6', '23800000-0000-4000-8000-000000000006', md5('rv-e6') || md5('rv-e6'), 'photo', true),
 ('e7', '23800000-0000-4000-8000-000000000007', md5('rv-e7') || md5('rv-e7'), 'photo', true),
 ('e9', '23800000-0000-4000-8000-000000000009', md5('rv-e9') || md5('rv-e9'), 'photo', false),
 ('e61', '23800000-0000-4000-8000-000000000061', md5('rv-e61') || md5('rv-e61'), 'photo', true);
grant select on ev to authenticated, service_role;
insert into public.evidence (id, case_id, task_id, evidence_type, capture_source, storage_path, mime_type, sha256, captured_by)
select ev.id, c.cid, case when ev.by_f1 then c.tid end, ev.typ::public.evidence_type,
       case when ev.by_f1 then (case when ev.typ = 'document' then 'gallery' else 'camera' end) else 'web_upload' end::public.capture_source,
       'cases/' || c.cid || case when ev.by_f1 then '/tasks/' || c.tid else '/files' end || '/' || ev.sha
       || case when ev.typ = 'document' then '.pdf' else '.jpg' end,
       case when ev.typ = 'document' then 'application/pdf' else 'image/jpeg' end, ev.sha,
       case when ev.by_f1 then '23000000-0000-4000-8000-0000000000f1' else '23000000-0000-4000-8000-0000000000b1' end::uuid
  from ev cross join lateral (select case when ev.k = 'e61' then '23300000-0000-4000-8000-000000000006'::uuid else '23300000-0000-4000-8000-000000000001'::uuid end cid,
                                     case when ev.k = 'e61' then '23400000-0000-4000-8000-000000000006'::uuid else '23400000-0000-4000-8000-000000000001'::uuid end tid) c;
insert into public.evidence_labels (evidence_id, category_id, confidence, source, description)
select ev.id, v.cat::uuid, 0.9, 'model', v.descr
  from (values ('e1', '23900000-0000-4000-8000-000000000001', null), ('e7', '23900000-0000-4000-8000-000000000001', null),
               ('e9', '23900000-0000-4000-8000-000000000001', null), ('e2', '23900000-0000-4000-8000-000000000002', 'Driving licence front'),
               ('e3', '23900000-0000-4000-8000-000000000001', null), ('e6', '23900000-0000-4000-8000-000000000001', null),
               ('e5', '23900000-0000-4000-8000-000000000003', null)) v(k, cat, descr)
  join ev on ev.k = v.k;
update public.evidence set relevance = 'not_relevant' where id = '23800000-0000-4000-8000-000000000003';
update public.evidence set withdrawn_at = now(), withdrawn_by = captured_by where id = '23800000-0000-4000-8000-000000000006';
-- R6: f1's task moves to f2 (f1's hold closes now)
update public.tasks set assignee_id = '23000000-0000-4000-8000-0000000000f2' where id = '23400000-0000-4000-8000-000000000006';

create temp table tok (k text primary key, v text) on commit drop;
grant select, insert, update on tok to authenticated;
create function pg_temp.dpath(p_case text, p_k text, p_w int, p_copy text default 'd') returns text language sql as $$
  select 'derived/' || p_case || '/' || (select sha from ev where k = p_k) || '/w' || p_w || '-' || repeat(p_copy, 64) || '.jpg' $$;
grant execute on function pg_temp.dpath(text, text, int, text) to authenticated, service_role;
create function pg_temp.files(p_case text, p_report text, p_formats text[], p_size int default 1234) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('format', f, 'storage_path', p_case || '/' || p_report || '/report.' || f,
                                      'sha256', repeat('c', 64), 'size_bytes', p_size)) from unnest(p_formats) f $$;
grant execute on function pg_temp.files(text, text, text[], int) to authenticated;
create temp table prep (j jsonb) on commit drop;
grant select, insert on prep to authenticated;

select has_table('public', 'evidence_derivatives', 'evidence_derivatives exists');
select has_column('public', 'case_templates', 'report_layout', 'case_templates.report_layout exists');
select has_column('public', 'reports', 'field_values', 'reports.field_values exists');
select is((select status::text from public.cases where id = '23300000-0000-4000-8000-000000000001'), 'field_in_progress', 'fixture: R1 has open field work');
select hasnt_function('public', 'record_server_derivative', 'no server-side shrinking (copies come from the field app only)');
select ok(not has_function_privilege('anon', 'public.record_device_derivative(uuid, text, int, text, text, bigint, int, int)', 'execute'),
          'anon may not record device copies');
select ok(not has_function_privilege('anon', 'public.prepare_report_version(uuid)', 'execute'), 'anon may not prepare versions');
select ok(not has_function_privilege('anon', 'public.create_report_version(uuid, uuid, text, jsonb, jsonb, text)', 'execute'), 'anon may not create versions');

-- =====================================================================
-- A. Device copies (field app)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 800,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 800, 'd'), repeat('d', 64), 1000, 800, 600)$$,
                 '22023', null, 'device: only 384 or 1600');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
                   'derived/elsewhere/w1600.jpg', repeat('d', 64), 1000, 1600, 1200)$$,
                 '22023', null, 'device: the path must follow the scheme');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'd'), 'NOT-HEX', 1000, 1600, 1200)$$,
                 '22023', null, 'device: the copy needs a SHA-256');
select is((public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
           pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'd'), repeat('d', 64), 250000, 1600, 1200)) ->> 'recorded',
          'true', 'device: the operator records the 1600 copy of their photo');
select is((public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 384,
           pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 384, 'e'), repeat('e', 64), 30000, 384, 288)) ->> 'recorded',
          'true', 'device: and the 384 copy');
select is((public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
           pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'd'), repeat('d', 64), 250000, 1600, 1200)) ->> 'recorded',
          'false', 'device: the same call again is accepted and changes nothing');
select is((public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
           pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'f'), repeat('f', 64), 260000, 1600, 1200)) ->> 'sha256',
          repeat('d', 64), 'device: a recorded copy is never replaced (returns the stored one)');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e2'), 384,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e2', 384, 'd'), repeat('e', 64), 1000, 384, 288)$$,
                 '22023', null, 'device: the key carries the hash of the copy (another hash, another key)');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e5'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e5', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)$$,
                 '22023', null, 'device: documents have no shrunk copies');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e6'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e6', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)$$,
                 '55000', null, 'device: a withdrawn photo gets no copy');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e9'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e9', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)$$,
                 'P0002', null, 'device: only for photos the operator captured');
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', repeat('0', 64), 1600,
                   'derived/23300000-0000-4000-8000-000000000001/' || repeat('0', 64) || '/w1600-' || repeat('d', 64) || '.jpg', repeat('d', 64), 1000, 1600, 1200)$$,
                 'P0002', null, 'device: unknown original');
select is((public.record_device_derivative('23300000-0000-4000-8000-000000000006', (select sha from ev where k = 'e61'), 1600,
           pg_temp.dpath('23300000-0000-4000-8000-000000000006', 'e61', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)) ->> 'recorded',
          'true', 'device: allowed in the late window after the task moved to someone else (D43)');
reset role;
update public.task_holds set held_from = now() - interval '200 hours', held_until = now() - interval '100 hours'
 where profile_id = '23000000-0000-4000-8000-0000000000f1' and task_id = '23400000-0000-4000-8000-000000000006';
set local role authenticated;
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000006', (select sha from ev where k = 'e61'), 384,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000006', 'e61', 384, 'd'), repeat('d', 64), 1000, 384, 288)$$,
                 '42501', null, 'device: refused once the late window has passed');
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   values ('23800000-0000-4000-8000-000000000002', 1600,
                           pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e2', 1600, 'd'), repeat('d', 64))$$,
                 '42501', null, 'device: no direct insert');
select is((select count(*)::int from public.evidence_derivatives), 0, 'field users read no copies');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f2","role":"authenticated"}';
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e1'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)$$,
                 'P0002', null, 'device: another operator cannot record copies of f1''s photo');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.record_device_derivative('23300000-0000-4000-8000-000000000001', (select sha from ev where k = 'e9'), 1600,
                   pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e9', 1600, 'd'), repeat('d', 64), 1000, 1600, 1200)$$,
                 '42501', null, 'device: staff do not record device copies');
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   values ('23800000-0000-4000-8000-000000000009', 1600, pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e9', 1600, 'd'), repeat('d', 64))$$,
                 '42501', null, 'staff: no direct insert');
select throws_ok($$update public.evidence_derivatives set sha256 = repeat('0', 64)$$, '42501', null, 'staff: no direct update');

-- =====================================================================
-- B. Set-once rows and the path scheme hold for every writer
-- =====================================================================
reset role;
select throws_ok($$update public.evidence_derivatives set sha256 = repeat('0', 64)
                    where evidence_id = '23800000-0000-4000-8000-000000000001' and width = 1600$$,
                 '42501', null, 'trigger: a copy is never changed');
select throws_ok($$delete from public.evidence_derivatives where evidence_id = '23800000-0000-4000-8000-000000000001'$$,
                 '42501', null, 'trigger: a copy is never deleted');
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   values ('23800000-0000-4000-8000-000000000002', 1600, 'derived/wrong.jpg', repeat('d', 64))$$,
                 '22023', null, 'trigger: the path scheme holds for every writer');
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   values ('23800000-0000-4000-8000-000000000005', 1600, pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e5', 1600, 'd'), repeat('d', 64))$$,
                 '22023', null, 'trigger: documents have no copies');
select throws_ok($$insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256)
                   values ('23800000-0000-4000-8000-000000000002', 800, pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e2', 800, 'd'), repeat('d', 64))$$,
                 '23514', null, 'check: width 384 or 1600');

-- staff read on the cases they manage only
set local role authenticated;
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_derivatives), 3, 'owner reads the copies of their cases');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_derivatives), 0, 'another office user reads none');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_derivatives), 3, 'the orchestrator reads all');

-- =====================================================================
-- C. prepare_report_version
-- =====================================================================
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000001')$$, '42501', null, 'prepare: another office user is refused');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000001')$$, '42501', null, 'prepare: field users are refused');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000002')$$, '55000',
                 'This case was submitted. Reopen it from Submissions when the insurer asks.', 'prepare: a submitted case is refused (D46)');
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000003')$$, '55000', null, 'prepare: a case waiting for approval is refused');
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-0000000000ff')$$, 'P0002', null, 'prepare: unknown case');
insert into tok select 'r1', public.prepare_report_version('23300000-0000-4000-8000-000000000001') ->> 'values_token';
insert into prep select public.prepare_report_version('23300000-0000-4000-8000-000000000001');
select is((select j #>> '{case,case_ref}' from prep), (select case_ref from public.cases where id = '23300000-0000-4000-8000-000000000001'), 'prepare: case ref');
select is((select j #>> '{case,insurer,code}' from prep), 'RVT', 'prepare: insurer code');
select is((select j #>> '{case,office_owner,name}' from prep), 'RV Office 1', 'prepare: owner name');
select is((select j #>> '{template,key}' from prep), 'rvt-motor-free', 'prepare: template key from the config file');
select is((select j #>> '{template,output_formats}' from prep), '["pdf", "docx"]', 'prepare: output formats');
select is((select j -> 'report_layout' from prep), '{"pages":[{"kind":"cover"}]}'::jsonb, 'prepare: report layout');
select is((select (j ->> 'next_version')::int from prep), 1, 'prepare: next version 1');
select is((select jsonb_path_query_array(j, '$.sections[*].key') from prep), '["claim", "vehicle", "driver"]'::jsonb, 'prepare: sections in order');
select is((select j #>> '{sections,2,fields,0,value}' from prep), 'Ramesh K', 'prepare: field values');
select is((select j #>> '{sections,0,fields,0,source}' from prep), 'office', 'prepare: value source');
select is((select j #>> '{sections,0,fields,0,field_source}' from prep), 'intake', 'prepare: template field source');
select is((select jsonb_path_query_array(j, '$.photos[*].evidence_id') from prep),
          '["23800000-0000-4000-8000-000000000001", "23800000-0000-4000-8000-000000000007", "23800000-0000-4000-8000-000000000009", "23800000-0000-4000-8000-000000000002"]'::jsonb,
          'prepare: photos by category position then arrival; not relevant, withdrawn and unlabelled left out');
select is((select jsonb_path_query_array(j, '$.photos[*].section_key') from prep), '["vehicle", "vehicle", "vehicle", "vehicle"]'::jsonb,
          'prepare: an image appears only in its first matching section');
select is((select jsonb_path_query_array(j, '$.photos[*].position') from prep), '[1, 2, 3, 4]'::jsonb, 'prepare: positions within the section');
select is((select j #>> '{photos,3,caption}' from prep), 'Driving licence front', 'prepare: caption from the label description');
select is((select j #>> '{photos,0,caption}' from prep), 'Vehicle photo', 'prepare: else the category name');
select is((select jsonb_path_query_array(j, '$.photos[0].derivatives[*].width') from prep), '[384, 1600]'::jsonb, 'prepare: derivatives of each photo');
select is((select j #>> '{photos,0,derivatives,1,storage_path}' from prep), pg_temp.dpath('23300000-0000-4000-8000-000000000001', 'e1', 1600, 'd'),
          'prepare: derivative path');
select is((select j #>> '{photos,0,storage_path}' || '|' || (j #>> '{photos,0,storage_backend}') || '|' || (j #>> '{photos,0,mime_type}') from prep),
          (select storage_path || '|r2|image/jpeg' from public.evidence where id = '23800000-0000-4000-8000-000000000001'),
          'prepare: the original''s storage backend, path and type for the fallback');
select is((select j #> '{photos,2,derivatives}' from prep), '[]'::jsonb, 'prepare: a photo without copies has no derivatives');
select is((select jsonb_path_query_array(j, '$.unplaced_photos[*].evidence_id') from prep), '["23800000-0000-4000-8000-000000000004"]'::jsonb,
          'prepare: unlabelled photos listed apart');
select is((select jsonb_path_query_array(j, '$.annexure_files[*].evidence_id') from prep), '["23800000-0000-4000-8000-000000000005"]'::jsonb,
          'prepare: PDFs listed as annexure files');
select ok((select j ->> 'values_token' from prep) is not null, 'prepare: values token');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((public.prepare_report_version('23300000-0000-4000-8000-000000000001') ->> 'values_token'), (select v from tok where k = 'r1'),
          'prepare: the orchestrator may prepare too (D45); same token while nothing changed');

-- =====================================================================
-- D. Storage for generated files
-- =====================================================================
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into storage.objects (bucket_id, name) values
    ('reports', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000001/report.pdf'),
    ('reports', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000001/report.docx')$$,
    'storage: the owner uploads generated files under their case');
select throws_ok($$insert into storage.objects (bucket_id, name) values
    ('reports', '23300000-0000-4000-8000-000000000007/23700000-0000-4000-8000-000000000007/report.pdf')$$,
    '42501', null, 'storage: not under another office user''s case');
update storage.objects set metadata = '{"x":1}' where bucket_id = 'reports'
   and name = '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000001/report.pdf';
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
update storage.objects set metadata = '{"x":1}' where bucket_id = 'reports'
   and name = '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000001/report.pdf';
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$insert into storage.objects (bucket_id, name) values
    ('reports', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000009/report.pdf')$$,
    '42501', null, 'storage: another office user cannot write under the case');
select is((select count(*)::int from storage.objects where bucket_id = 'reports' and name like '23300000-0000-4000-8000-000000000001/%'), 0,
          'storage: another office user cannot read the files');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$insert into storage.objects (bucket_id, name) values
    ('reports', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000008/report.pdf')$$,
    '42501', null, 'storage: field users cannot write reports');
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'reports' and name like '23300000-0000-4000-8000-000000000001/%'
             and metadata is null), 2, 'storage: generated files cannot be overwritten or deleted through the API (owner or orchestrator)');
-- files for the other versions used below
insert into storage.objects (bucket_id, name, metadata) values
 ('reports', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000002/report.pdf', '{"size": 1234}'),
 ('reports', '23300000-0000-4000-8000-000000000005/23700000-0000-4000-8000-000000000005/report.pdf', null),
 ('reports', '23300000-0000-4000-8000-000000000005/23700000-0000-4000-8000-000000000005/report.docx', null);

-- =====================================================================
-- E. create_report_version
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', 'stale',
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf,docx}'), '[]')$$,
                 'RV409', null, 'create: a stale values token is refused with RV409');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   ('[{"format":"pdf","storage_path":"cases/x/report.pdf","sha256":"' || repeat('c', 64) || '","size_bytes":1}]')::jsonb, '[]')$$,
                 '22023', null, 'create: the file path must follow the scheme');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000003', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000003', '{pdf}'), '[]')$$,
                 '22023', null, 'create: the file must be uploaded first');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   '[]', '[]')$$, '22023', null, 'create: at least one file');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'),
                   '[{"evidence_id":"23800000-0000-4000-8000-000000000003","section_key":"vehicle","position":1}]')$$,
                 '22023', null, 'create: a photo marked not relevant is refused');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'),
                   '[{"evidence_id":"23800000-0000-4000-8000-000000000001","section_key":"nowhere","position":1}]')$$,
                 '22023', null, 'create: the section must be one of the template');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'),
                   '[{"evidence_id":"23800000-0000-4000-8000-000000000001","section_key":"vehicle","position":1},
                     {"evidence_id":"23800000-0000-4000-8000-000000000007","section_key":"vehicle","position":1}]')$$,
                 '22023', null, 'create: positions are unique within a section');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'),
                   '[{"evidence_id":"23800000-0000-4000-8000-000000000061","section_key":"vehicle","position":1}]')$$,
                 '22023', null, 'create: a photo of another case is refused');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'), '[]')$$,
                 '42501', null, 'create: another office user is refused');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf}'), '[]')$$,
                 '42501', null, 'create: field users are refused');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000002', '23700000-0000-4000-8000-000000000004', 'x',
                   pg_temp.files('23300000-0000-4000-8000-000000000002', '23700000-0000-4000-8000-000000000004', '{pdf}'), '[]')$$,
                 '55000', null, 'create: a submitted case is refused (D46)');
select is((public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', (select v from tok where k = 'r1'),
           pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf,docx}'),
           '[{"evidence_id":"23800000-0000-4000-8000-000000000001","section_key":"vehicle","position":1},
             {"evidence_id":"23800000-0000-4000-8000-000000000002","section_key":"driver","position":1,"caption":"DL front"}]',
           'First draft')),
          '{"report_id": "23700000-0000-4000-8000-000000000001", "version": 1, "created": true}'::jsonb, 'create: the owner records version 1');
select is((public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', 'whatever',
           pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000001', '{pdf,docx}'), '[]')),
          '{"report_id": "23700000-0000-4000-8000-000000000001", "version": 1, "created": false}'::jsonb, 'create: a retry with the same report id returns it');
select is((select row(origin, storage_path, uploaded_by, template_version, notes)::text from public.reports where id = '23700000-0000-4000-8000-000000000001'),
          row('generated', '23300000-0000-4000-8000-000000000001/23700000-0000-4000-8000-000000000001/report.pdf',
              '23000000-0000-4000-8000-0000000000b1'::uuid, 1, 'First draft')::text,
          'create: report row (generated, pdf path, uploaded by the caller, template version)');
select is((select field_values #>> '{driver_name,value}' from public.reports where id = '23700000-0000-4000-8000-000000000001'), 'Ramesh K',
          'create: the field values are kept with the version (G2)');
select is((select values_token from public.reports where id = '23700000-0000-4000-8000-000000000001'), (select v from tok where k = 'r1'),
          'create: the values token is kept');
select is((select array_agg(format order by format) from public.report_files where report_id = '23700000-0000-4000-8000-000000000001'), '{docx,pdf}'::text[],
          'create: both files recorded');
select is((select array_agg(section_key || ':' || position || ':' || coalesce(caption, '-') order by section_key)
             from public.report_annexures where report_id = '23700000-0000-4000-8000-000000000001'),
          '{"driver:1:DL front","vehicle:1:-"}'::text[], 'create: photos recorded as annexures with section, position, caption');
select is((select count(*)::int from public.case_messages where case_id = '23300000-0000-4000-8000-000000000001'
             and body like 'Report version 1 generated by RV Office 1%' and visibility = 'staff'), 1, 'create: staff-only thread event');
select is((select (public.prepare_report_version('23300000-0000-4000-8000-000000000001') #>> '{latest_version,version}')::int), 1, 'prepare: shows the latest version');

-- values change → token changes → the old token is refused
select is((public.save_case_field_values('23300000-0000-4000-8000-000000000001', '{"odometer":"12000"}', '{"odometer":null}')) -> 'saved',
          '["odometer"]'::jsonb, 'fixture: a value is saved');
select isnt((public.prepare_report_version('23300000-0000-4000-8000-000000000001') ->> 'values_token'), (select v from tok where k = 'r1'),
            'prepare: the token changes with the values');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', '{pdf}'), '[]')$$,
                 'RV409', null, 'create: values changed since prepare → regenerate');
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000001', 'x',
                   pg_temp.files('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000001', '{pdf}'), '[]')$$,
                 '23505', null, 'create: a report id of another case is refused');
update tok set v = public.prepare_report_version('23300000-0000-4000-8000-000000000001') ->> 'values_token' where k = 'r1';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', (select v from tok where k = 'r1'),
                   pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', '{pdf}', 999), '[]')$$,
                 '22023', null, 'create: the uploaded size must match');

-- generated versions are records
select throws_ok($$update public.reports set notes = 'edited' where id = '23700000-0000-4000-8000-000000000001'$$, '42501', null, 'records: no update of a generated version');
select throws_ok($$delete from public.reports where id = '23700000-0000-4000-8000-000000000001'$$, '42501', null, 'records: no delete of a generated version');
select throws_ok($$delete from public.report_annexures where report_id = '23700000-0000-4000-8000-000000000001'$$, '42501', null, 'records: its photos stay');
select throws_ok($$insert into public.report_files (report_id, format, storage_path) values ('23700000-0000-4000-8000-000000000001', 'pdf', 'x')$$,
                 '42501', null, 'records: its files stay');
select throws_ok($$insert into public.reports (case_id, version, storage_path, uploaded_by, origin)
                   values ('23300000-0000-4000-8000-000000000001', 9, 'x.pdf', '23000000-0000-4000-8000-0000000000b1', 'generated')$$,
                 '42501', null, 'records: a generated version cannot be inserted directly');

-- orchestrator makes version 2 (D45)
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((public.create_report_version('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', (select v from tok where k = 'r1'),
           pg_temp.files('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', '{pdf}'), null)) ->> 'version',
          '2', 'create: the orchestrator records version 2');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
insert into tok select 'r5', public.prepare_report_version('23300000-0000-4000-8000-000000000005') ->> 'values_token';
select throws_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000005', (select v from tok where k = 'r5'),
                   pg_temp.files('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000005', '{pdf,docx}'), '[]')$$,
                 '22023', null, 'create: only formats the template uses');

-- =====================================================================
-- F. Approval, portal pack and submission work on generated versions
-- =====================================================================
reset role;
update public.tasks set status = 'completed' where id = '23400000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$insert into public.report_approvals (case_id, report_id) values ('23300000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002')$$,
                'approval: the owner requests approval of the generated version');
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000001')$$, '55000', null, 'prepare: locked while waiting for approval');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$update public.report_approvals set decision = 'approved' where report_id = '23700000-0000-4000-8000-000000000002'$$,
                'approval: the orchestrator approves');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is(public.request_portal_pack('23300000-0000-4000-8000-000000000001', '{pdf}'), '23700000-0000-4000-8000-000000000002'::uuid,
          'portal pack: the latest generated version');
select isnt(public.record_manual_submission('23300000-0000-4000-8000-000000000001', 'portal', '{pdf}', 'PORTAL-1', null), null,
            'submission: recorded on the generated version');
select throws_ok($$select public.prepare_report_version('23300000-0000-4000-8000-000000000001')$$, '55000', null, 'prepare: refused once submitted');
set local request.jwt.claims to '{"sub":"23000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select public.create_report_version('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000005', (select v from tok where k = 'r5'),
                   pg_temp.files('23300000-0000-4000-8000-000000000005', '23700000-0000-4000-8000-000000000005', '{pdf}'), '[]')$$,
                'create: the orchestrator generates on R5');
select isnt(public.approve_own_report('23700000-0000-4000-8000-000000000005'), null, 'approval: one-step approval of a generated version (D47)');
reset role;
select is((select count(*)::int from public.audit_log where action = 'REPORT_GENERATED'
             and record_id in ('23700000-0000-4000-8000-000000000001', '23700000-0000-4000-8000-000000000002', '23700000-0000-4000-8000-000000000005')),
          3, 'audit: one REPORT_GENERATED per version');

select * from finish();
rollback;
