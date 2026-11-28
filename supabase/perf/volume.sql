-- =====================================================================
-- DEV-ONLY synthetic volume on top of seed.sql (see supabase/perf/README.md).
-- Never run against a hosted project.
--
--   docker exec -i supabase_db_toyam-foundation psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/perf/volume.sql
--
-- Adds roughly: 1 office + 7 field users, 4 000 cases, 12 000 tasks, 80 000 checklist items,
-- 200 000 thread messages, 150 000 evidence rows (labels, 384/1600 px copies, device OCR,
-- processing jobs), 10 000 file comments, 150 000 field values, 6 500 emails with attachments,
-- reports / approvals / submissions, thread read pointers. All rows go through the normal
-- triggers (audit, assignment, status history, processing queue, guards). Only the final
-- back-dating of timestamps runs with session_replication_role = replica (one transaction,
-- this session only), because the guards stamp created_at with now() and forbid changing it.
-- Deterministic: the same seed gives the same data.
-- =====================================================================
\set ON_ERROR_STOP on
\timing on

do $$ begin
    if exists (select 1 from public.profiles where id = 'a0000000-0000-4000-8000-000000000005') then
        raise exception 'perf volume already loaded (run supabase db reset first)';
    end if;
end $$;

-- deterministic pseudo-random in [0, 1) from any text
create or replace function pg_temp.r(p text) returns double precision
language sql immutable as $$ select ('x' || substr(md5(p), 1, 8))::bit(32)::bigint / 4294967296.0 $$;
create or replace function pg_temp.hex64(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- ---------------------------------------------------------------------
-- 1. Users: a third office employee and seven more operators (10 in all)
-- ---------------------------------------------------------------------
with u (id, email, phone, meta) as (
    select 'a0000000-0000-4000-8000-000000000005'::uuid, 'office3@example.com', null::text,
           '{"provider":"email","providers":["email"],"role":"office","full_name":"Pia Office"}'::jsonb
    union all
    select ('a0000000-0000-4000-8000-0000000000' || (13 + g)::text)::uuid, null, '9198000000' || lpad((3 + g)::text, 2, '0'),
           jsonb_build_object('provider', 'phone', 'providers', jsonb_build_array('phone'), 'role', 'field',
                              'full_name', 'Perf Operator ' || g, 'region', 'Region ' || g)
      from generate_series(1, 7) g)
insert into auth.users (
    instance_id, id, aud, role, email, phone, encrypted_password,
    email_confirmed_at, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, u.phone, '',
       case when u.email is not null then now() end, case when u.phone is not null then now() end,
       u.meta, '{}'::jsonb, now(), now(), '', '', '', '', '', '', '', ''
  from u;

create temp table perf_office (k int primary key, id uuid not null);
insert into perf_office values
    (0, 'a0000000-0000-4000-8000-000000000003'), (1, 'a0000000-0000-4000-8000-000000000004'),
    (2, 'a0000000-0000-4000-8000-000000000005');
create temp table perf_field (k int primary key, id uuid not null);
insert into perf_field
select row_number() over (order by id) - 1, id from public.profiles where role = 'field';

-- ---------------------------------------------------------------------
-- 2. Cases (4 000): five insurers, three templates, nine statuses, three owners
-- ---------------------------------------------------------------------
create temp table perf_cases as
with base as (
    select g as n, gen_random_uuid() as id,
           pg_temp.r('ins' || g) as ri, pg_temp.r('st' || g) as rs, pg_temp.r('rcv' || g) as rr
      from generate_series(1, 4000) g)
select b.n, b.id,
       case when b.ri < 0.35 then 'ICL' when b.ri < 0.70 then 'IGI' when b.ri < 0.80 then 'SGI'
            when b.ri < 0.90 then 'DHI' else 'TLA' end as insurer_code,
       case when b.rs < 0.02 then 'received' when b.rs < 0.04 then 'intake_confirmed'
            when b.rs < 0.08 then 'assigned' when b.rs < 0.20 then 'field_in_progress'
            when b.rs < 0.30 then 'office_review' when b.rs < 0.35 then 'orchestrator_review'
            when b.rs < 0.50 then 'submitted' when b.rs < 0.95 then 'closed' else 'cancelled' end::public.case_status as final_status,
       now() - make_interval(secs => (b.rr * 400 * 86400)::int) as received_at,
       (select o.id from perf_office o where o.k = b.n % 3) as owner_id
  from base b;
alter table perf_cases add primary key (id);
alter table perf_cases add column insurer_id uuid, add column template_id uuid, add column claim_type public.claim_type;
update perf_cases p set insurer_id = i.id from public.insurers i where i.code = p.insurer_code;
update perf_cases p set template_id = t.id, claim_type = t.claim_type
  from public.case_templates t
 where t.insurer_id = p.insurer_id and t.is_active
   and t.variant = case when p.insurer_code = 'IGI' and pg_temp.r('var' || p.n) < 0.3 then 'theft' else 'od' end;
update perf_cases set claim_type = (case insurer_code when 'DHI' then 'health' when 'TLA' then 'death' else 'motor' end)::public.claim_type
 where template_id is null;

insert into public.cases (id, insurer_id, insurer_claim_no, policy_no, claim_type, claim_amount, suspicion_summary,
                          incident_date, received_at, status, office_owner_id, template_id, created_by)
select p.id, p.insurer_id, 'PRF/' || p.insurer_code || '/' || lpad(p.n::text, 6, '0'), 'POL' || lpad((p.n * 7919 % 1000000)::text, 7, '0'),
       p.claim_type, round((pg_temp.r('amt' || p.n) * 900000 + 20000)::numeric, 2),
       'Synthetic suspicion summary for perf case ' || p.n || ': delayed intimation, garage estimate inflated.',
       (p.received_at - interval '9 days')::date, p.received_at,
       case when p.final_status in ('received', 'intake_confirmed') then p.final_status else 'assigned' end,
       p.owner_id, p.template_id, p.owner_id
  from perf_cases p order by p.n;

insert into public.parties (case_id, role, name, phone, address)
select p.id, r.role, 'Perf ' || r.role || ' ' || p.n, '98' || lpad((p.n * 31 % 100000000)::text, 8, '0'), 'Address line for case ' || p.n
  from perf_cases p cross join (values ('insured'::public.party_role), ('driver'::public.party_role)) r(role);

-- ---------------------------------------------------------------------
-- 3. Field tasks (~12 000) with checklist items
-- ---------------------------------------------------------------------
create temp table perf_tasks as
select gen_random_uuid() as id, p.id as case_id, p.n, t.idx, t.cnt, p.owner_id, p.final_status, p.received_at,
       (select f.id from perf_field f where f.k = (p.n * 7 + t.idx * 3) % 10) as assignee_id,
       p.received_at + make_interval(days => t.idx) as created_at,
       case when p.final_status = 'cancelled' then 'cancelled'
            when p.final_status = 'field_in_progress' and t.idx = t.cnt then
                 case when pg_temp.r('tp' || p.n) < 0.5 then 'pending' else 'in_progress' end
            else 'completed' end::public.task_status as status,
       case when t.idx = 1 then 'initial' when pg_temp.r('ri' || p.n || '.' || t.idx) < 0.15 then 're_investigation'
            else 'other' end::public.task_kind as kind,
       p.claim_type
  from perf_cases p
 cross join lateral (select g as idx, case when p.n % 3 = 0 then 4 else 3 end as cnt
                       from generate_series(1, case when p.n % 3 = 0 then 4 else 3 end) g) t
 where p.final_status not in ('received', 'intake_confirmed', 'assigned');
alter table perf_tasks add primary key (id);
create index on perf_tasks (case_id, idx);

insert into public.tasks (id, case_id, kind, parent_task_id, title, instructions, assignee_id, due_at, status,
                          location_text, created_by, started_at, completed_at, created_at)
select t.id, t.case_id, t.kind,
       case when t.kind = 're_investigation' then (select f.id from perf_tasks f where f.case_id = t.case_id and f.idx = 1) end,
       case t.kind when 'initial' then 'Garage and spot visit' when 're_investigation' then 'Re-investigation: statement of driver'
            else 'Collect documents (' || t.idx || ')' end,
       'Visit, photograph the vehicle and collect documents.', t.assignee_id, t.created_at + interval '5 days', t.status,
       'Perf location ' || t.n, t.owner_id,
       case when t.status <> 'pending' then t.created_at + interval '1 day' end,
       case when t.status = 'completed' then t.created_at + interval '3 days' end,
       t.created_at
  from perf_tasks t order by t.created_at;

insert into public.task_holds (task_id, profile_id, held_from, held_until)
select t.id, t.assignee_id, t.created_at, t.created_at + interval '3 days'
  from perf_tasks t where t.status in ('completed', 'cancelled');

insert into public.task_checklist_items (task_id, source_template_item_id, position, description, required_evidence_type,
                                         is_mandatory, camera_only, status, category_id, completed_at)
select t.id, i.id, i.position, i.description, i.required_evidence_type, i.is_mandatory, i.camera_only,
       case when t.status = 'completed' then 'captured' when t.status = 'cancelled' then 'pending'
            when pg_temp.r('ci' || t.id || i.position) < 0.5 then 'captured' else 'pending' end::public.checklist_status,
       i.category_id,
       case when t.status = 'completed' then t.created_at + interval '2 days' end
  from perf_tasks t
  join public.checklist_templates ct on ct.is_active
       and ct.name = case when t.claim_type = 'motor' then 'Motor OD — garage and spot visit' else 'Health claim — hospital visit' end
  join public.checklist_template_items i on i.template_id = ct.id;

-- ---------------------------------------------------------------------
-- 4. Thread messages (~190 000 on top of the ~12 000 task system messages)
-- ---------------------------------------------------------------------
create temp table perf_msgs as
select gen_random_uuid() as id, t.case_id, t.id as task_id, case when m.k <= 13 then t.id end as msg_task_id,
       t.n, m.k, m.kind, m.sender_id, m.visibility, m.body,
       t.created_at + make_interval(hours => 2 + m.k * 3) as created_at
  from perf_tasks t
 cross join lateral (
    select g as k,
           case when g <= 10 then 'media' else 'text' end::public.message_kind as kind,
           case when g <= 13 then t.assignee_id else t.owner_id end as sender_id,
           case when g = 16 then 'staff' else 'all' end as visibility,
           case when g <= 10 then case when g % 3 = 0 then 'Photo ' || g end
                when g <= 13 then 'Reached the location; vehicle and documents checked (' || g || ').'
                when g <= 15 then 'Please also photograph the chassis number and the odometer (' || g || ').'
                else 'Staff note: insured not cooperating, follow up by phone.' end as body
      from generate_series(1, case when t.idx % 2 = 0 then 16 else 15 end) g) m
 where t.status <> 'cancelled' or m.k <= 3;
alter table perf_msgs add primary key (id);

insert into public.case_messages (id, case_id, sender_id, kind, body, task_id, client_message_id, visibility)
select id, case_id, sender_id, kind, body, msg_task_id, gen_random_uuid(), visibility
  from perf_msgs order by case_id, k;

-- ---------------------------------------------------------------------
-- 5. Emails, attachments, intake extractions
-- ---------------------------------------------------------------------
create temp table perf_emails as
select gen_random_uuid() as id, p.id as case_id, p.n, e.k, p.insurer_id, p.template_id, p.insurer_code,
       p.received_at + make_interval(days => (e.k - 1) * 4) as received_at
  from perf_cases p
 cross join lateral generate_series(1, case when p.n % 2 = 0 then 2 else 1 end) e(k);
alter table perf_emails add primary key (id);

insert into public.emails (id, gmail_message_id, gmail_thread_id, from_address, to_addresses, subject, body_text, received_at,
                           raw_storage_path, classification, status, insurer_id, case_id, processed_at, in_reply_to,
                           references_ids, raw_sha256, template_id, parser_version)
select e.id, '<perf-' || e.n || '-' || e.k || '@mail.example>', 'thr-' || e.n, 'claims@' || lower(e.insurer_code) || '.example',
       array['intake@example.com']::public.citext[],
       case when e.k = 1 then 'Investigation request PRF/' || e.insurer_code || '/' || lpad(e.n::text, 6, '0')
            else 'Re: Investigation request PRF/' || e.insurer_code || '/' || lpad(e.n::text, 6, '0') end,
       repeat('Dear team, please investigate the claim. Details follow in the template table. ', 12),
       e.received_at, 'raw/perf/' || e.id || '.eml',
       case when e.k = 1 then 'new_case' else 'additional_docs' end::public.email_classification, 'processed',
       e.insurer_id, e.case_id, e.received_at + interval '1 minute',
       case when e.k > 1 then '<perf-' || e.n || '-1@mail.example>' end,
       case when e.k > 1 then array['<perf-' || e.n || '-1@mail.example>'] else '{}' end,
       pg_temp.hex64('raw' || e.id), e.template_id, 'rules-v1'
  from perf_emails e order by e.received_at;

-- review queue, failed mail, ignored mail (not linked to a case)
insert into public.emails (gmail_message_id, from_address, subject, body_text, received_at, raw_storage_path, classification,
                           status, insurer_id, error, retry_requested_at, retry_attempts)
select '<perf-unlinked-' || g || '@mail.example>', case when g % 5 = 0 then 'someone@unknown.example' else 'claims@icl.example' end,
       'Unlinked mail ' || g, 'Body ' || g, now() - make_interval(hours => g),
       'raw/perf/unlinked-' || g || '.eml',
       case when g <= 30 then 'new_case' else 'other' end::public.email_classification,
       case when g <= 30 then 'processed' when g <= 70 then 'failed' when g <= 80 then 'retry_requested' else 'ignored' end::public.email_status,
       (select id from public.insurers where code = 'ICL'),
       case when g between 31 and 80 then 'Parser error ' || g end,
       case when g between 71 and 80 then now() - make_interval(mins => g) end,
       case when g between 31 and 50 then 1 else 0 end
  from generate_series(1, 500) g;

insert into public.intake_extractions (email_id, case_id, model, extracted, status, reviewed_by, reviewed_at, template_id, parser_action)
select e.id, e.case_id, 'rules-v1', jsonb_build_object('insurer_claim_no', 'PRF/' || e.insurer_code || '/' || lpad(e.n::text, 6, '0')),
       'confirmed', 'a0000000-0000-4000-8000-000000000002', e.received_at + interval '2 minutes', e.template_id, 'create_case'
  from perf_emails e where e.k = 1;
insert into public.intake_extractions (email_id, model, extracted, status, template_id, parser_action, missing_required)
select e.id, 'rules-v1', jsonb_build_object('insurer_claim_no', 'NEW/' || e.id), 'pending_review',
       (select id from public.case_templates where insurer_id = e.insurer_id and is_active limit 1), 'review', '{policy_no}'
  from public.emails e where e.gmail_message_id like '<perf-unlinked-%' and e.classification = 'new_case';

create temp table perf_att as
select gen_random_uuid() as id, e.id as email_id, e.case_id, e.n, e.k, a.j,
       (array['claim_form.pdf', 'RC_copy.jpg', 'DL_front.jpg', 'estimate.pdf', 'policy_schedule.pdf', 'spot_photo_1.jpg'])[a.j] as filename
  from perf_emails e cross join lateral generate_series(1, case when e.k = 1 then 3 + e.n % 3 else 1 end) a(j);
alter table perf_att add column sha256 text, add column rn bigint;
update perf_att set sha256 = pg_temp.hex64('att' || id);
update perf_att a set rn = x.rn from (select id, row_number() over (order by case_id, k, j) rn from perf_att) x where x.id = a.id;

insert into public.email_attachments (id, email_id, filename, mime_type, size_bytes, storage_path, sha256, is_evidence)
select a.id, a.email_id, a.filename, case when a.filename like '%.pdf' then 'application/pdf' else 'image/jpeg' end,
       200000 + a.j * 10000, 'attachments/perf/' || a.email_id || '/' || a.filename, a.sha256, true
  from perf_att a;

-- ---------------------------------------------------------------------
-- 6. Evidence (~150 000): field photos / documents on media messages, insurer attachments
-- ---------------------------------------------------------------------
create temp table perf_ev as
select gen_random_uuid() as id, m.case_id, m.task_id, m.id as message_id, m.sender_id, m.n, m.k, f.j, m.created_at,
       case when f.j = 2 then 'photo' when m.k = 10 then 'document' when m.k = 9 and m.n % 4 = 0 then 'video'
            when m.k = 9 and m.n % 4 = 1 then 'audio' else 'photo' end::public.evidence_type as evidence_type
  from perf_msgs m
 cross join lateral generate_series(1, case when pg_temp.r('two' || m.id) < 0.1 then 2 else 1 end) f(j)
 where m.kind = 'media';
alter table perf_ev add primary key (id);
alter table perf_ev add column sha256 text, add column b int;
update perf_ev set sha256 = pg_temp.hex64('ev' || id), b = (('x' || substr(md5(id::text), 1, 7))::bit(28)::int) % 20;

insert into public.evidence (id, case_id, task_id, evidence_type, capture_source, storage_path, mime_type, size_bytes, sha256,
                             captured_by, device_captured_at, latitude, longitude, gps_accuracy_m, device_info, message_id,
                             original_filename, storage_backend)
select e.id, e.case_id, e.task_id, e.evidence_type,
       case when e.k % 4 = 0 then 'gallery' else 'camera' end::public.capture_source,
       'cases/' || e.case_id || '/tasks/' || e.task_id || '/' || e.sha256 || '.' ||
           case e.evidence_type when 'document' then 'pdf' when 'video' then 'mp4' when 'audio' then 'm4a' else 'jpg' end,
       case e.evidence_type when 'document' then 'application/pdf' when 'video' then 'video/mp4' when 'audio' then 'audio/mp4' else 'image/jpeg' end,
       1500000 + (e.k * 37000), e.sha256, e.sender_id, e.created_at - interval '5 minutes',
       18.5 + pg_temp.r('lat' || e.id) / 10, 73.8 + pg_temp.r('lng' || e.id) / 10, 8,
       '{"model":"Perf phone","os":"android 15"}', e.message_id,
       'IMG_' || e.n || '_' || e.k || '_' || e.j || '.jpg', 'r2'
  from perf_ev e order by e.case_id, e.k, e.j;

analyze public.evidence, public.processing_jobs, public.evidence_labels, public.email_attachments;

-- Batches with a commit each: the filename-label and category-map triggers open a subtransaction
-- per row, and tens of thousands of them in one transaction get slower and slower.
do $$
begin
    for i_b in 0 .. 19 loop
        insert into public.evidence (case_id, evidence_type, capture_source, storage_path, mime_type, size_bytes, sha256,
                                     email_attachment_id, original_filename, storage_backend)
        select a.case_id, case when a.filename like '%.pdf' then 'document' else 'photo' end::public.evidence_type, 'email_attachment',
               'attachments/perf/' || a.email_id || '/' || a.filename,
               case when a.filename like '%.pdf' then 'application/pdf' else 'image/jpeg' end, 200000 + a.j * 10000, a.sha256,
               a.id, a.filename, 'supabase'
          from perf_att a where a.rn % 20 = i_b order by a.case_id, a.k, a.j;
        commit;
    end loop;
end $$;

-- labels: one active LLM label per field photo / document, an older inactive one on every tenth file
create temp table perf_cats as select row_number() over (order by code) - 1 as k, id from public.evidence_categories;
do $$
begin
    for i_b in 0 .. 19 loop
        insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, is_active, description, model)
        select e.id, (select c.id from perf_cats c where c.k = (e.n * 3 + e.k + 7) % 25), 0.55, 'llm', 'label-v0', false,
               'Earlier description of the file', 'claude-haiku'
          from perf_ev e where e.evidence_type in ('photo', 'document') and pg_temp.r('old' || e.id) < 0.1 and e.b = i_b;
        insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, is_active, description, model)
        select e.id, (select c.id from perf_cats c where c.k = (e.n + e.k) % 25), 0.7 + pg_temp.r('cf' || e.id) * 0.3, 'llm', 'label-v1', true,
               'Photo of the vehicle at the garage, front bumper damaged, number plate visible.', 'claude-haiku'
          from perf_ev e where e.evidence_type in ('photo', 'document') and pg_temp.r('lab' || e.id) < 0.95 and e.b = i_b;
        commit;
    end loop;
