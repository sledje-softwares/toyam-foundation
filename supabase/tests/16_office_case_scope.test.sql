-- D44 (20261115500000_office_case_scope.sql): an office user sees only the cases assigned to them
-- (cases.office_owner_id) and everything hanging off them; orchestrator / admin see every case;
-- unassigned cases are orchestrator / admin only; the intake queue (unlinked emails / extractions)
-- stays visible to all staff; field access is unchanged. Self-contained; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(80);

-- ---------------------------------------------------------------------
-- Fixture. Users: oa office A, ob office B, oc orchestrator, od admin, f1 / f2 field.
-- Cases: cA (office A), cB (office B), cU (unassigned). Each case: party, entity, field value,
-- task (+ checklist item, hold), task evidence (+ OCR, label, match, suggestion, jobs), email
-- (+ attachment, extraction, attachment evidence), report (+ file, annexure, approval), submission,
-- staff note, thread read. Plus one unlinked email in the intake queue.
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-00000000000a','authenticated','authenticated','s-oa@example.com',null,'{"role":"office","full_name":"S Office A"}','{}'),
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-00000000000b','authenticated','authenticated','s-ob@example.com',null,'{"role":"office","full_name":"S Office B"}','{}'),
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-00000000000c','authenticated','authenticated','s-oc@example.com',null,'{"role":"orchestrator","full_name":"S Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-00000000000d','authenticated','authenticated','s-od@example.com',null,'{"role":"admin","full_name":"S Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919860000001','{"role":"field","full_name":"S Field 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','16000000-0000-4000-8000-0000000000f2','authenticated','authenticated',null,'919860000002','{"role":"field","full_name":"S Field 2"}','{}');

insert into public.insurers (id, name, code, tat_days) values ('16100000-0000-4000-8000-000000000001', 'Scope Insurer', 'SCP', 10);
insert into public.case_templates (id, insurer_id, claim_type, name, requires_approval)
values ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000001', 'motor', 'Scope motor', false);
insert into public.case_template_sections (id, template_id, key, title, position)
values ('16210000-0000-4000-8000-000000000001', '16200000-0000-4000-8000-000000000001', 'facts', 'Facts', 1);
insert into public.case_template_fields (id, template_id, section_id, key, label, position)
values ('16220000-0000-4000-8000-000000000001', '16200000-0000-4000-8000-000000000001', '16210000-0000-4000-8000-000000000001',
        'finding', 'Finding', 1);
insert into public.evidence_categories (id, code, name) values ('16900000-0000-4000-8000-000000000001', 'scope_photo', 'Scope photo');
insert into public.entities (id, entity_type, name) values ('16910000-0000-4000-8000-000000000001', 'garage', 'Scope Garage');

create temp table k (x text primary key, c uuid, owner uuid, t uuid, op uuid, ev uuid, em uuid, r uuid) on commit drop;
insert into k values
 ('a', '16300000-0000-4000-8000-00000000000a', '16000000-0000-4000-8000-00000000000a', '16400000-0000-4000-8000-00000000000a',
       '16000000-0000-4000-8000-0000000000f1', '16800000-0000-4000-8000-00000000000a', '16600000-0000-4000-8000-00000000000a',
       '16700000-0000-4000-8000-00000000000a'),
 ('b', '16300000-0000-4000-8000-00000000000b', '16000000-0000-4000-8000-00000000000b', '16400000-0000-4000-8000-00000000000b',
       '16000000-0000-4000-8000-0000000000f2', '16800000-0000-4000-8000-00000000000b', '16600000-0000-4000-8000-00000000000b',
       '16700000-0000-4000-8000-00000000000b'),
 ('u', '16300000-0000-4000-8000-00000000000c', null,                                   '16400000-0000-4000-8000-00000000000c',
       '16000000-0000-4000-8000-0000000000f2', '16800000-0000-4000-8000-00000000000c', '16600000-0000-4000-8000-00000000000c',
       '16700000-0000-4000-8000-00000000000c');
grant select on k to authenticated;

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id, template_id)
select c, '16100000-0000-4000-8000-000000000001', 'SCP-' || x, 'motor', 'assigned', owner, '16200000-0000-4000-8000-000000000001' from k;
create temp table refs on commit drop as select k.x, cs.case_ref as ref from k join public.cases cs on cs.id = k.c;
grant select on refs to authenticated;
insert into public.parties (case_id, role, name) select c, 'insured', 'Insured ' || x from k;
insert into public.case_entities (case_id, entity_id) select c, '16910000-0000-4000-8000-000000000001' from k;
insert into public.case_field_values (case_id, field_id, value) select c, '16220000-0000-4000-8000-000000000001', 'v-' || x from k;
insert into public.tasks (id, case_id, title, assignee_id) select t, c, 'Visit ' || x, op from k;
insert into public.task_checklist_items (task_id, position, description) select t, 1, 'Photo' from k;
insert into public.evidence (id, case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
select ev, c, t, 'photo', 'camera', 'cases/' || c || '/tasks/' || t || '/' || repeat(x || '1', 32) || '.jpg', repeat(x || '1', 32), op
  from k where x <> 'u';
insert into public.evidence (id, case_id, task_id, evidence_type, capture_source, storage_path, sha256, captured_by)
select ev, c, t, 'photo', 'camera', 'cases/' || c || '/tasks/' || t || '/' || repeat('c1', 32) || '.jpg', repeat('c1', 32), op
  from k where x = 'u';
insert into public.evidence_ocr (evidence_id, engine, text) select ev, 'test', 'text ' || x from k;
insert into public.evidence_labels (evidence_id, category_id, confidence, source)
select ev, '16900000-0000-4000-8000-000000000001', 0.9, 'model' from k;
insert into public.evidence_field_matches (evidence_id, field_id, score, model)
select ev, '16220000-0000-4000-8000-000000000001', 0.5, 'test' from k;
insert into public.field_suggestions (evidence_id, field_id, value) select ev, '16220000-0000-4000-8000-000000000001', 's-' || x from k;

insert into public.emails (id, gmail_message_id, from_address, received_at, case_id, raw_storage_path)
select em, 'scope-' || x, 'a@scope.example', now(), c, 'emails/scope/' || x || '/message.eml' from k
union all
select '16600000-0000-4000-8000-0000000000ff', 'scope-queue', 'a@scope.example', now(), null, 'emails/scope/q/message.eml';
insert into public.email_attachments (id, email_id, filename, mime_type, storage_path, sha256)
select ('16610000' || substr(em::text, 9))::uuid, em, 'claim.pdf', 'application/pdf',
       'emails/att/' || md5(em::text) || md5(em::text) || '.pdf', md5(em::text) || md5(em::text)
  from (select em from k union all select '16600000-0000-4000-8000-0000000000ff'::uuid) e;
insert into public.intake_extractions (id, email_id, case_id, model, extracted)
select ('16620000' || substr(em::text, 9))::uuid, em, c, 'fixture', '{}'::jsonb from k
union all
select '16620000-0000-4000-8000-0000000000ff', '16600000-0000-4000-8000-0000000000ff', null, 'fixture', '{}';
insert into public.evidence (case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256,
                             original_filename, email_attachment_id, captured_by)
select k.c, 'document', 'email_attachment', 'supabase', a.storage_path, a.mime_type, a.sha256, a.filename, a.id, null
  from k join public.email_attachments a on a.email_id = k.em;

insert into public.reports (id, case_id, version, storage_path, uploaded_by)
select r, c, 1, 'cases/' || c || '/r1.docx', coalesce(owner, '16000000-0000-4000-8000-00000000000d') from k;
insert into public.report_files (report_id, format, storage_path) select r, 'pdf', 'cases/' || c || '/r1.pdf' from k;
insert into public.report_annexures (report_id, evidence_id, position) select r, ev, 1 from k;
-- fixture rows only: the request rules (open field work, required fields) are tested in 19_report_guards
alter table public.report_approvals disable trigger trg_report_approvals_guard;
insert into public.report_approvals (case_id, report_id, requested_by)
select c, r, coalesce(owner, '16000000-0000-4000-8000-00000000000d') from k;
alter table public.report_approvals enable trigger trg_report_approvals_guard;
insert into public.submissions (case_id, report_id, channel, submitted_by)
select c, r, 'email', '16000000-0000-4000-8000-00000000000c' from k;

insert into public.case_messages (case_id, sender_id, kind, body, visibility)
select c, '16000000-0000-4000-8000-00000000000c', 'text', 'staff note ' || x, 'staff' from k;
insert into public.case_thread_reads (case_id, user_id)
select c, coalesce(owner, '16000000-0000-4000-8000-00000000000c') from k;

insert into public.field_devices (device_id, profile_id, secret_sha256)
values ('16920000-0000-4000-8000-0000000000f1', '16000000-0000-4000-8000-0000000000f1', repeat('0f', 32)),
       ('16920000-0000-4000-8000-0000000000f2', '16000000-0000-4000-8000-0000000000f2', repeat('0f', 32));
insert into public.device_outbox_status (device_id, profile_id, pending_count, pending_bytes)
values ('16920000-0000-4000-8000-0000000000f1', '16000000-0000-4000-8000-0000000000f1', 3, 300),
       ('16920000-0000-4000-8000-0000000000f2', '16000000-0000-4000-8000-0000000000f2', 4, 400);

insert into storage.objects (bucket_id, name)
select 'email-raw', raw_storage_path from public.emails where from_address = 'a@scope.example'
union all
select 'email-raw', a.storage_path from public.email_attachments a join public.emails e on e.id = a.email_id
 where e.from_address = 'a@scope.example'
union all
select 'reports', 'cases/' || c || '/r1.docx' from k;

-- fixture lookups that bypass RLS (k is a plain temp table)
create function pg_temp.k_row(p_case uuid) returns setof k language sql as $$ select * from k where c = p_case $$;
create function pg_temp.k_tasks(p_case uuid) returns table (id uuid) language sql as $$ select t from k where c = p_case $$;

-- Which case-scoped tables / views show at least one row of a case to the current user (RLS applies:
-- temp functions run as the caller).
create function pg_temp.visible(p_case uuid) returns text[] language sql as $$
  select array_remove(array[
    case when exists (select 1 from public.cases where id = p_case) then 'cases' end,
    case when exists (select 1 from public.parties where case_id = p_case) then 'parties' end,
    case when exists (select 1 from public.case_entities where case_id = p_case) then 'case_entities' end,
    case when exists (select 1 from public.case_status_history where case_id = p_case) then 'case_status_history' end,
    case when exists (select 1 from public.case_field_values where case_id = p_case) then 'case_field_values' end,
    case when exists (select 1 from public.case_messages where case_id = p_case and visibility = 'staff') then 'staff_notes' end,
    case when exists (select 1 from public.case_messages where case_id = p_case and visibility = 'all') then 'case_messages' end,
    case when exists (select 1 from public.tasks where case_id = p_case) then 'tasks' end,
    case when exists (select 1 from public.task_checklist_items i join (select id from pg_temp.k_tasks(p_case)) t on t.id = i.task_id) then 'task_checklist_items' end,
    case when exists (select 1 from public.task_holds h join (select id from pg_temp.k_tasks(p_case)) t on t.id = h.task_id) then 'task_holds' end,
    case when exists (select 1 from public.v_case_checklist where case_id = p_case) then 'v_case_checklist' end,
    case when exists (select 1 from public.evidence where case_id = p_case) then 'evidence' end,
    case when exists (select 1 from public.evidence_ocr o join (select ev from pg_temp.k_row(p_case)) e on e.ev = o.evidence_id) then 'evidence_ocr' end,
    case when exists (select 1 from public.evidence_labels l join (select ev from pg_temp.k_row(p_case)) e on e.ev = l.evidence_id) then 'evidence_labels' end,
    case when exists (select 1 from public.evidence_field_matches m join (select ev from pg_temp.k_row(p_case)) e on e.ev = m.evidence_id) then 'evidence_field_matches' end,
    case when exists (select 1 from public.field_suggestions s join (select ev from pg_temp.k_row(p_case)) e on e.ev = s.evidence_id) then 'field_suggestions' end,
    case when exists (select 1 from public.processing_jobs j join (select ev from pg_temp.k_row(p_case)) e on e.ev = j.evidence_id) then 'processing_jobs' end,
    case when exists (select 1 from public.v_evidence_processing where case_id = p_case) then 'v_evidence_processing' end,
    case when exists (select 1 from public.emails where case_id = p_case) then 'emails' end,
    case when exists (select 1 from public.email_attachments a join (select em from pg_temp.k_row(p_case)) e on e.em = a.email_id) then 'email_attachments' end,
    case when exists (select 1 from public.intake_extractions where case_id = p_case) then 'intake_extractions' end,
    case when exists (select 1 from public.reports where case_id = p_case) then 'reports' end,
    case when exists (select 1 from public.report_files f join (select r from pg_temp.k_row(p_case)) e on e.r = f.report_id) then 'report_files' end,
    case when exists (select 1 from public.report_annexures f join (select r from pg_temp.k_row(p_case)) e on e.r = f.report_id) then 'report_annexures' end,
    case when exists (select 1 from public.report_approvals where case_id = p_case) then 'report_approvals' end,
    case when exists (select 1 from public.submissions where case_id = p_case) then 'submissions' end,
    case when exists (select 1 from public.v_case_dashboard where id = p_case) then 'v_case_dashboard' end,
    case when exists (select 1 from public.v_report_progress where case_id = p_case) then 'v_report_progress' end,
    case when exists (select 1 from public.device_outbox_status o join (select op from pg_temp.k_row(p_case)) e on e.op = o.profile_id) then 'device_outbox_status' end,
    case when exists (select 1 from storage.objects where bucket_id = 'email-raw'
                       and name = 'emails/scope/' || (select x from pg_temp.k_row(p_case)) || '/message.eml') then 'email_raw_message' end,
    case when exists (select 1 from storage.objects where bucket_id = 'email-raw'
                       and name = 'emails/att/' || md5((select em from pg_temp.k_row(p_case))::text) || md5((select em from pg_temp.k_row(p_case))::text) || '.pdf') then 'email_raw_attachment' end,
    case when exists (select 1 from storage.objects where bucket_id = 'reports' and name = 'cases/' || p_case || '/r1.docx') then 'report_object' end
  ], null) $$;
create function pg_temp.all_tables() returns text[] language sql as $$
  select array['cases','parties','case_entities','case_status_history','case_field_values','staff_notes','case_messages',
               'tasks','task_checklist_items','task_holds','v_case_checklist','evidence','evidence_ocr','evidence_labels',
               'evidence_field_matches','field_suggestions','processing_jobs','v_evidence_processing','emails',
               'email_attachments','intake_extractions','reports','report_files','report_annexures','report_approvals',
               'submissions','v_case_dashboard','v_report_progress','device_outbox_status','email_raw_message',
               'email_raw_attachment','report_object'] $$;
create function pg_temp.hidden(p_case uuid) returns text[] language sql as $$
  select coalesce(array(select t from unnest(pg_temp.all_tables()) t where t <> all (pg_temp.visible(p_case))), '{}') $$;
grant execute on function pg_temp.k_row(uuid), pg_temp.k_tasks(uuid), pg_temp.visible(uuid), pg_temp.all_tables(), pg_temp.hidden(uuid) to authenticated;

-- =====================================================================
-- Helper
-- =====================================================================
select is((select prosecdef from pg_proc where oid = 'private.can_manage_case(uuid)'::regprocedure), true,
    'can_manage_case is security definer');
select ok((select 'search_path=""' = any (proconfig) from pg_proc where oid = 'private.can_manage_case(uuid)'::regprocedure),
    'can_manage_case pins an empty search_path');
select ok(not has_function_privilege('anon', 'private.can_manage_case(uuid)', 'execute'), 'anon cannot call can_manage_case');
select ok(not has_function_privilege('anon', 'public.intake_confirmed_case_ref(uuid)', 'execute'), 'anon cannot call intake_confirmed_case_ref');

-- =====================================================================
-- Office A
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"16000000-0000-4000-8000-00000000000a","role":"authenticated"}';
select is(private.can_manage_case('16300000-0000-4000-8000-00000000000a'), true,  'office A manages own case');
select is(private.can_manage_case('16300000-0000-4000-8000-00000000000b'), false, 'office A does not manage office B''s case');
select is(private.can_manage_case('16300000-0000-4000-8000-00000000000c'), false, 'office A does not manage an unassigned case');
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000a'), '{}'::text[], 'office A sees every row of its own case');
select is(pg_temp.visible('16300000-0000-4000-8000-00000000000b'), '{}'::text[], 'office A sees nothing of office B''s case');
select is(pg_temp.visible('16300000-0000-4000-8000-00000000000c'), '{}'::text[], 'office A sees nothing of an unassigned case');
select is((select count(*)::int from public.case_assignments where case_id in (select c from k)), 1, 'office A sees only its case''s assignments');
select is((select count(*)::int from public.cases where insurer_id = '16100000-0000-4000-8000-000000000001'), 1, 'office A lists one case');

-- intake queue stays shared
select isnt_empty($$select 1 from public.emails where id = '16600000-0000-4000-8000-0000000000ff'$$, 'office A sees the unlinked email');
select isnt_empty($$select 1 from public.email_attachments where email_id = '16600000-0000-4000-8000-0000000000ff'$$, 'office A sees its attachment');
select isnt_empty($$select 1 from public.intake_extractions where id = '16620000-0000-4000-8000-0000000000ff'$$, 'office A sees the pending extraction');
select isnt_empty($$select 1 from storage.objects where bucket_id = 'email-raw' and name = 'emails/scope/q/message.eml'$$,
    'office A reads the raw message of the unlinked email');
select throws_ok($$update public.emails set case_id = '16300000-0000-4000-8000-00000000000b' where id = '16600000-0000-4000-8000-0000000000ff'$$,
    '42501', null::text, 'office A cannot link a queue email to office B''s case');

-- writes on another office's case
select throws_ok($$insert into public.parties (case_id, role, name) values ('16300000-0000-4000-8000-00000000000b', 'witness', 'x')$$,
    '42501', null::text, 'office A cannot add a party to office B''s case');
select throws_ok($$insert into public.tasks (case_id, title) values ('16300000-0000-4000-8000-00000000000b', 'x')$$,
    '42501', null::text, 'office A cannot add a task to office B''s case');
select throws_ok($$insert into public.task_checklist_items (task_id, position, description) values ('16400000-0000-4000-8000-00000000000b', 9, 'x')$$,
    '42501', null::text, 'office A cannot add a checklist item to office B''s task');
select throws_ok($$insert into public.reports (case_id, version, storage_path, uploaded_by)
                   values ('16300000-0000-4000-8000-00000000000b', 2, 'cases/x/y.docx', '16000000-0000-4000-8000-00000000000a')$$,
    '42501', null::text, 'office A cannot add a report to office B''s case');
select throws_ok($$insert into public.evidence (case_id, evidence_type, capture_source, storage_path, sha256, captured_by)
                   values ('16300000-0000-4000-8000-00000000000b', 'document', 'web_upload',
                           'cases/16300000-0000-4000-8000-00000000000b/files/' || repeat('9a', 32) || '.pdf', repeat('9a', 32),
                           '16000000-0000-4000-8000-00000000000a')$$,
    '42501', null::text, 'office A cannot add evidence to office B''s case');
select throws_ok($$insert into public.case_field_values (case_id, field_id, value)
                   values ('16300000-0000-4000-8000-00000000000c', '16220000-0000-4000-8000-000000000001', 'x')$$,
    '42501', null::text, 'office A cannot write field values of an unassigned case');
select throws_ok($$insert into public.cases (insurer_id, insurer_claim_no, claim_type, status)
                   values ('16100000-0000-4000-8000-000000000001', 'SCP-new', 'motor', 'assigned')$$,
    '42501', null::text, 'office A cannot create an unassigned case');
select lives_ok($$insert into public.cases (insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
                  values ('16100000-0000-4000-8000-000000000001', 'SCP-own', 'motor', 'assigned', '16000000-0000-4000-8000-00000000000a')$$,
    'office A can create a case it owns');
update public.tasks set title = 'hijacked' where case_id = '16300000-0000-4000-8000-00000000000b';
update public.tasks set title = 'renamed' where case_id = '16300000-0000-4000-8000-00000000000a';
delete from public.tasks where case_id = '16300000-0000-4000-8000-00000000000a';
update public.evidence set relevance = 'not_relevant' where id = '16800000-0000-4000-8000-00000000000b';
update public.field_suggestions set status = 'rejected' where evidence_id = '16800000-0000-4000-8000-00000000000b';
select lives_ok($$update public.evidence set relevance = 'relevant' where id = '16800000-0000-4000-8000-00000000000a'$$,
    'office A marks relevance on its own case');

-- RPCs
select throws_ok($$select public.post_staff_note('16300000-0000-4000-8000-00000000000b', gen_random_uuid(), 'x')$$,
    '42501', null::text, 'post_staff_note refuses office B''s case');
select lives_ok($$select public.post_staff_note('16300000-0000-4000-8000-00000000000a', gen_random_uuid(), 'mine')$$,
    'post_staff_note on own case');
select throws_ok($$select public.post_thread_message('16300000-0000-4000-8000-00000000000b', gen_random_uuid(), 'text', 'x')$$,
    '42501', null::text, 'post_thread_message refuses office B''s case');
select lives_ok($$select public.post_thread_message('16300000-0000-4000-8000-00000000000a', gen_random_uuid(), 'text', 'to field')$$,
    'post_thread_message on own case');
select throws_ok($$select public.mark_thread_read('16300000-0000-4000-8000-00000000000b')$$,
    '42501', null::text, 'mark_thread_read refuses office B''s case');
select lives_ok($$select public.mark_thread_read('16300000-0000-4000-8000-00000000000a')$$, 'mark_thread_read on own case');
select throws_ok($$select public.set_evidence_labels('16800000-0000-4000-8000-00000000000b', array['16900000-0000-4000-8000-000000000001'::uuid])$$,
    '42501', null::text, 'set_evidence_labels refuses office B''s file');
select lives_ok($$select public.set_evidence_labels('16800000-0000-4000-8000-00000000000a', array['16900000-0000-4000-8000-000000000001'::uuid])$$,
    'set_evidence_labels on own file');
select throws_ok($$insert into public.evidence_labels (evidence_id, category_id, source)
                   values ('16800000-0000-4000-8000-00000000000b', '16900000-0000-4000-8000-000000000001', 'human')$$,
    '42501', null::text, 'office A cannot label office B''s file directly');
select is_empty($$select * from public.case_outbox_status('16300000-0000-4000-8000-00000000000b')$$, 'case_outbox_status empty for office B''s case');
select isnt_empty($$select * from public.case_outbox_status('16300000-0000-4000-8000-00000000000a')$$, 'case_outbox_status for own case');
select is((select staff_last_read_at from public.case_thread_state('16300000-0000-4000-8000-00000000000b')), null::timestamptz,
    'case_thread_state reveals nothing of office B''s case');
select isnt((select staff_last_read_at from public.case_thread_state('16300000-0000-4000-8000-00000000000a')), null::timestamptz,
    'case_thread_state for own case');
select is_empty($$select * from public.case_field_history('16300000-0000-4000-8000-00000000000b')$$, 'case_field_history empty for office B''s case');
select isnt_empty($$select * from public.case_field_history('16300000-0000-4000-8000-00000000000a')$$, 'case_field_history for own case');
select is(public.can_upload_case_file('16300000-0000-4000-8000-00000000000b'), false, 'can_upload_case_file false on office B''s case');
select is(public.can_upload_case_file('16300000-0000-4000-8000-00000000000a'), true,  'can_upload_case_file true on own case');
select is(public.can_upload_evidence('16400000-0000-4000-8000-00000000000b'), false, 'can_upload_evidence false on office B''s task');
select is(public.can_upload_evidence('16400000-0000-4000-8000-00000000000a'), true,  'can_upload_evidence true on own task');
select throws_ok($$select * from public.evidence_upload_target('16400000-0000-4000-8000-00000000000b', array[repeat('b1', 32)])$$,
    '42501', null::text, 'evidence_upload_target refuses office B''s task');
select lives_ok($$select * from public.evidence_upload_target('16400000-0000-4000-8000-00000000000a', array[repeat('a1', 32)])$$,
    'evidence_upload_target on own task');
select throws_ok($$select public.retry_auto_assign('16300000-0000-4000-8000-00000000000c')$$,
    '42501', null::text, 'office cannot run assignment on an unassigned case');

-- storage: reports bucket
select throws_ok($$insert into storage.objects (bucket_id, name) values ('reports', 'cases/16300000-0000-4000-8000-00000000000b/r2.docx')$$,
    '42501', null::text, 'office A cannot upload a report file under office B''s case');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('reports', 'loose-report.docx')$$,
    '42501', null::text, 'office A cannot upload a report file outside cases/{case_id}/');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('reports', 'cases/16300000-0000-4000-8000-00000000000a/r2.docx')$$,
    'office A uploads a report file under its own case');

