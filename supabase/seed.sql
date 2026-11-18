-- =====================================================================
-- DEV-ONLY seed data. Loaded by `supabase db reset` / first `supabase start`.
-- Never run against a hosted project.
--
-- Logins (see supabase/README.md):
--   admin@example.com / orchestrator@example.com / office@example.com
--     password: DevPassw0rd!
--   Field 1: phone +91 98000 00001, OTP 123456 (config.toml test_otp)
--   Field 2: phone +91 98000 00002, OTP 123456
-- Profiles are created by the auth.users trigger from app_metadata.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
with u (id, email, phone, meta) as (values
    ('a0000000-0000-4000-8000-000000000001'::uuid, 'admin@example.com',        null,
     '{"provider":"email","providers":["email"],"role":"admin","full_name":"Asha Admin"}'::jsonb),
    ('a0000000-0000-4000-8000-000000000002'::uuid, 'orchestrator@example.com', null,
     '{"provider":"email","providers":["email"],"role":"orchestrator","full_name":"Omkar Orchestrator"}'::jsonb),
    ('a0000000-0000-4000-8000-000000000003'::uuid, 'office@example.com',       null,
     '{"provider":"email","providers":["email"],"role":"office","full_name":"Uma Office"}'::jsonb),
    ('a0000000-0000-4000-8000-000000000011'::uuid, null, '919800000001',
     '{"provider":"phone","providers":["phone"],"role":"field","full_name":"Farid Field","region":"Pune"}'::jsonb),
    ('a0000000-0000-4000-8000-000000000012'::uuid, null, '919800000002',
     '{"provider":"phone","providers":["phone"],"role":"field","full_name":"Fatima Field","region":"Mumbai"}'::jsonb)
)
insert into auth.users (
    instance_id, id, aud, role, email, phone, encrypted_password,
    email_confirmed_at, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.email, u.phone,
       case when u.email is not null then extensions.crypt('DevPassw0rd!', extensions.gen_salt('bf')) else '' end,
       case when u.email is not null then now() end,
       case when u.phone is not null then now() end,
       u.meta, '{}'::jsonb, now(), now(),
       '', '', '', '', '', '', '', ''
from u;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       case when u.email is not null then 'email' else 'phone' end,
       case when u.email is not null
            then jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true)
            else jsonb_build_object('sub', u.id::text, 'phone', u.phone, 'phone_verified', true) end,
       now(), now(), now()
from auth.users u
where u.id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
               'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000011',
               'a0000000-0000-4000-8000-000000000012');

-- ---------------------------------------------------------------------
-- Insurers
-- ---------------------------------------------------------------------
insert into public.insurers (id, name, code, sender_domains, reply_to_email, tat_days, submission_channel, portal_url)
values
    ('b0000000-0000-4000-8000-000000000001', 'Sample General Insurance', 'SGI',
     '{samplegeneral.example}', 'claims@samplegeneral.example', 15, 'email', null),
    ('b0000000-0000-4000-8000-000000000002', 'Demo Health Insurance', 'DHI',
     '{demohealth.example}', 'siu@demohealth.example', 10, 'email', null),
    ('b0000000-0000-4000-8000-000000000003', 'Test Life Assurance', 'TLA',
     '{testlife.example}', null, 21, 'portal', 'https://portal.testlife.example');

-- ---------------------------------------------------------------------
-- Checklist templates
-- ---------------------------------------------------------------------
insert into public.checklist_templates (id, name, claim_type)
values ('c0000000-0000-4000-8000-000000000001', 'Health claim — hospital visit', 'health'),
       ('c0000000-0000-4000-8000-000000000002', 'Motor claim — garage and spot visit', 'motor');

insert into public.checklist_template_items
    (template_id, position, description, required_evidence_type, is_mandatory, camera_only)
values
    ('c0000000-0000-4000-8000-000000000001', 1, 'Hospital front with signboard',          'photo',    true,  true),
    ('c0000000-0000-4000-8000-000000000001', 2, 'Indoor case papers / IPD register',      'photo',    true,  true),
    ('c0000000-0000-4000-8000-000000000001', 3, 'Final bill and discharge summary',       'document', true,  false),
    ('c0000000-0000-4000-8000-000000000001', 4, 'Statement of insured (audio)',           'audio',    false, false),
    ('c0000000-0000-4000-8000-000000000001', 5, 'Field notes',                            'note',     false, false),
    ('c0000000-0000-4000-8000-000000000002', 1, 'Vehicle — all four sides',               'photo',    true,  true),
    ('c0000000-0000-4000-8000-000000000002', 2, 'Chassis and engine number',              'photo',    true,  true),
    ('c0000000-0000-4000-8000-000000000002', 3, 'Spot of accident',                       'photo',    true,  true),
    ('c0000000-0000-4000-8000-000000000002', 4, 'FIR / police panchnama copy',            'document', false, false);

-- ---------------------------------------------------------------------
-- Cases, parties, tasks (all field tasks assigned to Field 1 only)
-- ---------------------------------------------------------------------
insert into public.cases (id, insurer_id, insurer_claim_no, policy_no, claim_type, claim_amount,
                          suspicion_summary, incident_date, received_at, status,
                          orchestrator_id, office_owner_id, created_by)
values
    ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'SGI-CL-1001', 'SGI-POL-55001',
     'health', 185000, 'Admission for 4 days; doubtful duration and billing.', current_date - 20,
     now() - interval '3 days', 'assigned',
     'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003',
     'a0000000-0000-4000-8000-000000000002'),
    ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'DHI-CL-2001', 'DHI-POL-77001',
     'motor', 420000, 'Damage pattern inconsistent with reported accident.', current_date - 12,
     now() - interval '6 days', 'field_in_progress',
     'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003',
     'a0000000-0000-4000-8000-000000000002'),
    ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'TLA-CL-3001', 'TLA-POL-99001',
     'death', 1000000, 'Early death claim within 1 year of policy issue.', current_date - 40,
     now() - interval '1 day', 'intake_confirmed',
     'a0000000-0000-4000-8000-000000000002', null,
     'a0000000-0000-4000-8000-000000000003');

insert into public.parties (case_id, role, name, phone, address, age)
values
    ('d0000000-0000-4000-8000-000000000001', 'insured', 'Ramesh Kumar (sample)', '9000000101', 'Kothrud, Pune', 52),
    ('d0000000-0000-4000-8000-000000000001', 'patient', 'Sunita Kumar (sample)', null, 'Kothrud, Pune', 48),
    ('d0000000-0000-4000-8000-000000000002', 'insured', 'Anil Shah (sample)', '9000000202', 'Andheri, Mumbai', 39),
    ('d0000000-0000-4000-8000-000000000002', 'driver',  'Vijay Patil (sample)', null, 'Andheri, Mumbai', 31),
    ('d0000000-0000-4000-8000-000000000003', 'nominee', 'Meena Rao (sample)', '9000000303', 'Thane', 45);

insert into public.tasks (id, case_id, kind, title, instructions, assignee_id, due_at, status,
                          location_text, created_by, started_at)
values
    ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'initial',
     'Hospital visit — Sample Care Hospital', 'Verify admission dates against IPD register.',
     'a0000000-0000-4000-8000-000000000011', now() + interval '2 days', 'pending',
     'Sample Care Hospital, Kothrud, Pune', 'a0000000-0000-4000-8000-000000000002', null),
    ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'initial',
     'Garage and spot inspection', 'Photograph vehicle and accident spot; collect FIR copy.',
     'a0000000-0000-4000-8000-000000000011', now() + interval '1 day', 'in_progress',
     'Andheri East, Mumbai', 'a0000000-0000-4000-8000-000000000002', now() - interval '1 day'),
    ('e0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', 'office',
     'Verify RC and driving licence online', null,
     'a0000000-0000-4000-8000-000000000003', now() + interval '1 day', 'pending',
     null, 'a0000000-0000-4000-8000-000000000002', null);

