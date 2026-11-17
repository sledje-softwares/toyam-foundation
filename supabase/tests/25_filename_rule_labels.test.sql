-- Piece H: insurer attachments are labelled from their file names when the evidence row is inserted.
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','25000000-0000-4000-8000-0000000000a1','authenticated','authenticated','h-o1@example.com',null,'{"role":"office","full_name":"H Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','25000000-0000-4000-8000-0000000000a2','authenticated','authenticated','h-o2@example.com',null,'{"role":"office","full_name":"H Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','25000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870000001','{"role":"field","full_name":"H Field"}','{}');
insert into public.insurers (id, name, code) values ('25100000-0000-4000-8000-000000000001', 'H Insurer', 'HFN');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status, office_owner_id)
values ('25300000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000001', 'HFN-1', 'motor', 'assigned',
        '25000000-0000-4000-8000-0000000000a1');
insert into public.tasks (id, case_id, title, assignee_id)
values ('25400000-0000-4000-8000-000000000001', '25300000-0000-4000-8000-000000000001', 'Visit', '25000000-0000-4000-8000-0000000000f1');
insert into public.emails (id, gmail_message_id, from_address, received_at, case_id, raw_storage_path)
values ('25600000-0000-4000-8000-000000000001', 'h-mail-1', 'a@insurer.example', now(), '25300000-0000-4000-8000-000000000001',
        'emails/h/message.eml');

-- the categories as in config/templates/_categories.yaml (patterns only; same codes)
select public.load_evidence_categories($j$[
 {"code":"vehicle_photo","name":"Vehicle photo","filename_patterns":["front view","rear view","left (front|rear)? ?(side|view)","right (front|rear)? ?(side|view)","windshield","qc_initial","damage"]},
 {"code":"odometer_photo","name":"Odometer photo","ocr":true,"filename_patterns":["odometer","odo"]},
 {"code":"chassis_engine_photo","name":"Chassis / engine number photo","ocr":true,"filename_patterns":["chassis","engine no"]},
 {"code":"rc_document","name":"RC","default_evidence_type":"document","filename_patterns":["\\brc\\b","registration"]},
 {"code":"dl_document","name":"Driving licence","default_evidence_type":"document","filename_patterns":["driving licen[cs]e","\\bdl\\b"]},
 {"code":"policy_document","name":"Policy copy","default_evidence_type":"document","filename_patterns":["policy"]},
 {"code":"claim_form","name":"Claim form","default_evidence_type":"document","filename_patterns":["eclaim","claim form","intimation"]},
 {"code":"estimate","name":"Repair estimate","default_evidence_type":"document","filename_patterns":["estimate","quotation"]},
 {"code":"proof_of_dispatch","name":"POD","default_evidence_type":"document","filename_patterns":["\\bpod\\b","dispatch","speed ?post"]},
 {"code":"id_document","name":"Identity document","default_evidence_type":"document","filename_patterns":["aadhaar","aadhar","\\bpan\\b","aml documents","kyc","voter"]}]$j$::jsonb);

-- One evidence row per call. Email attachments get an email_attachments row first (the evidence link is required).
create function pg_temp.add_file(p_name text, p_n int, p_source text default 'email_attachment') returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_att uuid := gen_random_uuid(); v_sha text := repeat(lpad(p_n::text, 2, '0'), 32);
begin
    if p_source = 'email_attachment' then
        insert into public.email_attachments (id, email_id, filename, mime_type, storage_path, sha256)
        values (v_att, '25600000-0000-4000-8000-000000000001', p_name, 'image/jpeg', 'emails/h/att/' || p_n, v_sha);
        insert into public.evidence (id, case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256,
                                     original_filename, email_attachment_id, captured_by)
        values (v_id, '25300000-0000-4000-8000-000000000001', 'photo', 'email_attachment', 'supabase', 'emails/h/att/' || p_n,
                'image/jpeg', v_sha, p_name, v_att, null);
    else
        insert into public.evidence (id, case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, sha256,
                                     original_filename, captured_by)
        values (v_id, '25300000-0000-4000-8000-000000000001', 'photo', p_source::public.capture_source, 'supabase',
                'cases/h/' || p_n, 'image/jpeg', v_sha, p_name, '25000000-0000-4000-8000-0000000000f1');
    end if;
    return v_id;