-- intake confirmation hands back the reference of a case the reviewer cannot see
reset role;
update public.intake_extractions set status = 'confirmed', reviewed_by = '16000000-0000-4000-8000-00000000000a', reviewed_at = now()
 where id = ('16620000' || substr('16600000-0000-4000-8000-00000000000b', 9))::uuid;
set local role authenticated;
select is(public.intake_confirmed_case_ref(('16620000' || substr('16600000-0000-4000-8000-00000000000b', 9))::uuid),
    (select ref from refs where x = 'b'), 'intake_confirmed_case_ref names the case to the reviewer who cannot open it');
select is_empty($$select 1 from public.intake_extractions where id = ('16620000' || substr('16600000-0000-4000-8000-00000000000b', 9))::uuid$$,
    'a confirmed extraction follows its case');

-- =====================================================================
-- Office B: the mirror image
-- =====================================================================
set local request.jwt.claims to '{"sub":"16000000-0000-4000-8000-00000000000b","role":"authenticated"}';
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000b'), '{}'::text[], 'office B sees every row of its own case');
select is(pg_temp.visible('16300000-0000-4000-8000-00000000000a'), '{}'::text[], 'office B sees nothing of office A''s case');
select is(public.intake_confirmed_case_ref(('16620000' || substr('16600000-0000-4000-8000-00000000000b', 9))::uuid), null::text,
    'intake_confirmed_case_ref is only for the reviewer');