select public.apply_checklist_template('e0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
select public.apply_checklist_template('e0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------
-- Intake: one processed email (case 3) and one awaiting review
-- ---------------------------------------------------------------------
insert into public.emails (id, gmail_message_id, gmail_thread_id, from_address, to_addresses, subject, body_text,
                           received_at, classification, status, insurer_id, case_id, processed_at)
values
    ('f0000000-0000-4000-8000-000000000001', 'dev-msg-0001', 'dev-thread-0001', 'siu@testlife.example',
     '{cases@investigation.example}', 'Investigation request: TLA-CL-3001',
     'Please investigate the attached early death claim.', now() - interval '1 day',
     'new_case', 'processed', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003',
     now() - interval '23 hours'),
    ('f0000000-0000-4000-8000-000000000002', 'dev-msg-0002', 'dev-thread-0002', 'claims@samplegeneral.example',
     '{cases@investigation.example}', 'New case SGI-CL-1002 for investigation',
     'Claim no SGI-CL-1002, policy SGI-POL-55002, insured Prakash Joshi, hospital Sample Life Hospital, Nashik.',
     now() - interval '2 hours', 'new_case', 'processed', 'b0000000-0000-4000-8000-000000000001', null,
     now() - interval '2 hours');

insert into public.intake_extractions (email_id, case_id, model, extracted, field_confidence, status,
                                       reviewed_by, reviewed_at)
values
    ('f0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'dev-stub',
     '{"insurer_claim_no":"TLA-CL-3001","policy_no":"TLA-POL-99001","claim_type":"death"}',
     '{"insurer_claim_no":0.98,"policy_no":0.95,"claim_type":0.9}', 'confirmed',
     'a0000000-0000-4000-8000-000000000003', now() - interval '23 hours'),
    ('f0000000-0000-4000-8000-000000000002', null, 'dev-stub',
     '{"insurer_claim_no":"SGI-CL-1002","policy_no":"SGI-POL-55002","claim_type":"health","insured_name":"Prakash Joshi","hospital":"Sample Life Hospital, Nashik"}',
     '{"insurer_claim_no":0.97,"policy_no":0.93,"claim_type":0.88,"insured_name":0.9,"hospital":0.62}',
     'pending_review', null, null);

-- =====================================================================
-- OFFICE DEMO DATA (for the office pages: cases, tasks, reports,
-- submissions, dashboard). Everything below is invented: names, phones,
-- vehicles and claim numbers are fake. Files do not exist in any bucket,
-- so open / download links on these rows will not work.
--
-- Extra logins (password DevPassw0rd!):
--   office2@example.com   office (Neel Office)
--   Field 1-3 also sign in with phone + password: +91 98000 00001 / 2 / 3
-- ---------------------------------------------------------------------

-- Users ---------------------------------------------------------------
with u (id, email, phone, meta) as (values
    ('a0000000-0000-4000-8000-000000000004'::uuid, 'office2@example.com', null,
     '{"provider":"email","providers":["email"],"role":"office","full_name":"Neel Office"}'::jsonb),
    ('a0000000-0000-4000-8000-000000000013'::uuid, null, '919800000003',
     '{"provider":"phone","providers":["phone"],"role":"field","full_name":"Feroz Field","region":"Nashik"}'::jsonb)
)
insert into auth.users (
    instance_id, id, aud, role, email, phone, encrypted_password,
    email_confirmed_at, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.email, u.phone, '',
       case when u.email is not null then now() end,
       case when u.phone is not null then now() end,
       u.meta, '{}'::jsonb, now(), now(),
       '', '', '', '', '', '', '', ''
from u;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       case when u.email is not null then 'email' else 'phone' end,
       case when u.email is not null
            then jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true)
            else jsonb_build_object('sub', u.id::text, 'phone', u.phone, 'phone_verified', true) end,
       now(), now(), now()
from auth.users u
where u.id in ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000013');

-- Field users also get the dev password (phone + password sign-in, M2 T6); office2 too.
update auth.users set encrypted_password = extensions.crypt('DevPassw0rd!', extensions.gen_salt('bf'))
 where id in ('a0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000011',
              'a0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000013');

-- Insurers that match config/templates (codes IGI and ICL)
insert into public.insurers (id, name, code, sender_domains, reply_to_email, tat_days, submission_channel)
values
    ('b0000000-0000-4000-8000-000000000004', 'Indus General Insurance (sample)', 'IGI',
     '{indus-general.example}', 'rcu@indus-general.example', 15, 'email'),
    ('b0000000-0000-4000-8000-000000000005', 'Lombard Sample Insurance', 'ICL',
     '{lombard-sample.example}', 'siu@lombard-sample.example', 12, 'email');

-- Evidence categories and case templates are loaded from config/templates by the generated
-- blocks below (regenerate with `npm run seed:templates -w services/intake`; layouts resolved and
-- assets embedded by the same loader as templates:load). The field checklist
-- sits between them because the template load links checklists by name.

-- BEGIN GENERATED CATEGORIES (npm run seed:templates -w services/intake)
select public.load_evidence_categories($tpl$[{"code":"vehicle_photo","name":"Vehicle photo","description":"Exterior or interior of the insured vehicle, including damage close-ups and number plate views","filename_patterns":["front view","rear view","left (front|rear)? ?(side|view)","right (front|rear)? ?(side|view)","windshield","qc_initial","damage"]},{"code":"odometer_photo","name":"Odometer photo","description":"Instrument cluster showing the odometer reading","ocr":true,"filename_patterns":["odometer","odo"],"text_patterns":["\\bkm\\b.*\\d{3,6}","odo"]},{"code":"chassis_engine_photo","name":"Chassis / engine number photo","description":"Stamped chassis (VIN) or engine number on the vehicle","ocr":true,"filename_patterns":["chassis","engine no"]},{"code":"spot_photo","name":"Accident / loss spot photo","description":"Place of accident or loss: road, junction, landmark, debris","filename_patterns":["spot"]},{"code":"insured_photo","name":"Photo with insured / rider / witness","description":"A person (insured, rider, driver or witness), usually with the investigator or the vehicle","filename_patterns":["insured","rider","selfie"]},{"code":"rc_document","name":"Registration certificate / RC extract","description":"Registration certificate (smart card or paper) or an RC / VAHAN extract","default_evidence_type":"document","filename_patterns":["\\brc\\b","registration"],"text_patterns":["registration certificate","form ?23","vahan","registering authority"]},{"code":"dl_document","name":"Driving licence / DL extract","description":"Driving licence (card or booklet) or a DL / Sarathi extract","default_evidence_type":"document","filename_patterns":["driving licen[cs]e","\\bdl\\b"],"text_patterns":["driving licen[cs]e","licen[cs]ing authority","\\bMCWG\\b|\\bLMV\\b"]},{"code":"policy_document","name":"Policy copy","description":"Insurance policy schedule or certificate of insurance","default_evidence_type":"document","filename_patterns":["policy"],"text_patterns":["policy schedule","certificate of insurance","policy no"]},{"code":"claim_form","name":"Claim form / intimation","description":"Claim form or claim intimation filled by the insured","default_evidence_type":"document","filename_patterns":["eclaim","claim form","intimation"]},{"code":"estimate","name":"Repair estimate","description":"Garage repair estimate or quotation listing parts and labour","default_evidence_type":"document","filename_patterns":["estimate","quotation"],"text_patterns":["estimate","quotation"]},{"code":"job_card","name":"Garage job card / gate entry","description":"Garage job card, repair order or gate entry slip","default_evidence_type":"document","filename_patterns":["job ?card","gate ?pass"],"text_patterns":["job ?card","repair order"]},{"code":"towing_bill","name":"Towing bill","description":"Bill or receipt for towing or crane service","default_evidence_type":"document","filename_patterns":["towing","crane"],"text_patterns":["towing"]},{"code":"id_document","name":"Identity / KYC document","description":"Identity or KYC document of a person (Aadhaar, PAN, voter ID, passport)","default_evidence_type":"document","filename_patterns":["aadhaar","aadhar","\\bpan\\b","aml documents","kyc","voter"],"text_patterns":["government of india","income tax department","unique identification"]},{"code":"fir_police_document","name":"FIR / GD / police document","description":"FIR, general diary entry, panchnama or other police paper","default_evidence_type":"document","filename_patterns":["\\bfir\\b","\\bgd\\b","panchnama","release order","seizure"],"text_patterns":["first information report","police station","panchnama","general diary"]},{"code":"medical_document","name":"Treatment / MLC papers","description":"Hospital or doctor papers: MLC, discharge summary, prescription, bills","default_evidence_type":"document","filename_patterns":["discharge","prescription","\\bmlc\\b","medical"],"text_patterns":["discharge summary","medico.?legal","diagnosis","prescription"]},{"code":"written_statement","name":"Written statement","description":"Handwritten or typed statement or declaration signed by a person","default_evidence_type":"document","filename_patterns":["statement"],"text_patterns":["i hereby","statement","declaration"]},{"code":"avr_recording","name":"Audio / video recording (AVR)","description":"Audio or video recording of a conversation or statement","default_evidence_type":"audio","filename_patterns":["\\bavr\\b","recording","call"]},{"code":"cctv_footage","name":"CCTV / dashcam footage","description":"CCTV or dashcam footage or a still taken from it","default_evidence_type":"video","filename_patterns":["cctv","dashcam","footage"]},{"code":"location_timeline","name":"Google timeline / call log screenshot","description":"Screenshot of a location timeline, map history or call log","ocr":true,"filename_patterns":["timeline","call ?log","location"],"text_patterns":["timeline","call history"]},{"code":"echallan_check","name":"e-Challan / portal check screenshot","description":"Screenshot of an e-Challan or Parivahan portal check","ocr":true,"filename_patterns":["challan","parivahan"],"text_patterns":["e-?challan","parivahan"]},{"code":"vehicle_invoice","name":"Vehicle purchase invoice","description":"Purchase invoice or sale certificate of the vehicle","default_evidence_type":"document","filename_patterns":["invoice"],"text_patterns":["tax invoice","sale certificate"]},{"code":"loan_document","name":"Loan statement / non-repossession letter","description":"Loan statement, hypothecation or non-repossession / NOC letter","default_evidence_type":"document","filename_patterns":["loan","repossession","\\bnoc\\b"],"text_patterns":["loan account","repossess","no objection"]},{"code":"reminder_letter","name":"Reminder / deficiency letter to insured","description":"Reminder or deficiency letter sent to the insured","default_evidence_type":"document","filename_patterns":["reminder","deficiency"]},{"code":"proof_of_dispatch","name":"Proof of dispatch (POD)","description":"Postal receipt or courier tracking proving a letter was sent","default_evidence_type":"document","filename_patterns":["\\bpod\\b","dispatch","speed ?post"]},{"code":"other","name":"Other","description":"Anything that fits none of the categories above"}]$tpl$::jsonb);
-- END GENERATED CATEGORIES

-- Field checklist linked from both templates (by name); items carry evidence categories (D41/D42).
insert into public.checklist_templates (id, name, claim_type)
values ('c0000000-0000-4000-8000-000000000003', 'Motor OD — garage and spot visit', 'motor');

insert into public.checklist_template_items
    (template_id, position, description, required_evidence_type, is_mandatory, camera_only, category_id)
select 'c0000000-0000-4000-8000-000000000003', i.pos, i.descr, i.etype::public.evidence_type, i.mandatory, i.cam,
       (select c.id from public.evidence_categories c where c.code = i.code)
from (values
    (1, 'Vehicle — all four sides',      'photo',    true,  true,  'vehicle_photo'),
    (2, 'Odometer reading',              'photo',    true,  true,  'odometer_photo'),
    (3, 'Chassis and engine number',     'photo',    true,  true,  'chassis_engine_photo'),
    (4, 'Spot of accident',              'photo',    true,  true,  'spot_photo'),
    (5, 'Driving licence copy',          'document', true,  false, 'dl_document'),
    (6, 'FIR / GD copy',                 'document', false, false, 'fir_police_document'),
    (7, 'Photo with insured',            'photo',    false, true,  'insured_photo')
) as i(pos, descr, etype, mandatory, cam, code);

-- BEGIN GENERATED TEMPLATES (npm run seed:templates -w services/intake)
select public.load_case_template($tpl${"insurer_code":"ICL","claim_type":"motor","variant":"od","name":"ICICI Lombard — Motor OD investigation","requires_approval":true,"output_formats":["pdf","docx"],"default_output_format":"pdf","docx_template_path":"report-templates/icl-motor-od.docx","report_layout":{"version":1,"name":"Investigation Report","page":{"size":"Letter","margin_mm":{"top":38,"right":7.5,"bottom":22,"left":7.5},"header_mm":3,"footer_mm":2},"font":{"family":"Cambria","fallback":"Caladea, Cambria, Liberation Serif, Times New Roman, serif","size_pt":10,"color":"#000000","line_height":1.1},"paragraph_spacing_pt":8,"date_format":"dd.MM.yyyy","datetime_format":"dd.MM.yyyy hh:mm a","empty_value":"NA","styles":{"justify":{"align":"justify"},"bold":{"bold":true},"heading3":{"size_pt":10,"bold":true,"align":"center","space_before_pt":2,"space_after_pt":6},"brand_orange":{"font":"Arial","size_pt":22,"bold":true,"color":"#E36C0A"},"brand_rest":{"font":"Arial","size_pt":12,"bold":true,"color":"#000000"},"reg_line":{"size_pt":8,"bold":true,"underline":true},"foot":{"size_pt":9,"align":"right"}},"table_styles":{"grid":{"border":{"width_pt":0.5,"color":"#000000"},"padding_x_mm":1.2,"padding_y_mm":0.35,"heading_style":{"bold":true,"align":"center","background":"#D7D7D7","size_pt":9.5},"space_after_pt":0},"plain":{"border":"none","padding_x_mm":0,"padding_y_mm":0,"space_after_pt":0}},"assets":{"band_top":{"runtime":true,"description":"Orange band across the top edge (firm letterhead)"},"logo":{"runtime":true,"description":"Firm logo (firm letterhead)"},"band_bottom":{"runtime":true,"description":"Orange band along the bottom edge (firm letterhead)"},"seal":{"runtime":true,"description":"Seal and signature of the authorised signatory"}},"header":[{"type":"image","asset":"band_top","width_mm":201,"height_mm":7,"align":"center"},{"type":"paragraph","text":"Reg.No.U74999JH2018PTC010897","style":"reg_line"},{"type":"table","columns":[14,86],"style":"plain","rows":[{"cells":[{"blocks":[{"type":"image","asset":"logo","width_mm":30,"height_mm":13}]},{"runs":[{"text":"TOYAM ","style":"brand_orange"},{"text":"INVESTIGATION AND VALUATION PVT. LTD","style":"brand_rest"}],"valign":"middle"}]}]}],"footer":[{"type":"paragraph","text":"Address: B-325, Ashok Nagar, Road No. 4, Ranchi, Jharkhand 834002 (India)","style":"foot"},{"type":"paragraph","text":"E-mail:-toyaminvestigation@gmail.com","style":"foot"},{"type":"image","asset":"band_bottom","width_mm":201,"height_mm":5,"align":"center"}],"body":[{"type":"table","columns":[40,60],"style":"grid","rows":[{"heading":"Investigation Report"},{"cells":["Name of Investigator","Toyam Investigation and Valuation Pvt. Ltd"]},{"field":"firm_case_ref","label":"Case ref. no (to be provided by Investigator)"},{"cells":["Contact Details of Investigator","Address- H/N-B-325, Road No-4, Ashok Nagar,\nRanchi, Jharkhand-834002\nEmail Id – toyaminvestigation@gmail.com"]},{"field":"insurer_claim_no","label":"Claim No","value_style":"bold"},{"field":"interaction_no","label":"Interaction No."},{"field":"policy_no","label":"Policy No."},{"field":"date_of_loss","label":"Date of loss"},{"field":"time_of_accident","label":"Time of Accident"},{"field":"national_holiday","label":"Did accident happened on National holiday, if yes then state the name of Holiday"},{"field":"intimation_date","label":"Date of claim intimated to call center"},{"field":"late_intimation_reason","label":"Reasons for late intimation to co. (in case delay is more than 10 days)"},{"heading":"Insured details"},{"field":"insured_name","label":"Name of Insured"},{"field":"insured_registration_no","label":"Registration no"},{"cells":["Pan Card no.","As per KYC documents (annexure)"]},{"field":"insured_profession","label":"Insured Profession"},{"field":"insured_actual_address","label":"Address - Actual and not as per policy"},{"field":"negative_area","label":"Address pertains to negative area"},{"field":"contact_person","label":"Contact Person and contact no."},{"heading":"Vehicle Details"},{"field":"vehicle_no","label":"Vehicle Registration no."},{"field":"purchase_invoice","label":"New Vehicle Invoice Details (Purchase)"},{"field":"make_model","label":"Make & Model"},{"field":"registration_date","label":"Registration Date"},{"field":"hypothecation","label":"HYP Details"},{"field":"repayment","label":"Repayment details till date"},{"field":"tp_vehicle","label":"TP Vehicle Details"},{"field":"policy_no","label":"Policy details"},{"field":"policy_period","label":"Policy period"},{"field":"policy_type","label":"Policy Type"},{"field":"agent_dealer","label":"Name of Agent/Dealer (Policy Issuing Authority)"},{"field":"previous_insurer","label":"Previous Insurer (if rollover)"},{"field":"previous_policy_no","label":"Previous Policy No."},{"field":"previous_claim","label":"Any claim reported in previous policy"},{"cells":["Break in",{"text":"{{field.break_in}}","rowspan":4,"valign":"middle"}]},{"cells":["Break in Inspection date (if yes)"]},{"cells":["Odometer reading at the time of break in"]},{"cells":["Any discrepancy in break in and damaged photo"]},{"heading":"Driver details"},{"field":"driver_name","label":"Driver Name"},{"field":"dl_number","label":"DL No."},{"field":"dl_classes","label":"DL details/ Any Endorsements"},{"field":"dl_rto","label":"Name of RTO (Licensing Authority) from DL is issued"},{"field":"dl_observation","label":"Observation"},{"cells":[{"colspan":2,"blocks":[{"type":"photos","section":"driver","columns":1,"max_height_mm":110,"captions":false}]}],"when":{"photos":"driver"}},{"field":"driver_injured","label":"Driver injured or not"},{"field":"neighbour_enquiry","label":"Enquiry from neighbors for accident confirmation"},{"field":"driver_relationship","label":"Driver relationship"},{"field":"injuries_deaths","label":"Need to take account of how many Injuries and death in the accident"},{"field":"nearby_police_hospital","label":"Nearest police station and hospitals to be checked near loss location"},{"field":"discreet_enquiry","label":"Discreet enquiry with the driver at the place of loss"},{"field":"bluetooth_photos","label":"Photos to be exchanged via Bluetooth or snapshot of insured mobile"},{"heading":"Written Statement"},{"cells":[{"text":"Written Statement of Insured ({{field.insured_name}})","valign":"middle"},{"text":"{{field.written_statement}}","style":"justify"}]},{"cells":[{"colspan":2,"blocks":[{"type":"photos","section":"statement","columns":2,"max_height_mm":95,"captions":false}]}],"when":{"photos":"statement"}},{"cells":[{"text":"GPS timeline of insured","valign":"middle"},{"text":"{{field.gps_timeline}}","style":"justify"}]},{"cells":[{"colspan":2,"blocks":[{"type":"photos","section":"timeline","columns":2,"max_height_mm":95,"captions":false}]}],"when":{"photos":"timeline"}},{"heading":"Police Intimation details"},{"field":"fir_no","label":"FIR No.","label_style":{"align":"center"}},{"field":"fir_details","label":"FIR Details","label_style":{"align":"center"}},{"field":"panchanama","label":"Panchanama Details","label_style":{"align":"center"}},{"field":"injury_details","label":"Injury Details\n(Insured/Driver/ TP)","label_style":{"align":"center"}},{"field":"eye_witness","label":"Eye witness","label_style":{"align":"center"}},{"heading":"Garage Visit"},{"field":"garage_visit","label":"Garage Visit"},{"field":"garage_name","label":"Garage Name"},{"field":"damage_correlation","label":"Co-relating the damages on vehicle with the description of accident provided by driver in the claim form and the statement"},{"field":"traces_inspection","label":"Inspection of vehicle to find traces of blood/ hair/any other body parts"},{"field":"odometer_service","label":"Odometer reading and service history of vehicle"},{"field":"gate_pass","label":"Date and time of gate pass entry"},{"field":"towing","label":"Towing vendor details (towed from ______ to ____ by whom date and time)"},{"field":"job_card","label":"Job card date and details"},{"field":"garage_delay_status","label":"Vehicle status if the difference between garage entry and date of loss is more than 24 hrs."},{"heading":"Damaged IV images","when":{"photos":"garage"}}]},{"type":"photos","section":"garage","columns":2,"max_height_mm":105,"gap_mm":2,"captions":false,"when":{"photos":"garage"}},{"type":"table","columns":[40,60],"style":"grid","rows":[{"field":"insured_visit","label":"Insured visit"},{"field":"fastag","label":"Fast Tag Details"},{"cells":["Vehicle information (make model/Reg no./purchase details)","Make and model: {{field.make_model}}\nRegistration no.: {{field.vehicle_no}}\nPurchase details: {{field.purchase_invoice}}"]},{"cells":["Date and time of loss","{{field.date_of_loss}} {{field.time_of_accident}}"]},{"field":"travel_from_to","label":"Travelling from where to where"},{"field":"purpose_of_travel","label":"Purpose of travel"},{"field":"accident_version","label":"Accident version-- exact loss location details"},{"field":"rehabilitation","label":"How Insured/driver rehabilitee from loss location to by? (if towed then needs towing details)"},{"field":"tp_vehicle","label":"TP vehicle details"},{"field":"first_contact","label":"After accident first contact details"},{"field":"police_clarification","label":"Police intimation details (clarification for delay in intimating FIR)"},{"field":"bluetooth_photos","label":"Photos to be exchanged via Bluetooth or snapshot of insured mobile"},{"field":"discrepancy_observed","label":"Discrepancy observed","value_style":{"bold":true,"align":"justify"}},{"heading":"Observation and Conclusion"},{"cells":[{"text":"Case Summary and observation","valign":"middle"},{"blocks":[{"type":"heading","text":"Case Summary","level":3},{"type":"paragraph","text":"{{field.case_summary}}","style":"justify","markup":true},{"type":"heading","text":"Observation","level":3},{"type":"list","field":"observations","split":"auto","ordered":false,"style":"justify","indent_mm":8}]}]},{"heading":"Final Conclusion","style":{"underline":true}},{"cells":[{"text":"{{field.final_conclusion}}","colspan":2,"style":"justify","markup":true}]},{"cells":[{"text":"Investigation Status","style":"bold","valign":"middle"},{"text":"{{field.investigation_status}}","style":"justify"}]},{"field":"repudiate_ground","label":"Repudiate Ground","label_style":"bold"},{"cells":[{"text":"Investigation Agency Name","style":"bold"},"Toyam Investigation and Valuation Pvt Ltd"]},{"field":"submission_date","label":"Report Submission Date","label_style":"bold"},{"cells":[{"text":"Seal and Stamp","style":"bold","valign":"middle"},{"blocks":[{"type":"image","asset":"seal","max_height_mm":22}]}],"height_mm":25}]},{"type":"spacer","height_mm":6},{"type":"paragraph","text":"Yours Truly\nFor Toyam Investigation Agency","style":{"space_after_pt":12}},{"type":"spacer","height_mm":4},{"type":"paragraph","text":"Authorized Signatory"}]},"intake_rules":{"sender_domains":["icicilombard.com"],"subject_pattern":"^(?:(?:re|fw|fwd):\\s*)*OD Investigation Case No\\s*-\\s*(MOT\\d+)\\s*//\\s*([A-Z0-9]+)\\s*//\\s*(.+?)\\s*(#.*#)?$","subject_groups":{"insurer_claim_no":1,"vehicle_no":2,"insured_name":3},"table_parser":"label_value_two_column","investigation_points":{"starts_after":"verify the authenticity of the claim","until":"Intimation Sheet"},"attachments_as_evidence":true},"report_email":{"reply_on_thread":true,"cc_from_original":true,"subject":"Re: {{original_subject}}","attachment_name":"IR_{{insurer_claim_no}}"},"checklists":[{"name":"Motor OD — garage and spot visit","default":true}],"sections":[{"key":"case_reference","title":"Investigator and claim reference","fields":[{"key":"firm_case_ref","label":"Case ref. no (investigator)","help":"Firm format, e.g. TIVPL_ILGIC_10/2026"},{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true,"extract":{"labels":["Claim Ref. No."]}},{"key":"insurer_internal_claim_no","label":"Insurer claim number","source":"intake","extract":{"labels":["Claim No."]}},{"key":"interaction_no","label":"Interaction no."},{"key":"policy_no","label":"Policy no.","source":"intake","required":true,"extract":{"labels":["Policy No."]}},{"key":"date_of_loss","label":"Date of loss","type":"date","source":"intake","extract":{"labels":["Date of Loss"]}},{"key":"time_of_accident","label":"Time of accident","source":"intake","extract":{"labels":["Time of Loss"]}},{"key":"national_holiday","label":"Accident on a national holiday (name)","help":"No / holiday name"},{"key":"intimation_date","label":"Date of claim intimated to call centre","type":"date","source":"intake","extract":{"labels":["Intimation Date"]}},{"key":"late_intimation_reason","label":"Reason for late intimation (>10 days)","type":"long_text"},{"key":"investigation_points","label":"Red flags / points to address","type":"long_text","source":"intake"}]},{"key":"insured","title":"Insured details","categories":["id_document","insured_photo"],"fields":[{"key":"insured_name","label":"Name of insured","source":"intake","required":true,"extract":{"labels":["Name of Insured"]}},{"key":"insured_registration_no","label":"Registration no (GST / firm)"},{"key":"insured_profession","label":"Insured profession"},{"key":"insured_actual_address","label":"Address — actual, not as per policy","type":"long_text","source":"intake","extract":{"labels":["Address","City/Dist","State","Pin"],"within":"Insured Details"}},{"key":"negative_area","label":"Address pertains to negative area","type":"choice","options":["Yes","No"]},{"key":"contact_person","label":"Contact person and number","source":"intake","extract":{"labels":["Registered Mobile No","Contact No -1"],"within":"Insured Details"}}]},{"key":"vehicle","title":"Vehicle and policy details","categories":["rc_document","vehicle_invoice","policy_document","loan_document"],"fields":[{"key":"vehicle_no","label":"Vehicle registration no.","source":"intake","extract":{"labels":["Vehicle Reg. No"]}},{"key":"purchase_invoice","label":"New vehicle invoice details"},{"key":"make_model","label":"Make and model","source":"intake","extract":{"labels":["Make of Vehicle","Model of Vehicle"]}},{"key":"registration_date","label":"Registration date","type":"date"},{"key":"hypothecation","label":"Hypothecation details"},{"key":"repayment","label":"Repayment details till date"},{"key":"tp_vehicle","label":"TP vehicle details"},{"key":"policy_period","label":"Policy period","source":"intake","extract":{"labels":["Period from","Period to"]}},{"key":"policy_type","label":"Policy type"},{"key":"agent_dealer","label":"Name of agent / dealer","source":"intake","extract":{"labels":["Agent Name"]}},{"key":"previous_insurer","label":"Previous insurer (if rollover)"},{"key":"previous_policy_no","label":"Previous policy no."},{"key":"previous_claim","label":"Any claim in previous policy"},{"key":"break_in","label":"Break-in details (date, odometer, discrepancy)","type":"long_text","help":"Printed in one merged cell beside the five break-in rows of the report"}]},{"key":"driver","title":"Driver details","categories":["dl_document"],"fields":[{"key":"driver_name","label":"Driver name","source":"intake","extract":{"labels":["Name"],"within":"Driver Details"}},{"key":"dl_number","label":"DL no."},{"key":"dl_classes","label":"DL details / endorsements"},{"key":"dl_rto","label":"Licensing RTO"},{"key":"dl_observation","label":"Observation"},{"key":"driver_injured","label":"Driver injured or not"},{"key":"neighbour_enquiry","label":"Enquiry from neighbours for accident confirmation","type":"long_text"},{"key":"driver_relationship","label":"Driver relationship"},{"key":"injuries_deaths","label":"Injuries / deaths in the accident"},{"key":"nearby_police_hospital","label":"Nearest police station and hospitals checked","type":"long_text"},{"key":"discreet_enquiry","label":"Discreet enquiry with driver at place of loss","type":"long_text"},{"key":"bluetooth_photos","label":"Photos exchanged via Bluetooth / snapshot of insured mobile"}]},{"key":"statement","title":"Written statement","categories":["written_statement","avr_recording"],"fields":[{"key":"written_statement","label":"Written statement of insured","type":"long_text","required":true,"help":"Blank line between paragraphs"}]},{"key":"timeline","title":"GPS timeline","categories":["location_timeline"],"fields":[{"key":"gps_timeline","label":"GPS timeline of insured / driver","type":"long_text"}]},{"key":"police","title":"Police intimation details","categories":["fir_police_document"],"fields":[{"key":"fir_no","label":"FIR no."},{"key":"fir_details","label":"FIR details","type":"long_text"},{"key":"panchanama","label":"Panchanama details"},{"key":"injury_details","label":"Injury details (insured / driver / TP)"},{"key":"eye_witness","label":"Eye witness"}]},{"key":"garage","title":"Garage visit","categories":["vehicle_photo","odometer_photo","chassis_engine_photo","job_card","estimate","towing_bill"],"fields":[{"key":"garage_visit","label":"Garage visit","type":"choice","options":["Yes","No"]},{"key":"garage_name","label":"Garage name","source":"intake","extract":{"labels":["Name of Garage"],"within":"Garage Details"}},{"key":"damage_correlation","label":"Damages correlate with accident description","type":"choice","options":["Yes","No","Partly"]},{"key":"traces_inspection","label":"Traces of blood / hair / other on vehicle"},{"key":"odometer_service","label":"Odometer reading and service history"},{"key":"gate_pass","label":"Date and time of gate pass entry"},{"key":"towing","label":"Towing vendor details","type":"long_text"},{"key":"job_card","label":"Job card date and details"},{"key":"garage_delay_status","label":"Vehicle status if garage entry > 24 hrs after loss"}]},{"key":"insured_visit","title":"Insured visit","categories":["insured_photo","cctv_footage"],"fields":[{"key":"insured_visit","label":"Insured visit","type":"choice","options":["Yes","No"]},{"key":"fastag","label":"FASTag details"},{"key":"travel_from_to","label":"Travelling from where to where"},{"key":"purpose_of_travel","label":"Purpose of travel"},{"key":"accident_version","label":"Accident version — exact loss location","type":"long_text"},{"key":"rehabilitation","label":"How insured / driver left the loss location (towing)","type":"long_text"},{"key":"first_contact","label":"After accident first contact details"},{"key":"police_clarification","label":"Police intimation clarification"},{"key":"discrepancy_observed","label":"Discrepancy observed","type":"long_text","help":"Printed in bold; blank line between paragraphs"}]},{"key":"summary","title":"Case summary and observations","categories":["echallan_check","location_timeline","cctv_footage"],"fields":[{"key":"case_summary","label":"Case summary and observation","type":"long_text","required":true},{"key":"observations","label":"Observations (bullets)","type":"long_text","required":true,"help":"One observation per line (or numbered); printed as bullets"}]},{"key":"conclusion","title":"Final conclusion","fields":[{"key":"final_conclusion","label":"Final conclusion","type":"long_text","required":true},{"key":"investigation_status","label":"Investigation status","type":"long_text","required":true},{"key":"repudiate_ground","label":"Repudiate ground"},{"key":"submission_date","label":"Report submission date","type":"date"}]}]}$tpl$::jsonb, 'config/templates/icl-motor-od.yaml', true);
select public.load_case_template($tpl${"insurer_code":"IGI","claim_type":"motor","variant":"od","name":"IndusInd (Reliance) — Motor OD investigation","requires_approval":true,"output_formats":["pdf","docx"],"default_output_format":"pdf","docx_template_path":"report-templates/igi-motor-od.docx","report_layout":{"version":1,"name":"OD Investigation Report","page":{"size":"A4","margin_mm":{"top":39,"right":13,"bottom":20,"left":14},"header_mm":3,"footer_mm":6},"font":{"family":"Calibri","fallback":"Carlito, Calibri, Arial, sans-serif","size_pt":10,"color":"#000000","line_height":1.15},"paragraph_spacing_pt":8,"date_format":"dd.MM.yyyy","datetime_format":"dd.MM.yyyy hh:mm a","empty_value":"NA","styles":{"justify":{"align":"justify"},"bold":{"bold":true},"title":{"bold":true,"align":"center","space_after_pt":4},"label":{"bold":true,"color":"#1D3C74","background":"#D2EAF1"},"label_italic":{"use":"label","italic":true},"label_lavender":{"bold":true,"color":"#403151","background":"#DFD8E8"},"label_center":{"use":"label","align":"center"},"brand_orange":{"font":"Arial","size_pt":22,"bold":true,"color":"#E36C0A"},"brand_rest":{"font":"Arial","size_pt":12,"bold":true,"color":"#000000"},"reg_line":{"size_pt":8,"bold":true,"underline":true},"foot":{"size_pt":10,"align":"center"},"center":{"align":"center"},"heading3":{"size_pt":10,"bold":true,"align":"center","space_before_pt":0,"space_after_pt":3},"right":{"align":"right"}},"table_styles":{"blue":{"border":{"width_pt":0.5,"color":"#2F5597"},"padding_x_mm":1.2,"padding_y_mm":0.5,"label_style":"label","heading_style":{"bold":true,"align":"center"},"space_after_pt":14},"lavender":{"use":"blue","label_style":"label_lavender","border":{"width_pt":0.5,"color":"#7030A0"}},"plain":{"border":"none","padding_x_mm":0,"padding_y_mm":0,"space_after_pt":0}},"assets":{"band_top":{"runtime":true,"description":"Orange band across the top edge (firm letterhead)"},"logo":{"runtime":true,"description":"Firm logo (firm letterhead)"},"seal":{"runtime":true,"description":"Seal and signature of the authorised signatory"}},"header":[{"type":"image","asset":"band_top","width_mm":183,"height_mm":7,"align":"center"},{"type":"paragraph","text":"Reg.No.U74999JH2018PTC010897","style":"reg_line"},{"type":"table","columns":[14,86],"style":"plain","rows":[{"cells":[{"blocks":[{"type":"image","asset":"logo","width_mm":30,"height_mm":13}]},{"runs":[{"text":"TOYAM ","style":"brand_orange"},{"text":"INVESTIGATION AND VALUATION PVT. LTD","style":"brand_rest"}],"valign":"middle"}]}]}],"footer":[{"type":"paragraph","text":"{{page}}","style":"foot"}],"body":[{"type":"paragraph","text":"OD Investigation Report","style":"title"},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Insured Details"},{"field":"insured_name","label":"Insured Name"},{"field":"insurer_claim_no","label":"Claim No"},{"field":"policy_no","label":"Policy Number"},{"field":"present_address","label":"Present Address"},{"field":"permanent_address","label":"Permanent address"},{"field":"policy_address","label":"Policy address"},{"field":"insured_mobile","label":"Insured Contact Number"},{"field":"insured_email","label":"Insured Email ID"},{"field":"vehicle_no","label":"Vehicle Number"},{"field":"vehicle_class","label":"Vehicle Type"},{"cells":[{"text":"RCU Trigger","style":"label"},{"blocks":[{"type":"list","field":"investigation_points","split":"auto","ordered":true,"indent_mm":9,"empty_text":"NA"}]}]}]},{"type":"table","columns":[33,33,34],"style":"blue","rows":[{"cells":[{"text":"Loss date and time","style":"label_italic"},{"text":"Intimation to IGICL date Time","style":"label_italic"},{"text":"Delay in intimation days","style":"label_italic"}]},{"cells":["{{field.loss_datetime|date:\"dd.MM.yyyy 'at around' hh:mm a\"}}","{{field.intimation_datetime|date:\"dd.MM.yyyy 'at' hh:mm a\"}}","{{field.intimation_delay_days|suffix:\" days\"}}"]},{"field":"delay_reason","label":"Reason for Delay in intimation"},{"field":"policy_no","label":"Policy no."},{"field":"policy_type","label":"Policy Type"},{"field":"policy_period","label":"Policy period"},{"field":"within_policy_period","label":"Is the accident within policy period"},{"field":"rollover_policy_no","label":"If rollover, then Policy Number"},{"field":"previous_year_claim","label":"Any claim lodged in previous year over policy’s"},{"field":"close_proximity","label":"Claim is in close proximity"}]},{"type":"table","columns":[33,33,34],"style":"blue","rows":[{"heading":"Basic Details"},{"cells":[{"text":"Loss date and time as per claim form","style":"label_italic"},{"text":"Loss date and time as per intimation / Written statement","style":"label_italic"},{"text":"Loss date and time as per FIR / GD","style":"label_italic"}]},{"cells":["{{field.loss_dt_claim_form}}","{{field.loss_dt_statement}}","{{field.loss_dt_fir}}"]},{"field":"mismatch_reason","label":"If Mismatching, then reason"},{"field":"brief_remarks","label":"Brief Remarks of the Accident:","value_style":"justify"}]},{"type":"table","columns":[33,33,34],"style":"blue","rows":[{"heading":"Accident Details"},{"cells":[{"text":"Loss Type Desc","style":"label"},{"text":"Vehicle Burnt","style":"label"},{"text":"Origin of Fire","style":"label"}]},{"cells":["{{field.loss_type}}","{{field.vehicle_burnt}}","{{field.origin_of_fire}}"]},{"cells":[{"text":"No of Vehicle Involved","style":"label"},{"text":"No of Occupants","style":"label"},{"text":"Relation Desc","style":"label"}]},{"cells":["{{field.vehicles_involved}}","{{field.occupants}}","{{field.occupant_relation}}"]},{"cells":[{"text":"Is Insured Travelling?","style":"label"},{"text":"Purpose of Travel","style":"label"},{"text":"Is Any TP Accident Involved","style":"label"}]},{"cells":["{{field.insured_travelling}}","{{field.purpose_of_travel}}","{{field.tp_involved}}"]},{"cells":[{"text":"Travelling from Date","style":"label"},{"text":"Travelling to Date","style":"label"},{"text":"Is anyone travelling in vehicle Injured/Dead","style":"label"}]},{"cells":["{{field.travel_from_date|date:\"dd-MM-yyyy\"}}","{{field.travel_to_date|date:\"dd-MM-yyyy\"}}","{{field.anyone_injured}}"]},{"cells":[{"text":"Travelling from Location","style":"label"},{"text":"Travelling to Location","style":"label"},{"text":"If Possession other than self","style":"label"}]},{"cells":["{{field.travel_from_location}}","{{field.travel_to_location}}","{{field.possession_other}}"]},{"field":"cause_of_loss_intimated","label":"Cause of loss as intimated","value_style":"justify","when":{"field":"cause_of_loss_intimated"}}]},{"type":"table","columns":[27,73],"style":"blue","when":{"field":"fir_no_date"},"rows":[{"heading":"FIR / GD Details"},{"field":"fir_no_date","label":"FIR / GD date and No"},{"field":"fir_delay","label":"Any Delay in FIR / GD and reason"},{"field":"police_station","label":"Police Station Name and address"},{"field":"io_details","label":"Investigation office Name and contact number of IO"},{"field":"fir_narration","label":"Brief FIR / GD Narration","value_style":"justify"}]},{"type":"table","columns":[27,73],"style":"blue","when":{"field":"fir_no_date","filled":false},"rows":[{"heading":"FIR / GD Details"},{"cells":["Accident Date",{"text":"{{field.fir_narration}}","rowspan":11,"valign":"middle"}]},{"cells":["FIR / GD date and No"]},{"cells":["Any Delay in FIR / GD"]},{"cells":["Reason for delay"]},{"cells":["Accused Name"]},{"cells":["Complainant"]},{"cells":["Police Station Name"]},{"cells":["Address of Police station with Pin code"]},{"cells":["Investigation office Name"]},{"cells":["Contact number of IO"]},{"cells":["Brief FIR / GD Narration"]}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Driver Details"},{"field":"driver_name","label":"Driver Name"},{"field":"driver_dob","label":"Driver DOB as per DL"},{"field":"driver_address","label":"Driver Resident Address"},{"field":"driver_contact","label":"Driver contact number"},{"field":"driver_relation","label":"Relation with the Insured"},{"field":"dl_number","label":"DL Number of the Driver"},{"field":"dl_authority","label":"DL Issuing Authority"},{"field":"dl_type","label":"Type of License"},{"field":"dl_classes","label":"Which vehicle authorized to Drive"},{"field":"dl_validity","label":"License Validity Date"},{"field":"dl_valid_at_loss","label":"At the time of Accident License was valid"},{"field":"driver_remarks","label":"Any Other Remarks regarding the Driver"}]},{"type":"table","columns":[100],"style":"blue","when":{"photos":"driver"},"rows":[{"heading":"DL Extract of Driver"},{"cells":[{"blocks":[{"type":"photos","section":"driver","columns":1,"max_height_mm":120,"captions":false}]}]}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Garage Details"},{"field":"garage_name","label":"Garage Name"},{"field":"garage_address","label":"Garage Address"},{"field":"garage_contact","label":"Garage Contact Number"},{"field":"garage_entry","label":"Vehicle Entry Date and Time"},{"field":"job_card_no","label":"Job Card Number"},{"field":"odometer_at_entry","label":"ODO meter reading at the time of entry"},{"field":"loss_to_entry_gap","label":"The Difference between loss date and garage entry date"},{"field":"garage_gap_reason","label":"Reason"},{"field":"not_reported_reason","label":"If not reported to any garage till date, please mention the reason."}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Vehicle Registration Details"},{"field":"reg_number","label":"Registration Number"},{"field":"reg_date","label":"Registration Date"},{"field":"reg_rto","label":"Registration RTO"},{"field":"vehicle_class","label":"Vehicle Type"},{"field":"vehicle_make","label":"Vehicle Make"},{"field":"vehicle_model","label":"Vehicle Model"},{"field":"fuel_type","label":"Fuel Type"},{"field":"seating_capacity","label":"Seating Capacity"},{"field":"engine_no","label":"Engine Number"},{"field":"chassis_no","label":"Chassis Number"},{"field":"modifications","label":"Any Modifications in Vehicle"},{"field":"hypothecation","label":"Any Other observation during Investigation","value_style":"justify"}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"If Vehicle Commercial"},{"cells":["Vehicle Loaded",{"text":"{{field.commercial_details}}","rowspan":13,"valign":"middle","style":"center"}]},{"cells":["Invoice Date"]},{"cells":["GCV Details"]},{"cells":["PCV Details"]},{"cells":["Permit Available"]},{"cells":["Permit Valid Till"]},{"cells":["Fitness Certificate Available"]},{"cells":["Fitness Certificate Valid Till"]},{"cells":["Vehicle loaded- LR/Bilty details"]},{"cells":["Nature of consignment"]},{"cells":["Transporter Details"]},{"cells":["Transporter Verification details"]},{"cells":["Any Other observation during Investigation"]}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Spot Verification"},{"field":"spot_matches","label":"Intimation / Claim form spot location matching??"},{"field":"actual_spot","label":"If No kindly provide the proper Loss location details."},{"field":"spot_witness","label":"Spot Witness Name _1"},{"field":"spot_details","label":"Any Other details regarding the Spot","value_style":"justify"}]},{"type":"table","columns":[100],"style":"blue","when":{"photos":"spot"},"rows":[{"keep_together":true,"cells":[{"blocks":[{"type":"heading","text":"SPOT PHOTOS","level":3},{"type":"photos","section":"spot","columns":2,"max_height_mm":58,"gap_mm":0,"captions":false,"border":{"width_pt":0.5,"color":"#2F5597"}}]}]}]},{"type":"page_break","when":{"photos":"garage"}},{"type":"table","columns":[100],"style":"blue","when":{"photos":"garage"},"rows":[{"keep_together":true,"cells":[{"blocks":[{"type":"heading","text":"VEHICLE PHOTOS","level":3},{"type":"photos","section":"garage","columns":2,"max_height_mm":58,"gap_mm":0,"captions":false,"border":{"width_pt":0.5,"color":"#2F5597"}}]}]}]},{"type":"page_break","when":{"photos":"garage"}},{"type":"table","columns":[27,73],"style":"lavender","rows":[{"heading":"Injured Details"},{"cells":["Name",{"text":"{{field.injured_details}}","rowspan":9,"valign":"middle","style":"center"}]},{"cells":["Age"]},{"cells":["Marital Status"]},{"cells":["Occupation"]},{"cells":["Nature of Injury"]},{"cells":["Treatment Detail"]},{"cells":["Hospitalization Date / Time"]},{"cells":["Hospital Name"]},{"cells":["Discharge Date / Time"]},{"field":"injury_observation","label":"Any observation during investigation.","value_style":"justify"}]},{"type":"table","columns":[30,70],"style":"blue","rows":[{"heading":"Written Statement Collect"},{"cells":[{"text":"Name and Relation with the insured","style":"label"},{"text":"Statement Version","style":"label_center"}]},{"repeat":{"field":"statements","split":"sections"},"cells":[{"text":"{{item|first_line}}","style":"bold"},{"text":"{{item|rest_lines}}","style":"justify"}],"empty":[{"text":"NA","colspan":2}]}]},{"type":"table","columns":[100],"style":"blue","rows":[{"heading":"Observation / Findings During investigation"},{"cells":[{"blocks":[{"type":"list","field":"findings","split":"auto","ordered":true,"indent_mm":9,"style":"justify","empty_text":"NA"}]}]}]},{"type":"table","columns":[10,90],"style":"blue","rows":[{"heading":"Documents Collection"},{"cells":[{"text":"Sr. no.","style":"label"},{"text":"Documents Name","style":"label"}]},{"repeat":{"field":"documents_collected","split":"auto"},"cells":[{"text":"{{index}}.","style":"right"},"{{item}}"],"empty":[{"text":"NA","colspan":2}]}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"heading":"Reminder Letter / Document Deficiency Letter"},{"cells":[{"text":"1st Letter Date","style":"label"},"{{field.reminder_1_date}}"],"height_mm":9},{"cells":[{"text":"2nd Letter Date","style":"label"},"{{field.reminder_2_date}}"],"height_mm":9},{"cells":[{"text":"Document Deficiency List","style":"label"},"{{field.deficiency_list}}"],"height_mm":9}]},{"type":"table","columns":[100],"style":"blue","rows":[{"heading":"Conclusion"},{"cells":[{"text":"{{field.conclusion}}","style":"justify","markup":true}]}]},{"type":"table","columns":[27,73],"style":"blue","rows":[{"field":"investigation_status","label":"Investigation Status"},{"field":"repudiate_ground","label":"Repudiate Ground","value_style":"bold"},{"cells":[{"text":"Investigation Agency Name","style":"label"},"Toyam Investigation and Valuation Pvt. Ltd"]},{"field":"submission_date","label":"Report Submission Date"},{"cells":[{"text":"Seal and Stamp","style":"label"},{"blocks":[{"type":"image","asset":"seal","max_height_mm":28}]}],"height_mm":32}]},{"type":"paragraph","text":"The report is being issued strictly without Prejudice, Strictly Confidential and Strictly for the purpose of Insurance Company’s claim settlement purpose only.","style":"justify"},{"type":"paragraph","text":"Our bill for the services rendered is being enclosed herewith for your early clearance.","style":"justify"},{"type":"paragraph","text":"Thanking you"},{"type":"table","columns":[50,50],"style":"plain","rows":[{"cells":["Yours Sincerely",{"text":"Compiled by: {{field.compiled_by}}","style":"right"}]}]}]},"intake_rules":{"sender_domains":["indusindinsurance.com"],"subject_pattern":"^(?:(?:re|fw|fwd):\\s*)*(OD|THEFT)\\s*\\|\\|\\s*(\\d{6,})\\s*\\|\\|\\s*([^|]+?)\\s*\\|\\|\\s*([A-Z]+)\\s*$","subject_groups":{"variant":1,"insurer_claim_no":2,"insured_name":3,"vehicle_class":4},"table_parser":"label_value_two_column","investigation_points":{"starts_after":"following points","until":"Claim Intimation Details"}},"report_email":{"reply_on_thread":true,"cc_from_original":true,"subject":"Re: {{original_subject}}","attachment_name":"{{insurer_claim_no}}_{{insured_name}}_IR"},"checklists":[{"name":"Motor OD — garage and spot visit","default":true}],"sections":[{"key":"insured","title":"Insured details","fields":[{"key":"insured_name","label":"Insured name","source":"intake","required":true,"extract":{"labels":["Insured Name"]}},{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true,"extract":{"labels":["Claim Number"]}},{"key":"policy_no","label":"Policy number","source":"intake","required":true,"extract":{"labels":["Policy Number"]}},{"key":"present_address","label":"Present address","type":"long_text"},{"key":"permanent_address","label":"Permanent address","type":"long_text"},{"key":"policy_address","label":"Policy address","type":"long_text","source":"intake","extract":{"labels":["Address Line 1","Address Line 2","City","State","PinCode"],"within":"Insured Details"}},{"key":"insured_mobile","label":"Insured contact number","source":"intake","extract":{"labels":["Mobile Number"],"within":"Insured Details"}},{"key":"insured_email","label":"Insured email ID","source":"intake","extract":{"labels":["Email Id"],"within":"Insured Details"}},{"key":"vehicle_no","label":"Vehicle number","source":"intake","extract":{"labels":["Vehicle Number"]}},{"key":"vehicle_class","label":"Vehicle type","source":"intake","help":"From the subject, e.g. TWL"},{"key":"investigation_points","label":"RCU trigger (points to address)","type":"long_text","source":"intake","help":"Numbered points, one per line; printed as a numbered list"}]},{"key":"loss_and_policy","title":"Loss, intimation and policy","fields":[{"key":"loss_datetime","label":"Loss date and time","type":"datetime","source":"intake","extract":{"labels":["Date Of Loss","Time of Loss"]}},{"key":"intimation_datetime","label":"Intimation to insurer date and time","type":"datetime","source":"intake","extract":{"labels":["Intimation Date","Intimation Time"]}},{"key":"intimation_delay_days","label":"Delay in intimation (days)","type":"number","help":"Computed from the two dates; confirm"},{"key":"delay_reason","label":"Reason for delay in intimation","type":"long_text","source":"intake","extract":{"labels":["Reason For Delay in Intimation"]}},{"key":"policy_type","label":"Policy type","source":"intake","extract":{"labels":["Product"]}},{"key":"policy_period","label":"Policy period","source":"intake","extract":{"labels":["Start Date","End Date"]}},{"key":"within_policy_period","label":"Is the accident within policy period","type":"choice","options":["Yes","No"]},{"key":"rollover_policy_no","label":"If rollover, policy number"},{"key":"previous_year_claim","label":"Any claim lodged in previous year","type":"choice","options":["Yes","No","Not known"]},{"key":"close_proximity","label":"Claim in close proximity","type":"choice","options":["Yes","No"]}]},{"key":"basic_details","title":"Basic details","fields":[{"key":"loss_dt_claim_form","label":"Loss date/time as per claim form"},{"key":"loss_dt_statement","label":"Loss date/time as per intimation / written statement"},{"key":"loss_dt_fir","label":"Loss date/time as per FIR / GD"},{"key":"mismatch_reason","label":"If mismatching, reason","type":"long_text"},{"key":"brief_remarks","label":"Brief remarks of the accident","type":"long_text","required":true}]},{"key":"accident","title":"Accident details","categories":["cctv_footage","location_timeline"],"fields":[{"key":"loss_type","label":"Loss type","source":"intake","extract":{"labels":["Primary Type Of Loss"]}},{"key":"vehicle_burnt","label":"Vehicle burnt","type":"choice","options":["Yes","No"]},{"key":"origin_of_fire","label":"Origin of fire"},{"key":"vehicles_involved","label":"No. of vehicles involved","type":"number"},{"key":"occupants","label":"No. of occupants","type":"number"},{"key":"occupant_relation","label":"Relation of occupant/driver with insured"},{"key":"insured_travelling","label":"Is insured travelling","type":"choice","options":["Yes","No"]},{"key":"purpose_of_travel","label":"Purpose of travel"},{"key":"tp_involved","label":"Any TP accident involved","type":"choice","options":["Yes","No"]},{"key":"travel_from_date","label":"Travelling from date","type":"date"},{"key":"travel_to_date","label":"Travelling to date","type":"date"},{"key":"travel_from_location","label":"Travelling from location"},{"key":"travel_to_location","label":"Travelling to location"},{"key":"possession_other","label":"If possession other than self"},{"key":"anyone_injured","label":"Anyone travelling injured / dead","type":"choice","options":["Yes","No"]},{"key":"cause_of_loss_intimated","label":"Cause of loss as intimated","type":"long_text","source":"intake","extract":{"labels":["Cause/Description Of Loss"]}}]},{"key":"fir","title":"FIR / GD details","categories":["fir_police_document"],"fields":[{"key":"fir_no_date","label":"FIR / GD date and number"},{"key":"fir_delay","label":"Any delay in FIR / GD and reason","type":"long_text"},{"key":"police_station","label":"Police station name and address"},{"key":"io_details","label":"Investigating officer and contact"},{"key":"fir_narration","label":"Brief FIR / GD narration","type":"long_text"}]},{"key":"driver","title":"Driver details","categories":["dl_document"],"fields":[{"key":"driver_name","label":"Driver name","source":"intake","extract":{"labels":["Name"],"within":"Driver Details"}},{"key":"driver_dob","label":"Driver DOB as per DL","type":"date"},{"key":"driver_address","label":"Driver resident address","type":"long_text"},{"key":"driver_contact","label":"Driver contact number"},{"key":"driver_relation","label":"Relation with the insured"},{"key":"dl_number","label":"DL number of the driver","help":"Copy from the DL extract (tap-to-fill)"},{"key":"dl_authority","label":"DL issuing authority"},{"key":"dl_type","label":"Type of licence","type":"choice","options":["Permanent","Learner"]},{"key":"dl_classes","label":"Vehicle classes authorised"},{"key":"dl_validity","label":"Licence validity"},{"key":"dl_valid_at_loss","label":"Licence valid at time of accident","type":"choice","options":["Yes","No"]},{"key":"driver_remarks","label":"Other remarks regarding the driver","type":"long_text"}]},{"key":"garage","title":"Garage details","categories":["job_card","estimate","vehicle_photo","odometer_photo","towing_bill"],"fields":[{"key":"garage_name","label":"Garage name","source":"intake","extract":{"labels":["Garage Name"],"within":"Garage Details"}},{"key":"garage_address","label":"Garage address","source":"intake","extract":{"labels":["Garage Address","Garage City","Garage PinCode"],"within":"Garage Details"}},{"key":"garage_contact","label":"Garage contact number"},{"key":"garage_entry","label":"Vehicle entry date and time"},{"key":"job_card_no","label":"Job card number"},{"key":"odometer_at_entry","label":"Odometer reading at entry"},{"key":"loss_to_entry_gap","label":"Difference between loss date and garage entry"},{"key":"garage_gap_reason","label":"Reason","type":"long_text"},{"key":"not_reported_reason","label":"If not reported to any garage till date, reason","type":"long_text"}]},{"key":"registration","title":"Vehicle registration details","categories":["rc_document","chassis_engine_photo"],"fields":[{"key":"reg_number","label":"Registration number"},{"key":"reg_date","label":"Registration date","type":"date"},{"key":"reg_rto","label":"Registration RTO"},{"key":"vehicle_make","label":"Vehicle make","source":"intake","extract":{"labels":["Make"]}},{"key":"vehicle_model","label":"Vehicle model","source":"intake","extract":{"labels":["Model"]}},{"key":"fuel_type","label":"Fuel type"},{"key":"seating_capacity","label":"Seating capacity","type":"number"},{"key":"engine_no","label":"Engine number"},{"key":"chassis_no","label":"Chassis number"},{"key":"modifications","label":"Any modifications in vehicle","type":"choice","options":["Yes","No"]},{"key":"hypothecation","label":"Hypothecation / other observation","type":"long_text"}]},{"key":"commercial","title":"If vehicle commercial","guidance":"Leave as \"Not applicable\" for private vehicles.","fields":[{"key":"commercial_details","label":"Load, permit, fitness and transporter details","type":"long_text","help":"Printed in one merged cell beside the 13 commercial-vehicle rows of the report"}]},{"key":"spot","title":"Spot verification","categories":["spot_photo"],"fields":[{"key":"spot_matches","label":"Intimation / claim form spot matching","type":"choice","options":["Yes","No"]},{"key":"actual_spot","label":"If no, proper loss location"},{"key":"spot_witness","label":"Spot witness name(s)"},{"key":"spot_details","label":"Other details regarding the spot","type":"long_text"}]},{"key":"injured","title":"Injured details","categories":["medical_document"],"fields":[{"key":"injured_details","label":"Name, age, occupation, nature of injury, treatment and hospital","type":"long_text","help":"Printed in one merged cell beside the nine injured-person rows of the report"},{"key":"injury_observation","label":"Observation during investigation","type":"long_text"}]},{"key":"statements","title":"Written statements","categories":["written_statement","avr_recording","insured_photo","id_document"],"fields":[{"key":"statements","label":"Statements (name, relation, version)","type":"long_text","required":true,"help":"One statement per block, blocks separated by a line with --- ; the first line of a block is the name and relation (e.g. Mr. X (Rider's Statement)), the rest is the statement"}]},{"key":"findings","title":"Observations / findings","categories":["echallan_check","location_timeline"],"fields":[{"key":"findings","label":"Observations and findings (numbered)","type":"long_text","required":true,"help":"Start each finding with 1. 2. 3. ; lines that follow belong to the same finding; blank line for a new paragraph inside it"},{"key":"documents_collected","label":"Documents collected","type":"long_text","help":"One document per line (or numbered); blank lines are ignored"}]},{"key":"reminders","title":"Reminder letter / document deficiency letter","categories":["reminder_letter","proof_of_dispatch"],"fields":[{"key":"reminder_1_date","label":"1st letter date","type":"date"},{"key":"reminder_2_date","label":"2nd letter date","type":"date"},{"key":"deficiency_list","label":"Document deficiency list","type":"long_text"}]},{"key":"conclusion","title":"Conclusion","fields":[{"key":"conclusion","label":"Conclusion","type":"long_text","required":true},{"key":"investigation_status","label":"Investigation status","type":"choice","required":true,"options":["Recommended","Repudiate","Insurer discretion"]},{"key":"repudiate_ground","label":"Repudiate ground"},{"key":"submission_date","label":"Report submission date","type":"date"},{"key":"compiled_by","label":"Compiled by"}]}]}$tpl$::jsonb, 'config/templates/igi-motor-od.yaml', true);
-- END GENERATED TEMPLATES

