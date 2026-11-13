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