-- =====================================================================
-- Orchestrator and admin: every case
-- =====================================================================
set local request.jwt.claims to '{"sub":"16000000-0000-4000-8000-00000000000c","role":"authenticated"}';
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000a'), '{}'::text[], 'orchestrator sees office A''s case');
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000b'), '{}'::text[], 'orchestrator sees office B''s case');
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000c'), '{}'::text[], 'orchestrator sees the unassigned case');
select lives_ok($$select public.post_staff_note('16300000-0000-4000-8000-00000000000b', gen_random_uuid(), 'orch note')$$,
    'orchestrator writes a staff note on any case');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('reports', 'loose-orch.docx')$$,
    'orchestrator may write anywhere in the reports bucket');

set local request.jwt.claims to '{"sub":"16000000-0000-4000-8000-00000000000d","role":"authenticated"}';
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000b'), '{}'::text[], 'admin sees office B''s case');
select is(pg_temp.hidden('16300000-0000-4000-8000-00000000000c'), '{}'::text[], 'admin sees the unassigned case');
select is((select count(*)::int from public.cases where insurer_id = '16100000-0000-4000-8000-000000000001'), 4, 'admin lists every case');
select lives_ok($$select public.set_evidence_labels('16800000-0000-4000-8000-00000000000b', array['16900000-0000-4000-8000-000000000001'::uuid])$$,
    'admin labels any file');