-- ---------------------------------------------------------------------
-- Session helpers. They run as the database owner but act "as" a user by setting the JWT claim,
-- so the app's own functions and triggers (auth.uid(), is_staff(), is_field()) behave as in the app.
-- ---------------------------------------------------------------------
create function pg_temp.as_user(p uuid) returns void language sql as $$
    select set_config('request.jwt.claims',
                      case when p is null then '' else jsonb_build_object('sub', p, 'role', 'authenticated')::text end, false)
$$;
create function pg_temp.cid(t text) returns uuid language sql as $$ select md5('toyam-seed:' || t)::uuid $$;
create function pg_temp.sha(t text) returns text language sql as $$
    select encode(extensions.digest('toyam-seed:' || t, 'sha256'), 'hex')
$$;

-- Fill template fields by key; unknown keys fail loudly so typos cannot hide.
create function pg_temp.fvs(p_case uuid, p_values jsonb, p_source public.field_value_source default 'office',
                            p_conf real default null, p_by uuid default null) returns void language plpgsql as $$
declare r record; v_f uuid;
begin
    for r in select k.key, k.value from jsonb_each_text(p_values) k loop
        select f.id into v_f from public.case_template_fields f
          join public.cases c on c.template_id = f.template_id where c.id = p_case and f.key = r.key;
        if v_f is null then
            raise exception 'seed: field % is not in the template of case %', r.key, p_case;
        end if;
        insert into public.case_field_values (case_id, field_id, value, source, confidence, updated_by)
        values (p_case, v_f, r.value, p_source, p_conf, p_by)
        on conflict (case_id, field_id) do update
           set value = excluded.value, source = excluded.source, confidence = excluded.confidence,
               updated_by = excluded.updated_by;
    end loop;