end $$;

analyze public.evidence_labels, public.evidence_field_matches, public.processing_jobs;

-- 384 / 1600 px copies of every field photo
insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height)
select e.id, w.width, private.derivative_path(e.case_id, e.sha256, w.width, pg_temp.hex64(e.sha256 || w.width)),
       pg_temp.hex64(e.sha256 || w.width), w.width * 150, w.width, w.width * 3 / 4
  from perf_ev e cross join (values (384), (1600)) w(width)
 where e.evidence_type = 'photo';

-- device OCR on 60 % of photos and documents
insert into public.evidence_ocr (evidence_id, page_no, engine, engine_version, lang, text, blocks, mean_confidence, is_current,
                                 summary, source_width)
select e.id, 1, 'mlkit_device', 'mlkit-1', 'en',
       'MAHARASHTRA MH12 AB ' || (1000 + e.n % 9000) || ' ' || repeat('Garage estimate line item, labour and parts. ', 6),
       '[{"text":"MH12 AB","bbox":[10,10,200,40],"conf":0.92,"line":0}]', 0.85, true, 'Number plate and estimate text',
       case when e.evidence_type = 'photo' then 1600 end
  from perf_ev e where e.evidence_type in ('photo', 'document') and pg_temp.r('ocr' || e.id) < 0.6;