-- =====================================================================
-- Field: unchanged (own task's case only, no staff notes, no intake)
-- =====================================================================
set local request.jwt.claims to '{"sub":"16000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.cases where insurer_id = '16100000-0000-4000-8000-000000000001'), 1, 'field 1 sees only its task''s case');
select is_empty($$select 1 from public.case_messages where visibility = 'staff'$$, 'field sees no staff notes');
select is_empty($$select 1 from public.emails$$, 'field sees no emails');
select is_empty($$select 1 from public.reports$$, 'field sees no reports');
select is_empty($$select 1 from storage.objects where bucket_id in ('email-raw', 'reports')$$, 'field sees no stored mail or reports');
select is(private.can_manage_case('16300000-0000-4000-8000-00000000000a'), false, 'can_manage_case is false for field users');
select is(public.can_upload_evidence('16400000-0000-4000-8000-00000000000a'), true, 'field upload check unchanged');

-- =====================================================================
-- Owner checks: office A's writes on office B's rows had no effect
-- =====================================================================
reset role;
set local request.jwt.claims to '';
select is((select title from public.tasks where id = '16400000-0000-4000-8000-00000000000b'), 'Visit b', 'office B''s task was not renamed');
select is((select title from public.tasks where id = '16400000-0000-4000-8000-00000000000a'), 'Visit a',
    'office A cannot update even its own task directly (task RPCs only)');
select ok(exists (select 1 from public.tasks where id = '16400000-0000-4000-8000-00000000000a'), 'office A cannot delete its own task');
select is((select array_agg(cmd::text order by cmd) from pg_policies where schemaname = 'public' and tablename = 'tasks'
             and policyname like 'p_tasks_staff%'), array['INSERT','SELECT'], 'staff task policies are SELECT and INSERT only');
select is((select relevance::text from public.evidence where id = '16800000-0000-4000-8000-00000000000b'), 'unreviewed',
    'office B''s file relevance unchanged');
select is((select status::text from public.field_suggestions where evidence_id = '16800000-0000-4000-8000-00000000000b'), 'pending',
    'office B''s suggestion unchanged');
select is((select relevance::text from public.evidence where id = '16800000-0000-4000-8000-00000000000a'), 'relevant',
    'office A''s relevance change stored');
select is((select count(*)::int from public.case_thread_reads where case_id = '16300000-0000-4000-8000-00000000000b'
             and user_id = '16000000-0000-4000-8000-00000000000a'), 0, 'office A has no read marker on office B''s case');

select * from finish();
rollback;