end $$;

-- One file for post_thread_message(): paths follow cases/{case}/tasks/{task}/{sha256}.{ext}.
create function pg_temp.item(p_case uuid, p_task uuid, p_seed text, p_name text, p_type text,
                             p_cat text default null, p_source text default 'camera',
                             p_item uuid default null, p_ocr text default null) returns jsonb language sql as $$
    select jsonb_strip_nulls(jsonb_build_object(
        'evidence_type', p_type, 'capture_source', p_source,
        'storage_path', 'cases/' || p_case || '/tasks/' || p_task || '/' || pg_temp.sha(p_seed)
                        || case p_type when 'document' then '.pdf' when 'audio' then '.m4a' else '.jpg' end,
        'mime_type', case p_type when 'document' then 'application/pdf' when 'audio' then 'audio/mp4' else 'image/jpeg' end,
        'size_bytes', 600000 + (hashtext(p_seed) & 524287),
        'sha256', pg_temp.sha(p_seed), 'original_filename', p_name,
        'device_captured_at', now(),
        'latitude', case when p_type = 'photo' then 19.1197 end,
        'longitude', case when p_type = 'photo' then 72.8468 end,
        'gps_accuracy_m', case when p_type = 'photo' then 8.5 end,
        'category_code', p_cat, 'checklist_item_id', p_item,
        'device_info', jsonb_build_object('model', 'Seed Phone', 'os', 'Android 15'),
        'ocr', case when p_ocr is not null then jsonb_build_object('text', p_ocr, 'engine', 'device', 'mean_confidence', 0.9) end))