-- processing queue: almost everything finished
update public.processing_jobs j set status = 'skipped', finished_at = now()
  from public.evidence_ocr o where o.evidence_id = j.evidence_id and j.stage = 'ocr' and j.status = 'queued';
update public.processing_jobs j
   set status = case when pg_temp.r('job' || j.id) < 0.985 then 'done' when pg_temp.r('job' || j.id) < 0.993 then 'failed' else 'queued' end::public.job_status,
       attempts = 1, finished_at = now()
 where j.status = 'queued';

-- file comments (~10 000)
insert into public.evidence_comments (evidence_id, case_id, author_id, body, client_comment_id)
select e.id, e.case_id, e.sender_id, 'Operator comment: this photo was taken at the garage gate.', gen_random_uuid()
  from perf_ev e where pg_temp.r('com' || e.id) < 0.07;

-- ---------------------------------------------------------------------
-- 7. Report values (~150 000) and field suggestions
-- ---------------------------------------------------------------------
insert into public.case_field_values (case_id, field_id, value, source, confidence, updated_by)
select p.id, f.id,
       case f.key when 'insurer_claim_no' then c.insurer_claim_no when 'policy_no' then c.policy_no
                  when 'insured_name' then 'Perf Insured ' || p.n
                  else case f.field_type when 'date' then to_char(p.received_at, 'YYYY-MM-DD')
                                         when 'datetime' then to_char(p.received_at, 'YYYY-MM-DD"T"HH24:MI')
                                         when 'number' then '42' when 'currency' then '125000' when 'boolean' then 'true'
                                         else 'Synthetic value of ' || f.key || ' for case ' || p.n end end,
       case when f.source = 'intake' then 'email_parser' else 'office' end::public.field_value_source,
       case when f.source = 'intake' then 0.9 end, p.owner_id
  from perf_cases p
  join public.cases c on c.id = p.id
  join public.case_template_fields f on f.template_id = p.template_id
 where f.source = 'intake'
    or f.is_required and p.final_status in ('orchestrator_review', 'submitted', 'closed')
    or (p.final_status in ('office_review', 'orchestrator_review', 'submitted', 'closed') and pg_temp.r('fv' || p.n || f.key) < 0.85)
    or (p.final_status = 'field_in_progress' and pg_temp.r('fv' || p.n || f.key) < 0.2);