end $$;
create function pg_temp.codes(p_prefix text) returns text language sql as $$
    select coalesce(string_agg(distinct c.code, ',' order by c.code), '')
      from public.evidence e
      join public.evidence_labels l on l.evidence_id = e.id and l.is_active and l.source = 'filename_rule'
      join public.evidence_categories c on c.id = l.category_id
     where e.original_filename like p_prefix || '%' $$;

select pg_temp.add_file(n, i) from (values
  ('Front View(1)_1699999999_123456_MOT00000001_17-11-2026.jpg', 1),
  ('Left Rear Side(1)_1699999999_123457_MOT00000001_17-11-2026.jpg', 2),
  ('Odometer(1)_1699999999_123458_MOT00000001_17-11-2026.jpg', 3),
  ('Chassis No(1)_1699999999_123459_MOT00000001_17-11-2026.jpg', 4),
  ('QC_Initial1_1699999999_123460_MOT00000001_17-11-2026.jpg', 5),
  ('AADHAAR(1)_1699999999_123461_MOT00000001_17-11-2026.jpg', 6),
  ('AML DOCUMENTS(1)_1699999999_123462_MOT00000001_17-11-2026.jpg', 7),
  ('DRIVING LICENSE(1)_1699999999_123463_MOT00000001_17-11-2026.jpg', 8),
  ('POLICY(2)_1699999999_123464_MOT00000001_17-11-2026.jpg', 9),
  ('ESTIMATE(1)_1699999999_123465_MOT00000001_17-11-2026.jpg', 10),
  ('ECLAIM_MOT00000001_123456789.PDF', 11),
  ('image001.png', 12),
  ('Policy and RC.pdf', 13),
  ('RC.pdf', 17), ('DL extract.pdf', 18), ('POD.pdf', 19), ('ARCADE.jpg', 20), ('Gym.jpg', 21)) v(n, i);

-- A. each sample name maps to its category
select is(pg_temp.codes('Front View'), 'vehicle_photo', 'Front View -> vehicle_photo');
select is(pg_temp.codes('Left Rear Side'), 'vehicle_photo', 'Left Rear Side -> vehicle_photo');
select is(pg_temp.codes('Odometer'), 'odometer_photo', 'Odometer -> odometer_photo');
select is(pg_temp.codes('Chassis No'), 'chassis_engine_photo', 'Chassis No -> chassis_engine_photo');
select is(pg_temp.codes('QC_Initial1'), 'vehicle_photo', 'QC_Initial1 -> vehicle_photo');
select is(pg_temp.codes('AADHAAR'), 'id_document', 'AADHAAR -> id_document');
select is(pg_temp.codes('AML DOCUMENTS'), 'id_document', 'AML DOCUMENTS -> id_document');
select is(pg_temp.codes('DRIVING LICENSE'), 'dl_document', 'DRIVING LICENSE -> dl_document');
select is(pg_temp.codes('POLICY'), 'policy_document', 'POLICY -> policy_document');
select is(pg_temp.codes('ESTIMATE'), 'estimate', 'ESTIMATE -> estimate');
select is(pg_temp.codes('ECLAIM'), 'claim_form', 'ECLAIM pdf -> claim_form');
select is(pg_temp.codes('image001'), '', 'unmatched name gets no label');
select is(pg_temp.codes('Policy and RC'), 'policy_document,rc_document', 'several categories can match');