$$;
create function pg_temp.ev(p_case uuid, p_seed text) returns uuid language sql as $$
    select e.id from public.evidence e where e.case_id = p_case and e.sha256 = pg_temp.sha(p_seed)
$$;
create function pg_temp.ci(p_task uuid, p_pos int) returns uuid language sql as $$
    select i.id from public.task_checklist_items i where i.task_id = p_task and i.position = p_pos
$$;
create function pg_temp.cat(p_code text) returns uuid language sql as $$
    select c.id from public.evidence_categories c where c.code = p_code
$$;
create function pg_temp.fld(p_case uuid, p_key text) returns uuid language sql as $$
    select f.id from public.case_template_fields f join public.cases c on c.template_id = f.template_id
     where c.id = p_case and f.key = p_key
$$;

-- A task with its checklist (direct insert so the id is fixed; the task trigger posts the thread
-- message, notifies the assignee and moves the case to field_in_progress).
create function pg_temp.mk_task(p_id uuid, p_case uuid, p_kind public.task_kind, p_title text, p_instr text,
                                p_assignee uuid, p_due timestamptz, p_loc text, p_by uuid,
                                p_parent uuid default null, p_checklist uuid default null) returns void language plpgsql as $$
begin
    perform pg_temp.as_user(p_by);
    insert into public.tasks (id, case_id, kind, parent_task_id, title, instructions, assignee_id, due_at, location_text, created_by)
    values (p_id, p_case, p_kind, p_parent, p_title, p_instr, p_assignee, p_due, p_loc, p_by);
    if p_checklist is not null then
        perform public.apply_checklist_template(p_id, p_checklist);
    end if;