insert into public.field_suggestions (evidence_id, ocr_id, field_id, value, confidence, source, status)
select o.evidence_id, o.id, f.id, 'MH12 AB ' || (1000 + e.n % 9000), 0.8, 'model',
       case when pg_temp.r('sg' || o.id) < 0.5 then 'pending' else 'accepted' end::public.suggestion_status
  from public.evidence_ocr o
  join perf_ev e on e.id = o.evidence_id and e.evidence_type = 'document'
  join perf_cases p on p.id = e.case_id
  join public.case_template_fields f on f.template_id = p.template_id and f.key = 'vehicle_no';

-- ---------------------------------------------------------------------
-- 8. Reports, approvals, submissions, final statuses
-- ---------------------------------------------------------------------
update public.cases c set status = 'office_review'
  from perf_cases p where p.id = c.id and p.final_status in ('office_review', 'orchestrator_review', 'submitted', 'closed');

insert into public.reports (case_id, version, status, storage_path, uploaded_by, origin, template_id)
select p.id, 1, 'final', 'cases/' || p.id || '/report-v1.pdf', p.owner_id, 'uploaded', p.template_id
  from perf_cases p where p.final_status in ('orchestrator_review', 'submitted', 'closed');
insert into public.report_files (report_id, format, storage_path, size_bytes)
select r.id, 'pdf', r.storage_path, 900000 from public.reports r join perf_cases p on p.id = r.case_id;