select is(pg_temp.codes('RC.pdf'), 'rc_document', 'RC.pdf matches \brc\b (translated to \y)');
select is(pg_temp.codes('DL extract'), 'dl_document', 'DL extract.pdf -> dl_document');
select is(pg_temp.codes('POD.pdf'), 'proof_of_dispatch', 'POD.pdf -> proof_of_dispatch');
select is(pg_temp.codes('ARCADE'), '', 'ARCADE.jpg does not hit rc by accident');
select is(pg_temp.codes('Odometer('), 'odometer_photo', 'Odometer does not hit pod or rc');
select is(pg_temp.codes('Gym'), '', 'unrelated name stays unlabelled');

-- B. the LLM label job is skipped for rule-labelled files only
select is((select j.status::text from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.original_filename like 'Odometer%' and j.stage = 'label'), 'skipped', 'label job skipped for a rule-labelled file');
select is((select j.status::text from public.processing_jobs j join public.evidence e on e.id = j.evidence_id
            where e.original_filename = 'image001.png' and j.stage = 'label'), 'queued', 'label job stays queued for an unmatched file');

-- C. other capture sources are not touched
select pg_temp.add_file('Front View(1)_1699999999_1.jpg', 14, 'camera');
select is(pg_temp.codes('Front View(1)_1699999999_1.jpg'), '', 'field-app evidence gets no rule label');

-- D. idempotent
select is(private.apply_filename_labels((select id from public.evidence where original_filename = 'Policy and RC.pdf')), 0,
          'second run inserts nothing');
select is(pg_temp.codes('Policy and RC'), 'policy_document,rc_document', 'labels unchanged after a second run');

-- E. never overrides a human label
select pg_temp.add_file('Estimate human.jpg', 15);
update public.evidence_labels set is_active = false
 where evidence_id = (select id from public.evidence where original_filename = 'Estimate human.jpg');
insert into public.evidence_labels (evidence_id, category_id, confidence, source)
select e.id, c.id, 1, 'human' from public.evidence e, public.evidence_categories c
 where e.original_filename = 'Estimate human.jpg' and c.code = 'rc_document';
select is(private.apply_filename_labels((select id from public.evidence where original_filename = 'Estimate human.jpg')), 0,
          'a file with an active human label is left alone');
select is(pg_temp.codes('Estimate human'), '', 'no rule label added next to the human label');

-- F. a broken pattern does not block intake or other categories
insert into public.evidence_categories (code, name, filename_patterns) values ('zz_bad', 'Bad pattern', array['(', 'odometer']);
select lives_ok($$select pg_temp.add_file('Odometer bad pattern.jpg', 16)$$, 'evidence insert survives an invalid regex in config');
select is(pg_temp.codes('Odometer bad'), 'odometer_photo,zz_bad', 'valid patterns still apply');
update public.evidence_categories set is_active = false where code = 'zz_bad';

-- G. backfill (service role only)
update public.evidence_labels set is_active = false
 where evidence_id = (select id from public.evidence where original_filename like 'ESTIMATE%');
select ok(public.backfill_filename_labels() >= 1, 'backfill labels unlabelled email attachments');
select is(pg_temp.codes('ESTIMATE'), 'estimate', 'backfilled file has its rule label again');

-- H. visibility of the new labels
set local role authenticated;
set local request.jwt.claims to '{"sub":"25000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select ok((select count(*) from public.evidence_labels where source = 'filename_rule') > 0, 'office owner sees the rule labels');
select throws_ok($$select public.backfill_filename_labels()$$, '42501', null::text, 'backfill is not callable by a signed-in user');
set local request.jwt.claims to '{"sub":"25000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select is((select count(*)::int from public.evidence_labels where source = 'filename_rule'), 0, 'another office employee sees none');
set local request.jwt.claims to '{"sub":"25000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.evidence_labels where source = 'filename_rule'), 0, 'field operator sees none');
reset role;

-- I. normalisation
select is(private.filename_label_variants('QC_Initial1_1699999999.jpg'), array['qc_initial1', 'qc initial1'],
          'variants keep short counters, drop identifiers');
select is(private.filename_label_variants(null), '{}'::text[], 'null name gives no variants');

select * from finish();
rollback;