end $$;

-- Insurer email with attachments; each attachment is also an evidence row (capture_source email_attachment).
create function pg_temp.mail(p_case uuid, p_n int, p_subject text, p_body text, p_files text[]) returns void language plpgsql as $$
declare v_c public.cases; v_i public.insurers; v_email uuid := pg_temp.cid('email-' || p_n); v_att uuid; f text; v_sha text; v_path text;
begin
    select * into v_c from public.cases where id = p_case;
    select * into v_i from public.insurers where id = v_c.insurer_id;
    insert into public.emails (id, gmail_message_id, gmail_thread_id, from_address, from_name, to_addresses, subject, body_text,
                               received_at, classification, status, insurer_id, case_id, template_id, processed_at, parser_version)
    values (v_email, '<seed-' || p_n || '@' || v_i.sender_domains[1] || '>', 'seed-thread-' || p_n,
            v_i.reply_to_email, 'Claims desk (sample)', '{cases@investigation.example}', p_subject, p_body,
            v_c.received_at, 'new_case', 'processed', v_c.insurer_id, p_case, v_c.template_id,
            v_c.received_at + interval '1 minute', 'seed');
    foreach f in array p_files loop
        v_sha := pg_temp.sha(p_case::text || f);
        v_path := 'emails/' || v_email || '/' || f;
        v_att := gen_random_uuid();
        insert into public.email_attachments (id, email_id, filename, mime_type, size_bytes, storage_path, sha256, is_evidence)
        values (v_att, v_email, f, case when f ~* '\.pdf$' then 'application/pdf' else 'image/jpeg' end,
                200000 + (hashtext(f) & 262143), v_path, v_sha, true);
        insert into public.evidence (case_id, evidence_type, capture_source, storage_backend, storage_path, mime_type, size_bytes,
                                     sha256, email_attachment_id, original_filename)
        values (p_case, case when f ~* '\.pdf$' then 'document' else 'photo' end::public.evidence_type, 'email_attachment', 'supabase',
                v_path, case when f ~* '\.pdf$' then 'application/pdf' else 'image/jpeg' end,
                200000 + (hashtext(f) & 262143), v_sha, v_att, f);
    end loop;
end $$;

-- ---------------------------------------------------------------------
-- Cases. Owners are set afterwards through the assignment functions, so history, thread events and
-- notifications exist. The auto-assign trigger is paused only for these inserts.
-- ---------------------------------------------------------------------
alter table public.cases disable trigger trg_cases_after_insert_assign;
insert into public.cases (id, insurer_id, insurer_claim_no, policy_no, claim_type, claim_amount, suspicion_summary,
                          incident_date, received_at, due_at, status, orchestrator_id, template_id)
select v.id, v.insurer_id, v.claim_no, v.policy_no, 'motor', v.amount, v.summary, current_date - v.inc_days,
       now() - v.age, now() + v.due_in, 'received', 'a0000000-0000-4000-8000-000000000002',
       (select t.id from public.case_templates t where t.insurer_id = v.insurer_id and t.claim_type = 'motor'
           and t.variant = 'od' and t.is_active)
from (values
    ('d0000000-0000-4000-8000-000000000101'::uuid, 'b0000000-0000-4000-8000-000000000004'::uuid, '9900000101', 'POL-SAMPLE-0101',
     96000, 'Two-wheeler own damage; reported late, no police report.',          2,  interval '3 hours',  interval '12 days'),
    ('d0000000-0000-4000-8000-000000000102', 'b0000000-0000-4000-8000-000000000005', 'LMB-SAMPLE-0102', 'LPOL-SAMPLE-0102',
     310000, 'Policy taken 9 days before the loss; garage entry two days after loss.', 6, interval '2 days',   interval '9 days'),
    ('d0000000-0000-4000-8000-000000000103', 'b0000000-0000-4000-8000-000000000004', '9900000103', 'POL-SAMPLE-0103',
     128000, 'Damage pattern does not match the stated skid on a wet road.',     13, interval '14 days',  interval '3 hours'),
    ('d0000000-0000-4000-8000-000000000104', 'b0000000-0000-4000-8000-000000000005', 'LMB-SAMPLE-0104', 'LPOL-SAMPLE-0104',
     540000, 'Repeat claim; driver not the insured; CCTV not produced.',         24, interval '20 days',  interval '-6 days'),
    ('d0000000-0000-4000-8000-000000000105', 'b0000000-0000-4000-8000-000000000004', '9900000105', 'POL-SAMPLE-0105',
     77000, 'FIR filed four days after the loss.',                               9,  interval '9 days',   interval '6 days'),
    ('d0000000-0000-4000-8000-000000000106', 'b0000000-0000-4000-8000-000000000005', 'LMB-SAMPLE-0106', 'LPOL-SAMPLE-0106',
     205000, 'Vehicle sold on paper before the loss date.',                      11, interval '10 days',  interval '2 days'),
    ('d0000000-0000-4000-8000-000000000107', 'b0000000-0000-4000-8000-000000000004', '9900000107', 'POL-SAMPLE-0107',
     164000, 'Odometer reading higher than the service history.',                20, interval '18 days',  interval '-3 days'),
    ('d0000000-0000-4000-8000-000000000108', 'b0000000-0000-4000-8000-000000000005', 'LMB-SAMPLE-0108', 'LPOL-SAMPLE-0108',
     89000, 'Minor damage claimed as total loss.',                               33, interval '30 days',  interval '-18 days')
) as v(id, insurer_id, claim_no, policy_no, amount, summary, inc_days, age, due_in);
alter table public.cases enable trigger trg_cases_after_insert_assign;

-- Insurer emails (the originals the cases were created from)
select pg_temp.mail('d0000000-0000-4000-8000-000000000101', 101, 'OD || 9900000101 || Test Insured One || TWL',
    'Please investigate the attached own damage claim. Insured: Test Insured One (sample).', '{claim_form.pdf,policy_schedule.pdf}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000102', 102, 'New case LMB-SAMPLE-0102 for investigation',
    'Kindly investigate claim LMB-SAMPLE-0102. Insured: Test Insured Two (sample).',
    '{claim_form.pdf,Front View(1).jpg,Rear View(1).jpg,DRIVING LICENSE(1).jpg}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000103', 103, 'OD || 9900000103 || Test Insured Three || TWL',
    'Please investigate the attached own damage claim. Insured: Test Insured Three (sample).', '{claim_form.pdf,policy_schedule.pdf,garage_estimate.pdf}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000104', 104, 'New case LMB-SAMPLE-0104 for investigation',
    'Kindly investigate claim LMB-SAMPLE-0104. Insured: Test Insured Four (sample).', '{claim_form.pdf,Front View(1).jpg}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000105', 105, 'OD || 9900000105 || Test Insured Five || TWL',
    'Please investigate the attached own damage claim. Insured: Test Insured Five (sample).', '{claim_form.pdf}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000106', 106, 'New case LMB-SAMPLE-0106 for investigation',
    'Kindly investigate claim LMB-SAMPLE-0106. Insured: Test Insured Six (sample).', '{claim_form.pdf,policy_schedule.pdf}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000107', 107, 'OD || 9900000107 || Test Insured Seven || TWL',
    'Please investigate the attached own damage claim. Insured: Test Insured Seven (sample).', '{claim_form.pdf,service_history.pdf}');
select pg_temp.mail('d0000000-0000-4000-8000-000000000108', 108, 'New case LMB-SAMPLE-0108 for investigation',
    'Kindly investigate claim LMB-SAMPLE-0108. Insured: Test Insured Eight (sample).', '{claim_form.pdf}');

-- Intake values filled by the template parser (email_parser) for every case
select pg_temp.fvs(c.id,
    case when i.code = 'IGI' then jsonb_build_object(
        'insured_name', 'Test Insured ' || n.n || ' (sample)', 'insurer_claim_no', c.insurer_claim_no, 'policy_no', c.policy_no,
        'vehicle_no', 'MH 00 TS 0' || n.n, 'insured_mobile', '90000001' || right(n.n, 2),
        'policy_address', 'Plot ' || n.n || ', Sample Nagar, Pune 411000',
        'investigation_points', E'1. Verify the place and time of loss.\n2. Check the garage entry date and job card.\n3. Confirm who was driving.',
        'garage_name', 'Sample Auto Works', 'garage_address', 'Sample Auto Works, Industrial Estate, Pune',
        'cause_of_loss_intimated', 'Skidded on a wet road and hit the divider.',
        'vehicle_class', 'TWL', 'policy_type', 'Comprehensive', 'policy_period', '01 Jan to 31 Dec (sample)',
        'driver_name', 'Test Driver ' || n.n || ' (sample)', 'vehicle_make', 'Demo Motors', 'vehicle_model', 'Sample 150',
        'loss_type', 'Accident', 'loss_datetime', c.incident_date::text || ' 21:30',
        'intimation_datetime', (c.incident_date + 2)::text || ' 10:15')
    else jsonb_build_object(
        'insured_name', 'Test Insured ' || n.n || ' (sample)', 'insurer_claim_no', c.insurer_claim_no, 'policy_no', c.policy_no,
        'insurer_internal_claim_no', 'INT-' || n.n, 'date_of_loss', c.incident_date::text, 'time_of_accident', '21:30',
        'intimation_date', (c.incident_date + 2)::text,
        'investigation_points', E'1. Verify the place and time of loss.\n2. Check the garage entry date and job card.\n3. Confirm who was driving.',
        'insured_actual_address', 'Plot ' || n.n || ', Sample Nagar, Pune 411000', 'contact_person', 'Test Insured ' || n.n || ' (sample)',
        'vehicle_no', 'MH 00 TS 0' || n.n, 'make_model', 'Demo Motors Sample 150', 'policy_period', '01 Jan to 31 Dec (sample)',
        'agent_dealer', 'Sample Dealer', 'driver_name', 'Test Driver ' || n.n || ' (sample)', 'garage_name', 'Sample Auto Works')
    end, 'email_parser', 0.96::real)
  from public.cases c
  join public.insurers i on i.id = c.insurer_id
  cross join lateral (select right(c.insurer_claim_no, 3) as n) n
 where c.id between 'd0000000-0000-4000-8000-000000000101' and 'd0000000-0000-4000-8000-000000000108'
 order by c.id;

-- ---------------------------------------------------------------------
-- 101  IGI  received, nobody assigned: unassigned queue and orchestrator alert
-- ---------------------------------------------------------------------
select pg_temp.as_user(null);
select private.notify_orchestrators('case_unassigned', 'd0000000-0000-4000-8000-000000000101',
    'No one available to take case ' || (select case_ref from public.cases where id = 'd0000000-0000-4000-8000-000000000101'),
    'Assign it manually or update availability / assignment rules.', 'unassigned:d0000000-0000-4000-8000-000000000101');

-- ---------------------------------------------------------------------
-- 102  ICL  assigned (auto) to Uma, no field work yet; staff-only conversation
-- ---------------------------------------------------------------------
select private.assign_case('d0000000-0000-4000-8000-000000000102', 'a0000000-0000-4000-8000-000000000003', 'auto', 'Automatic assignment');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
select public.post_staff_note('d0000000-0000-4000-8000-000000000102', pg_temp.cid('note-102-a'),
    'Policy was issued 9 days before the loss. Check the proposal form and the garage entry date first.');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select public.post_staff_note('d0000000-0000-4000-8000-000000000102', pg_temp.cid('note-102-b'),
    'Noted. I will assign the garage visit once the insurer confirms the garage address.');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000102', '{"firm_case_ref":"TIV/2026/0102"}', 'office', null,
    'a0000000-0000-4000-8000-000000000003');

-- ---------------------------------------------------------------------
-- 103  IGI  field_in_progress, due today, owner Neel; operator Fatima mid-visit
-- ---------------------------------------------------------------------
select pg_temp.as_user(null);
select private.assign_case('d0000000-0000-4000-8000-000000000103', 'a0000000-0000-4000-8000-000000000004', 'auto', 'Automatic assignment');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000103', 'd0000000-0000-4000-8000-000000000103', 'initial',
    'Garage and spot inspection — Andheri', 'Photograph the vehicle (all sides), odometer and chassis plate; visit the spot; meet the insured.',
    'a0000000-0000-4000-8000-000000000012', now() + interval '1 day', 'Sample Auto Works, Andheri East, Mumbai',
    'a0000000-0000-4000-8000-000000000004', null, 'c0000000-0000-4000-8000-000000000003');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000113', 'd0000000-0000-4000-8000-000000000103', 'office',
    'Verify RC and driving licence online', null,
    'a0000000-0000-4000-8000-000000000004', now() + interval '3 hours', null, 'a0000000-0000-4000-8000-000000000004');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
select public.post_thread_message('d0000000-0000-4000-8000-000000000103', pg_temp.cid('msg-103-1'), 'text',
    'Please photograph the odometer clearly and the chassis plate.', 'e0000000-0000-4000-8000-000000000103');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000012');
select public.post_thread_message('d0000000-0000-4000-8000-000000000103', pg_temp.cid('msg-103-2'), 'text',
    'Reached the garage. The vehicle is inside; taking photos now.', 'e0000000-0000-4000-8000-000000000103');
select public.post_thread_message('d0000000-0000-4000-8000-000000000103', pg_temp.cid('msg-103-3'), 'media',
    'Vehicle, odometer and chassis', 'e0000000-0000-4000-8000-000000000103', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000103', '103-front', 'IMG_20261101_front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000103', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000103', '103-rear', 'IMG_20261101_rear.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000103', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000103', '103-odo', 'IMG_20261101_odo.jpg', 'photo',
                     'odometer_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000103', 2)),
        pg_temp.item('d0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000103', '103-chassis', 'IMG_20261101_chassis.jpg', 'photo',
                     'chassis_engine_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000103', 3))));
select public.post_thread_message('d0000000-0000-4000-8000-000000000103', pg_temp.cid('msg-103-4'), 'media',
    'Old photo of the junction from my gallery', 'e0000000-0000-4000-8000-000000000103', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000103', '103-junction', 'IMG_2231.jpg', 'photo',
                     null, 'gallery')));