insert into public.report_approvals (case_id, report_id, requested_by)
select r.case_id, r.id, r.uploaded_by from public.reports r join perf_cases p on p.id = r.case_id where p.template_id is not null;

begin;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
update public.report_approvals a set decision = 'approved'
  from perf_cases p where p.id = a.case_id and p.final_status in ('submitted', 'closed');
commit;

insert into public.submissions (case_id, report_id, channel, submitted_by, formats, to_addresses, acknowledged_at)
select r.case_id, r.id, 'email', r.uploaded_by, '{pdf}', array['claims@example.com']::public.citext[],
       case when p.final_status = 'closed' then now() end
  from public.reports r join perf_cases p on p.id = r.case_id where p.final_status in ('submitted', 'closed');

update public.cases c set status = p.final_status
  from perf_cases p where p.id = c.id and c.status is distinct from p.final_status;

-- read pointers: operators and owners have read their threads up to some point
insert into public.case_thread_reads (case_id, user_id, last_read_at)
select distinct on (t.case_id, t.assignee_id) t.case_id, t.assignee_id, t.created_at + interval '20 hours'
  from perf_tasks t order by t.case_id, t.assignee_id, t.created_at desc;
insert into public.case_thread_reads (case_id, user_id, last_read_at)
select p.id, p.owner_id, p.received_at + interval '6 days' from perf_cases p
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 9. Back-date timestamps (guards stamp now() and forbid changes; this session only)
-- ---------------------------------------------------------------------
begin;
set local session_replication_role = replica;
update public.cases c set created_at = p.received_at, updated_at = p.received_at + interval '10 days',
       office_assigned_at = p.received_at
  from perf_cases p where p.id = c.id;