select public.post_thread_message('d0000000-0000-4000-8000-000000000103', pg_temp.cid('msg-103-5'), 'text',
    'Insured is not at the spot. I will meet him tomorrow morning.', 'e0000000-0000-4000-8000-000000000103');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
select public.post_staff_note('d0000000-0000-4000-8000-000000000103', pg_temp.cid('note-103-a'),
    'Insured is avoiding calls; try the second number from the claim form. Insurer wants the report today.');
select pg_temp.as_user(null);
insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, description, model)
values
    (pg_temp.ev('d0000000-0000-4000-8000-000000000103', '103-front'), pg_temp.cat('vehicle_photo'), 0.97, 'llm', 'seed',
     'Front of a two-wheeler with a cracked fairing', 'seed-fixture'),
    (pg_temp.ev('d0000000-0000-4000-8000-000000000103', '103-junction'), pg_temp.cat('spot_photo'), 0.71, 'llm', 'seed',
     'Road junction with a scraped divider', 'seed-fixture');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000103',
    '{"present_address":"Flat 4, Sample Heights, Andheri East, Mumbai","garage_contact":"9000000303","reg_number":"MH 00 TS 0103","job_card_no":"JC-SAMPLE-103"}',
    'office', null, 'a0000000-0000-4000-8000-000000000004');
insert into public.case_field_values (case_id, field_id, value, source, confidence, source_evidence_id, source_ref)
values ('d0000000-0000-4000-8000-000000000103', pg_temp.fld('d0000000-0000-4000-8000-000000000103', 'odometer_at_entry'),
        '18,432 km', 'suggestion', 0.82, pg_temp.ev('d0000000-0000-4000-8000-000000000103', '103-odo'), '{"block":2}');

-- ---------------------------------------------------------------------
-- 104  ICL  overdue; reassigned to Uma; first visit done, re-investigation open
-- ---------------------------------------------------------------------
select private.assign_case('d0000000-0000-4000-8000-000000000104', 'a0000000-0000-4000-8000-000000000004', 'auto', 'Automatic assignment');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
select public.reassign_case('d0000000-0000-4000-8000-000000000104', 'a0000000-0000-4000-8000-000000000003',
    'Neel has a long inspection backlog; Uma has capacity.');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000104', 'd0000000-0000-4000-8000-000000000104', 'initial',
    'Spot and garage inspection — Hadapsar', 'Spot, vehicle and driver licence. Ask the insured for any CCTV near the spot.',
    'a0000000-0000-4000-8000-000000000011', now() + interval '1 day', 'Hadapsar, Pune',
    'a0000000-0000-4000-8000-000000000003', null, 'c0000000-0000-4000-8000-000000000003');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000011');
select public.post_thread_message('d0000000-0000-4000-8000-000000000104', pg_temp.cid('msg-104-1'), 'media',
    'Spot, vehicle and licence copy done.', 'e0000000-0000-4000-8000-000000000104', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000104', 'e0000000-0000-4000-8000-000000000104', '104-spot', 'spot_hadapsar.jpg', 'photo',
                     'spot_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000104', 4)),
        pg_temp.item('d0000000-0000-4000-8000-000000000104', 'e0000000-0000-4000-8000-000000000104', '104-front', 'vehicle_front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000104', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000104', 'e0000000-0000-4000-8000-000000000104', '104-dl', 'driving_licence.pdf', 'document',
                     'dl_document', 'share', pg_temp.ci('e0000000-0000-4000-8000-000000000104', 5),
                     'DRIVING LICENCE  Maharashtra  DL No MH00 20200000104  Name TEST DRIVER 104 (SAMPLE)  Valid till 2040  Class MCWG')));
select public.post_thread_message('d0000000-0000-4000-8000-000000000104', pg_temp.cid('msg-104-2'), 'text',
    'Insured says the CCTV was overwritten; no footage is available.', 'e0000000-0000-4000-8000-000000000104');
update public.tasks set status = 'completed' where id = 'e0000000-0000-4000-8000-000000000104';
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select public.post_staff_note('d0000000-0000-4000-8000-000000000104', pg_temp.cid('note-104-a'),
    'The licence class does not seem to cover this vehicle. Re-check with the RTO record and get the original job card from the garage.');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000114', 'd0000000-0000-4000-8000-000000000104', 're_investigation',
    'Re-check driver licence with the RTO and collect the original job card',
    'The licence class on the copy does not match the vehicle. Confirm at the RTO and bring a photo of the original job card.',
    'a0000000-0000-4000-8000-000000000011', now() + interval '1 day', 'Pune RTO and the garage in Hadapsar',
    'a0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000104', null);
select pg_temp.as_user('a0000000-0000-4000-8000-000000000011');
select public.post_thread_message('d0000000-0000-4000-8000-000000000104', pg_temp.cid('msg-104-3'), 'text',
    'Understood. I will go to the garage first thing tomorrow.', 'e0000000-0000-4000-8000-000000000114');
select pg_temp.as_user(null);
insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, description, model)
values (pg_temp.ev('d0000000-0000-4000-8000-000000000104', '104-dl'), pg_temp.cat('dl_document'), 0.99, 'llm', 'seed',
        'Maharashtra driving licence (front)', 'seed-fixture');
insert into public.field_suggestions (evidence_id, field_id, value, confidence, block_index, source)
values (pg_temp.ev('d0000000-0000-4000-8000-000000000104', '104-dl'), pg_temp.fld('d0000000-0000-4000-8000-000000000104', 'dl_number'),
        'MH00 20200000104', 0.88, 0, 'text_rule'),
       (pg_temp.ev('d0000000-0000-4000-8000-000000000104', '104-dl'), pg_temp.fld('d0000000-0000-4000-8000-000000000104', 'dl_classes'),
        'MCWG', 0.74, 0, 'text_rule');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000104',
    '{"firm_case_ref":"TIV/2026/0104","dl_observation":"Class on the copy may not cover the vehicle; re-check with the RTO.","garage_visit":"Visited the garage in Hadapsar; vehicle inspected."}',
    'office', null, 'a0000000-0000-4000-8000-000000000003');

-- ---------------------------------------------------------------------
-- 105  IGI  office_review, Uma writing the report: some required fields still empty
-- ---------------------------------------------------------------------
select private.assign_case('d0000000-0000-4000-8000-000000000105', 'a0000000-0000-4000-8000-000000000003', 'auto', 'Automatic assignment');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000105', 'd0000000-0000-4000-8000-000000000105', 'initial',
    'Spot and garage inspection — Nashik Road', 'Standard motor OD visit; also note the FIR details.',
    'a0000000-0000-4000-8000-000000000013', now() - interval '4 days', 'Nashik Road, Nashik',
    'a0000000-0000-4000-8000-000000000003', null, 'c0000000-0000-4000-8000-000000000003');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000013');
select public.post_thread_message('d0000000-0000-4000-8000-000000000105', pg_temp.cid('msg-105-1'), 'media',
    'Vehicle, chassis, spot and the insured.', 'e0000000-0000-4000-8000-000000000105', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-front', 'front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-odo', 'odometer.jpg', 'photo',
                     'odometer_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 2)),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-plate', 'plate_closeup.jpg', 'photo',
                     null, 'camera'),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-spot', 'spot_nashik.jpg', 'photo',
                     'spot_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 4)),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-insured', 'with_insured.jpg', 'photo',
                     'insured_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 7)),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-blur', 'blurry_IMG_9912.jpg', 'photo',
                     null, 'gallery')));
select public.post_thread_message('d0000000-0000-4000-8000-000000000105', pg_temp.cid('msg-105-2'), 'media',
    'Licence and FIR copies shared from WhatsApp.', 'e0000000-0000-4000-8000-000000000105', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-dl', 'DL_scan.pdf', 'document',
                     'dl_document', 'share', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 5),
                     'DRIVING LICENCE  DL No MH00 20190000105  Name TEST DRIVER 105 (SAMPLE)  Valid till 2039  Class MCWG LMV'),
        pg_temp.item('d0000000-0000-4000-8000-000000000105', 'e0000000-0000-4000-8000-000000000105', '105-fir', 'FIR_copy.pdf', 'document',
                     'fir_police_document', 'share', pg_temp.ci('e0000000-0000-4000-8000-000000000105', 6),
                     'FIRST INFORMATION REPORT  Police Station Sample Road  FIR No 0105/2026  Date of report four days after the incident')));
select public.post_thread_message('d0000000-0000-4000-8000-000000000105', pg_temp.cid('msg-105-3'), 'text',
    'All items done. Insured stayed at the spot with us.', 'e0000000-0000-4000-8000-000000000105');
update public.tasks set status = 'completed' where id = 'e0000000-0000-4000-8000-000000000105';
select pg_temp.as_user(null);
insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, description, model, needs_detail, detail_reason)
values
    (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-plate'), pg_temp.cat('vehicle_photo'), 0.55, 'llm', 'seed',
     'Close-up of a number plate', 'seed-fixture', true, 'Chassis or plate text may need a full-resolution read'),
    (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-spot'), pg_temp.cat('spot_photo'), 0.93, 'llm', 'seed',
     'Roadside spot with skid marks', 'seed-fixture', null, null);
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
select public.set_evidence_labels(pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-plate'), array[pg_temp.cat('chassis_engine_photo')]);
update public.evidence set relevance = 'relevant' where id in
    (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-spot'), pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-front'));
update public.evidence set relevance = 'not_relevant' where id = pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-blur');
select public.post_staff_note('d0000000-0000-4000-8000-000000000105', pg_temp.cid('note-105-a'),
    'All required photos are in. Starting the report; the FIR delay still needs an explanation from the insured.');
select pg_temp.as_user(null);
insert into public.field_suggestions (evidence_id, field_id, value, confidence, block_index, source)
values (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-dl'), pg_temp.fld('d0000000-0000-4000-8000-000000000105', 'dl_number'),
        'MH00 20190000105', 0.9, 0, 'text_rule'),
       (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-fir'), pg_temp.fld('d0000000-0000-4000-8000-000000000105', 'fir_no_date'),
        '0105/2026', 0.8, 0, 'text_rule');
insert into public.evidence_field_matches (evidence_id, field_id, score, model)
values (pg_temp.ev('d0000000-0000-4000-8000-000000000105', '105-spot'), pg_temp.fld('d0000000-0000-4000-8000-000000000105', 'spot_details'),
        0.84, 'seed-fixture');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000105',
    '{"present_address":"12 Sample Colony, Nashik Road","permanent_address":"12 Sample Colony, Nashik Road","police_station":"Sample Road Police Station","io_details":"SI Test Officer (sample), 9000000105","garage_contact":"9000000305","job_card_no":"JC-SAMPLE-105","reg_number":"MH 00 TS 0105","engine_no":"ENG-SAMPLE-0105","chassis_no":"CHS-SAMPLE-0105","dl_number":"MH00 20190000105","dl_valid_at_loss":"Yes","spot_matches":"Yes"}',
    'office', null, 'a0000000-0000-4000-8000-000000000003');

-- ---------------------------------------------------------------------
-- 106 (ICL, Neel), 107 (IGI, Neel), 108 (ICL, Uma): field work done, report written.
--   106 waits for the orchestrator's approval; 107 was approved and sent; 108 was sent and closed.
-- ---------------------------------------------------------------------
select pg_temp.as_user(null);
select private.assign_case('d0000000-0000-4000-8000-000000000106', 'a0000000-0000-4000-8000-000000000004', 'auto', 'Automatic assignment');
select private.assign_case('d0000000-0000-4000-8000-000000000107', 'a0000000-0000-4000-8000-000000000004', 'auto', 'Automatic assignment');
select private.assign_case('d0000000-0000-4000-8000-000000000108', 'a0000000-0000-4000-8000-000000000003', 'auto', 'Automatic assignment');

select pg_temp.mk_task('e0000000-0000-4000-8000-000000000106', 'd0000000-0000-4000-8000-000000000106', 'initial',
    'Spot and garage inspection — Andheri', 'Standard motor OD visit.', 'a0000000-0000-4000-8000-000000000012',
    now() - interval '3 days', 'Andheri West, Mumbai', 'a0000000-0000-4000-8000-000000000004', null, 'c0000000-0000-4000-8000-000000000003');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000107', 'd0000000-0000-4000-8000-000000000107', 'initial',
    'Spot and garage inspection — Satpur', 'Standard motor OD visit; compare the odometer with the service history.',
    'a0000000-0000-4000-8000-000000000013', now() - interval '10 days', 'Satpur, Nashik',
    'a0000000-0000-4000-8000-000000000004', null, 'c0000000-0000-4000-8000-000000000003');
select pg_temp.mk_task('e0000000-0000-4000-8000-000000000108', 'd0000000-0000-4000-8000-000000000108', 'initial',
    'Garage inspection — Kothrud', 'Check whether the damage justifies a total loss.',
    'a0000000-0000-4000-8000-000000000011', now() - interval '20 days', 'Kothrud, Pune',
    'a0000000-0000-4000-8000-000000000003', null, 'c0000000-0000-4000-8000-000000000003');

select pg_temp.as_user('a0000000-0000-4000-8000-000000000012');
select public.post_thread_message('d0000000-0000-4000-8000-000000000106', pg_temp.cid('msg-106-1'), 'media',
    'Vehicle and odometer done.', 'e0000000-0000-4000-8000-000000000106', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000106', 'e0000000-0000-4000-8000-000000000106', '106-front', 'front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000106', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000106', 'e0000000-0000-4000-8000-000000000106', '106-odo', 'odometer.jpg', 'photo',
                     'odometer_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000106', 2)),
        pg_temp.item('d0000000-0000-4000-8000-000000000106', 'e0000000-0000-4000-8000-000000000106', '106-spot', 'spot.jpg', 'photo',
                     'spot_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000106', 4))));
update public.tasks set status = 'completed' where id = 'e0000000-0000-4000-8000-000000000106';
select pg_temp.as_user('a0000000-0000-4000-8000-000000000013');
select public.post_thread_message('d0000000-0000-4000-8000-000000000107', pg_temp.cid('msg-107-1'), 'media',
    'Vehicle, odometer and spot.', 'e0000000-0000-4000-8000-000000000107', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000107', 'e0000000-0000-4000-8000-000000000107', '107-front', 'front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000107', 1)),
        pg_temp.item('d0000000-0000-4000-8000-000000000107', 'e0000000-0000-4000-8000-000000000107', '107-odo', 'odometer.jpg', 'photo',
                     'odometer_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000107', 2)),
        pg_temp.item('d0000000-0000-4000-8000-000000000107', 'e0000000-0000-4000-8000-000000000107', '107-spot', 'spot.jpg', 'photo',
                     'spot_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000107', 4))));