update public.case_assignments a set assigned_at = p.received_at from perf_cases p where p.id = a.case_id;
update public.case_status_history h
   set changed_at = p.received_at + make_interval(hours => h.id::int % 400)
  from perf_cases p where p.id = h.case_id;
update public.case_messages m set created_at = x.created_at from perf_msgs x where x.id = m.id;
update public.case_messages m set created_at = t.created_at
  from perf_tasks t where m.task_id = t.id and m.kind in ('system', 'request');
update public.case_messages m set created_at = p.received_at + interval '1 day'
  from perf_cases p where m.case_id = p.id and m.kind = 'system' and m.task_id is null;
update public.evidence e set created_at = x.created_at, server_received_at = x.created_at from perf_ev x where x.id = e.id;
update public.evidence e set created_at = p.received_at, server_received_at = p.received_at
  from perf_cases p where e.case_id = p.id and e.capture_source = 'email_attachment';
update public.evidence_labels l set created_at = e.server_received_at + interval '1 minute'
  from public.evidence e where e.id = l.evidence_id and e.case_id in (select id from perf_cases);
update public.evidence_ocr o set created_at = e.server_received_at + interval '1 minute'
  from public.evidence e where e.id = o.evidence_id and e.case_id in (select id from perf_cases);
update public.processing_jobs j set created_at = e.server_received_at, run_after = e.server_received_at,
       finished_at = case when j.finished_at is not null then e.server_received_at + interval '2 minutes' end
  from public.evidence e where e.id = j.evidence_id and e.case_id in (select id from perf_cases);