update public.tasks set status = 'completed' where id = 'e0000000-0000-4000-8000-000000000107';
select pg_temp.as_user('a0000000-0000-4000-8000-000000000011');
select public.post_thread_message('d0000000-0000-4000-8000-000000000108', pg_temp.cid('msg-108-1'), 'media',
    'Garage visit done; damage is minor.', 'e0000000-0000-4000-8000-000000000108', null, jsonb_build_array(
        pg_temp.item('d0000000-0000-4000-8000-000000000108', 'e0000000-0000-4000-8000-000000000108', '108-front', 'front.jpg', 'photo',
                     'vehicle_photo', 'camera', pg_temp.ci('e0000000-0000-4000-8000-000000000108', 1))));
update public.tasks set status = 'completed' where id = 'e0000000-0000-4000-8000-000000000108';

select pg_temp.as_user(null);
select pg_temp.fvs('d0000000-0000-4000-8000-000000000106',
    '{"firm_case_ref":"TIV/2026/0106","written_statement":"The insured stated that the vehicle was sold to a relative but the transfer was not completed. (sample text)","case_summary":"Vehicle inspected at the garage and the spot visited. Transfer papers were not produced. (sample text)","observations":"Damage is consistent with a low-speed fall. Odometer matches the service record. (sample text)","final_conclusion":"Claim appears genuine; the sale was not completed before the loss. (sample text)","investigation_status":"Genuine","dl_number":"MH00 20180000106"}',
    'office', null, 'a0000000-0000-4000-8000-000000000004');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000107',
    '{"present_address":"7 Sample Lane, Satpur, Nashik","reg_number":"MH 00 TS 0107","odometer_at_entry":"22,910 km","brief_remarks":"Insured lost control on a wet road and hit the divider. (sample text)","statements":"Statement of the insured and the driver recorded; both consistent. (sample text)","findings":"Odometer reading matches the latest service entry. Spot and damage pattern agree. (sample text)","conclusion":"Claim is genuine and recommended for settlement. (sample text)","investigation_status":"Genuine","compiled_by":"Neel Office"}',
    'office', null, 'a0000000-0000-4000-8000-000000000004');
select pg_temp.fvs('d0000000-0000-4000-8000-000000000108',
    '{"firm_case_ref":"TIV/2026/0108","written_statement":"Insured confirmed minor damage to the front fairing. (sample text)","case_summary":"Garage inspected; repair estimate is far below the claimed amount. (sample text)","observations":"Damage does not justify a total loss. (sample text)","final_conclusion":"Claim amount is inflated; recommend settlement on repair cost only. (sample text)","investigation_status":"Inflated claim"}',
    'office', null, 'a0000000-0000-4000-8000-000000000003');

insert into public.reports (id, case_id, version, status, storage_path, uploaded_by, notes, origin, template_id, template_version)
select r.id, r.case_id, 1, r.status::public.report_status,
       'cases/' || c.id || '/' || c.case_ref || '-v1.pdf', r.uploaded_by, 'Seed data: no file in storage', 'generated', c.template_id,
       (select t.version from public.case_templates t where t.id = c.template_id)
  from (values
    ('91000000-0000-4000-8000-000000000106'::uuid, 'd0000000-0000-4000-8000-000000000106'::uuid, 'draft', 'a0000000-0000-4000-8000-000000000004'::uuid),
    ('91000000-0000-4000-8000-000000000107', 'd0000000-0000-4000-8000-000000000107', 'final', 'a0000000-0000-4000-8000-000000000004'),
    ('91000000-0000-4000-8000-000000000108', 'd0000000-0000-4000-8000-000000000108', 'final', 'a0000000-0000-4000-8000-000000000003')
  ) as r(id, case_id, status, uploaded_by)
  join public.cases c on c.id = r.case_id;

select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
insert into public.report_approvals (id, case_id, report_id) values
    ('92000000-0000-4000-8000-000000000106', 'd0000000-0000-4000-8000-000000000106', '91000000-0000-4000-8000-000000000106'),
    ('92000000-0000-4000-8000-000000000107', 'd0000000-0000-4000-8000-000000000107', '91000000-0000-4000-8000-000000000107');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
insert into public.report_approvals (id, case_id, report_id) values
    ('92000000-0000-4000-8000-000000000108', 'd0000000-0000-4000-8000-000000000108', '91000000-0000-4000-8000-000000000108');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
update public.report_approvals set decision = 'approved', comments = 'Approved. Send as PDF.'
 where id in ('92000000-0000-4000-8000-000000000107', '92000000-0000-4000-8000-000000000108');

select pg_temp.as_user('a0000000-0000-4000-8000-000000000004');
insert into public.submissions (id, case_id, report_id, channel, submitted_by, formats, to_addresses,
                                sent_message_id, gmail_thread_id, notes)
values ('93000000-0000-4000-8000-000000000107', 'd0000000-0000-4000-8000-000000000107', '91000000-0000-4000-8000-000000000107',
        'email', 'a0000000-0000-4000-8000-000000000004', '{pdf}', '{rcu@indus-general.example}',
        '<seed-sent-107@investigation.example>', 'seed-thread-107', 'Seed data');
select pg_temp.as_user('a0000000-0000-4000-8000-000000000003');
insert into public.submissions (id, case_id, report_id, channel, submitted_by, insurer_reference, formats, to_addresses,
                                sent_message_id, gmail_thread_id, notes, acknowledged_at)
values ('93000000-0000-4000-8000-000000000108', 'd0000000-0000-4000-8000-000000000108', '91000000-0000-4000-8000-000000000108',
        'email', 'a0000000-0000-4000-8000-000000000003', 'ACK-SAMPLE-0108', '{pdf,docx}', '{siu@lombard-sample.example}',
        '<seed-sent-108@investigation.example>', 'seed-thread-108', 'Seed data', now());
select pg_temp.as_user('a0000000-0000-4000-8000-000000000002');
update public.cases set status = 'closed' where id = 'd0000000-0000-4000-8000-000000000108';
select pg_temp.as_user(null);

-- ---------------------------------------------------------------------
-- Spread the demo events over each case's life. Everything above ran "now"; here the timestamps are
-- moved back so the pages show realistic ages (triggers that stamp now() are paused for this step).
-- Order within a case follows the audit log; closed / submitted cases end earlier.
-- ---------------------------------------------------------------------
alter table public.case_messages        disable trigger user;
alter table public.evidence             disable trigger user;
alter table public.evidence_labels      disable trigger user;
alter table public.case_status_history  disable trigger user;
alter table public.case_assignments     disable trigger user;
alter table public.tasks                disable trigger user;
alter table public.task_holds           disable trigger user;
alter table public.reports              disable trigger user;
alter table public.report_approvals     disable trigger user;
alter table public.submissions          disable trigger user;
alter table public.case_field_values    disable trigger user;
alter table public.cases                disable trigger user;
alter table public.field_suggestions    disable trigger user;
alter table public.notifications         disable trigger user;
alter table public.evidence_ocr           disable trigger user;
alter table public.evidence_field_matches disable trigger user;

create temp table seed_span as
select c.id as case_id, c.received_at as t0,
       c.received_at + (now() - c.received_at) * case c.id
            when 'd0000000-0000-4000-8000-000000000101' then 1.0
            when 'd0000000-0000-4000-8000-000000000107' then 0.78
            when 'd0000000-0000-4000-8000-000000000108' then 0.5
            else 0.97 end as t1
  from public.cases c
 where c.id between 'd0000000-0000-4000-8000-000000000101' and 'd0000000-0000-4000-8000-000000000108';

create temp table seed_ev as
select a.record_id as rid, a.table_name as tn, s.case_id,
       s.t0 + (s.t1 - s.t0) * (row_number() over (partition by s.case_id order by a.id))::numeric
            / ((count(*) over (partition by s.case_id)) + 1) as t
  from public.audit_log a
  join seed_span s on s.case_id = (a.new_data ->> 'case_id')::uuid
 where a.action = 'INSERT'
   and a.table_name in ('case_messages', 'evidence', 'tasks', 'reports', 'report_approvals', 'submissions');

update public.case_messages m set created_at = e.t from seed_ev e where e.tn = 'case_messages' and e.rid = m.id;
update public.evidence ev set server_received_at = e.t, created_at = e.t from seed_ev e where e.tn = 'evidence' and e.rid = ev.id;
update public.evidence ev set server_received_at = m.created_at, created_at = m.created_at
  from public.case_messages m where ev.message_id = m.id;
update public.evidence ev set server_received_at = s.t0 + interval '1 minute', created_at = s.t0 + interval '1 minute'
  from seed_span s where ev.case_id = s.case_id and ev.capture_source = 'email_attachment';
update public.evidence set device_captured_at = server_received_at - interval '3 minutes'
 where device_captured_at is not null and case_id in (select case_id from seed_span);
update public.evidence set relevance_at = server_received_at + interval '2 hours'
 where relevance_at is not null and case_id in (select case_id from seed_span);
update public.evidence_labels l set created_at = ev.server_received_at + interval '1 minute'
  from public.evidence ev where l.evidence_id = ev.id and ev.case_id in (select case_id from seed_span);
update public.evidence_ocr o set created_at = ev.server_received_at + interval '1 minute'
  from public.evidence ev where o.evidence_id = ev.id and ev.case_id in (select case_id from seed_span);
update public.field_suggestions f set created_at = ev.server_received_at + interval '2 minutes'
  from public.evidence ev where f.evidence_id = ev.id and ev.case_id in (select case_id from seed_span);
update public.evidence_field_matches f set created_at = ev.server_received_at + interval '2 minutes'
  from public.evidence ev where f.evidence_id = ev.id and ev.case_id in (select case_id from seed_span);

update public.tasks t set created_at = e.t,
       started_at = case when t.status in ('in_progress', 'completed') then e.t + interval '30 minutes' end,
       completed_at = case when t.status = 'completed' then e.t + interval '2 hours' end,
       updated_at = case when t.status = 'completed' then e.t + interval '2 hours'
                         when t.status = 'in_progress' then e.t + interval '30 minutes' else e.t end
  from seed_ev e where e.tn = 'tasks' and e.rid = t.id;
update public.task_holds h set held_from = t.created_at,
       held_until = case when t.status = 'completed' then t.completed_at end
  from public.tasks t where h.task_id = t.id and t.case_id in (select case_id from seed_span);

update public.reports r set created_at = e.t from seed_ev e where e.tn = 'reports' and e.rid = r.id;
update public.report_approvals a set requested_at = e.t,
       decided_at = case when a.decision <> 'pending' then e.t + interval '2 hours' end
  from seed_ev e where e.tn = 'report_approvals' and e.rid = a.id;
update public.submissions s set submitted_at = e.t,
       acknowledged_at = case when s.acknowledged_at is not null then e.t + interval '1 day' end
  from seed_ev e where e.tn = 'submissions' and e.rid = s.id;

-- status history and assignments (identity ids, not in the audit log): spread by their own order
update public.case_status_history h set changed_at = x.t
  from (select h2.id, s.t0 + (s.t1 - s.t0) * (row_number() over (partition by h2.case_id order by h2.id))::numeric
                              / ((count(*) over (partition by h2.case_id)) + 1) as t
          from public.case_status_history h2 join seed_span s on s.case_id = h2.case_id) x
 where h.id = x.id;
update public.case_assignments a set assigned_at = x.t
  from (select a2.id, s.t0 + (s.t1 - s.t0) * 0.02 * (row_number() over (partition by a2.case_id order by a2.id))::numeric as t
          from public.case_assignments a2 join seed_span s on s.case_id = a2.case_id) x
 where a.id = x.id;
update public.cases c set office_assigned_at = (select max(a.assigned_at) from public.case_assignments a where a.case_id = c.id),
       closed_at = (select max(h.changed_at) from public.case_status_history h where h.case_id = c.id and h.to_status = 'closed'),
       updated_at = (select max(h.changed_at) from public.case_status_history h where h.case_id = c.id)
 where c.id in (select case_id from seed_span) and c.office_owner_id is not null;
update public.cases set updated_at = received_at where id = 'd0000000-0000-4000-8000-000000000101';

update public.case_field_values v set updated_at = case when v.source = 'email_parser' then s.t0 + interval '1 minute'
        else s.t0 + (s.t1 - s.t0) * (0.4 + 0.5 * ((hashtext(v.id::text) & 1023) / 1024.0)) end
  from seed_span s where v.case_id = s.case_id;

update public.notifications n set created_at = x.t
  from (select n2.id, s.t0 + (s.t1 - s.t0) * 0.9 * (row_number() over (partition by n2.case_id order by n2.id))::numeric
                              / ((count(*) over (partition by n2.case_id)) + 1) as t
          from public.notifications n2 join seed_span s on s.case_id = n2.case_id) x
 where n.id = x.id;
-- finished cases were read; the working cases keep unread items
update public.notifications set read_at = created_at + interval '2 hours'
 where case_id in ('d0000000-0000-4000-8000-000000000105', 'd0000000-0000-4000-8000-000000000107',
                   'd0000000-0000-4000-8000-000000000108');

-- No files exist for any of this data, so the pipeline must not try to process them.
update public.processing_jobs set status = 'skipped', last_error = 'seed data: no file in storage', finished_at = now()
 where evidence_id in (select id from public.evidence where case_id in (select case_id from seed_span));

alter table public.case_messages        enable trigger user;
alter table public.evidence             enable trigger user;
alter table public.evidence_labels      enable trigger user;
alter table public.case_status_history  enable trigger user;
alter table public.case_assignments     enable trigger user;
alter table public.tasks                enable trigger user;
alter table public.task_holds           enable trigger user;
alter table public.reports              enable trigger user;
alter table public.report_approvals     enable trigger user;
alter table public.submissions          enable trigger user;
alter table public.case_field_values    enable trigger user;
alter table public.cases                enable trigger user;
alter table public.field_suggestions    enable trigger user;
alter table public.notifications         enable trigger user;
alter table public.evidence_ocr           enable trigger user;
alter table public.evidence_field_matches enable trigger user;
select pg_temp.as_user(null);
drop table seed_ev;
drop table seed_span;