update public.notifications n set created_at = p.received_at + interval '1 day',
       read_at = case when p.final_status in ('submitted', 'closed', 'cancelled') then p.received_at + interval '2 days' end
  from perf_cases p where p.id = n.case_id;
update public.tasks t set updated_at = x.created_at + interval '3 days' from perf_tasks x where x.id = t.id;
commit;

analyze;

select 'cases' as t, count(*) from public.cases union all
select 'tasks', count(*) from public.tasks union all
select 'task_checklist_items', count(*) from public.task_checklist_items union all
select 'case_messages', count(*) from public.case_messages union all
select 'evidence', count(*) from public.evidence union all
select 'evidence_labels', count(*) from public.evidence_labels union all
select 'evidence_derivatives', count(*) from public.evidence_derivatives union all
select 'evidence_ocr', count(*) from public.evidence_ocr union all
select 'evidence_field_matches', count(*) from public.evidence_field_matches union all
select 'evidence_comments', count(*) from public.evidence_comments union all
select 'processing_jobs', count(*) from public.processing_jobs union all
select 'case_field_values', count(*) from public.case_field_values union all
select 'field_suggestions', count(*) from public.field_suggestions union all
select 'emails', count(*) from public.emails union all
select 'email_attachments', count(*) from public.email_attachments union all
select 'reports', count(*) from public.reports union all
select 'submissions', count(*) from public.submissions union all
select 'notifications', count(*) from public.notifications union all
select 'audit_log', count(*) from public.audit_log
order by 1;
