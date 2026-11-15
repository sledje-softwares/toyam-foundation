-- create_case_direct() (20261116000000_create_case_direct.sql, D49): office creates its own case, orchestrator
-- picks an owner or runs the automatic assignment, field / anon refused, value and template checks, duplicate
-- claim numbers, and what the creation writes. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(53);

-- ---------------------------------------------------------------------
-- Fixture (prefix a21...): a1 admin, c1 orchestrator, b1 / b2 office, b3 office (inactive), f1 field.
-- Insurer DCR (TAT 7 days) with an active motor/od template and an inactive motor/theft template;
-- assignment rule for DCR -> b2 so the automatic assignment is deterministic.
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000a1','authenticated','authenticated','d-admin@example.com',null,'{"role":"admin","full_name":"D Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000c1','authenticated','authenticated','d-orch@example.com',null,'{"role":"orchestrator","full_name":"D Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000b1','authenticated','authenticated','d-off1@example.com',null,'{"role":"office","full_name":"D Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000b2','authenticated','authenticated','d-off2@example.com',null,'{"role":"office","full_name":"D Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000b3','authenticated','authenticated','d-off3@example.com',null,'{"role":"office","full_name":"D Office 3"}','{}'),
 ('00000000-0000-0000-0000-000000000000','a2100000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000001','{"role":"field","full_name":"D Field"}','{}');
update public.profiles set is_active = false where id = 'a2100000-0000-4000-8000-0000000000b3';

insert into public.insurers (id, name, code, tat_days) values ('b2100000-0000-4000-8000-000000000001', 'Direct Insurer', 'DCR', 7);
select public.load_case_template('{"insurer_code":"DCR","claim_type":"motor","variant":"od","name":"DCR OD","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[
     {"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true},
     {"key":"insured_name","label":"Insured name","source":"intake","required":true},
     {"key":"policy_no","label":"Policy no","source":"intake"},
     {"key":"investigation_points","label":"Points","type":"long_text","source":"intake"},
     {"key":"findings","label":"Findings","type":"long_text"}]}]}');
select public.load_case_template('{"insurer_code":"DCR","claim_type":"motor","variant":"theft","name":"DCR theft","requires_approval":false,"output_formats":["pdf"],
  "sections":[{"key":"insured","title":"Insured","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake","required":true}]}]}',
  null, false);

insert into public.assignment_rules (id, name, insurer_id, priority) values ('c2100000-0000-4000-8000-000000000001', 'DCR desk', 'b2100000-0000-4000-8000-000000000001', 1);
insert into public.assignment_rule_members (rule_id, profile_id) values ('c2100000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-0000000000b2');

create function pg_temp.tpl(p_variant text) returns uuid language sql stable security definer set search_path = '' as $$
    select t.id from public.case_templates t join public.insurers i on i.id = t.insurer_id
     where i.code = 'DCR' and t.variant = p_variant $$;
create function pg_temp.cid(p_claim text) returns uuid language sql stable security definer set search_path = '' as $$
    select c.id from public.cases c where c.insurer_id = 'b2100000-0000-4000-8000-000000000001' and c.insurer_claim_no = p_claim $$;
create function pg_temp.cref(p_claim text) returns text language sql stable security definer set search_path = '' as $$
    select c.case_ref from public.cases c where c.insurer_id = 'b2100000-0000-4000-8000-000000000001' and c.insurer_claim_no = p_claim $$;
grant execute on function pg_temp.tpl(text), pg_temp.cid(text), pg_temp.cref(text) to authenticated, anon;

-- =====================================================================
-- 1. Office creates its own case
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select matches((select r.case_ref from public.create_case_direct(pg_temp.tpl('od'),
                   '{"insurer_claim_no":" DCR-1 ","insured_name":"R Sharma","policy_no":"POL-1","investigation_points":"Check\r\nthe garage"}', null, '  Insurer called about this one  ') r),
               '^INV-\d{4}-\d{6}$', 'office creates a case and gets its case ref');
select is((select count(*)::int from public.cases where id = pg_temp.cid('DCR-1')), 1, 'the office creator sees the case (D44)');
select is((select office_owner_id from public.cases where id = pg_temp.cid('DCR-1')), 'a2100000-0000-4000-8000-0000000000b1'::uuid, 'owner is the creator');
select is((select status::text from public.cases where id = pg_temp.cid('DCR-1')), 'assigned', 'status assigned');
select is((select assignment_method from public.cases where id = pg_temp.cid('DCR-1')), 'manual', 'assignment method manual');

set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select is((select count(*)::int from public.cases where id = pg_temp.cid('DCR-1')), 0, 'another office employee does not see it');

reset role;
select is((select created_by from public.cases where id = pg_temp.cid('DCR-1')), 'a2100000-0000-4000-8000-0000000000b1'::uuid, 'created_by is the creator');
select is((select template_id from public.cases where id = pg_temp.cid('DCR-1')), pg_temp.tpl('od'), 'case uses the template');
select is((select claim_type::text from public.cases where id = pg_temp.cid('DCR-1')), 'motor', 'claim type from the template');
select is((select due_at - received_at from public.cases where id = pg_temp.cid('DCR-1')), interval '7 days', 'due date from the insurer TAT');
select is((select policy_no from public.cases where id = pg_temp.cid('DCR-1')), 'POL-1', 'policy no. on the case');
select is((select suspicion_summary from public.cases where id = pg_temp.cid('DCR-1')), E'Check\nthe garage', 'investigation points become the suspicion summary (CRLF normalised)');
select is((select count(*)::int from public.case_field_values where case_id = pg_temp.cid('DCR-1')), 4, 'four field values stored');
select is((select count(*)::int from public.case_field_values where case_id = pg_temp.cid('DCR-1') and source = 'office'
             and updated_by = 'a2100000-0000-4000-8000-0000000000b1'), 4, 'values have source office and the creator');
select is((select v.value from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
            where v.case_id = pg_temp.cid('DCR-1') and f.key = 'insurer_claim_no'), 'DCR-1', 'claim no. trimmed');
select results_eq($$select from_status::text, to_status::text from public.case_status_history where case_id = pg_temp.cid('DCR-1')$$,
    $$values (null::text, 'assigned'::text)$$, 'status history: created as assigned');
select results_eq($$select assignee_id, method, assigned_by from public.case_assignments where case_id = pg_temp.cid('DCR-1')$$,
    $$values ('a2100000-0000-4000-8000-0000000000b1'::uuid, 'manual'::text, 'a2100000-0000-4000-8000-0000000000b1'::uuid)$$,
    'assignment record for the creator');
select results_eq($$select kind::text, visibility, body from public.case_messages where case_id = pg_temp.cid('DCR-1') and kind = 'system'$$,
    $$values ('system'::text, 'staff'::text, 'Case created by D Office 1'::text)$$, 'staff-only system message names the creator');
select results_eq($$select sender_id, visibility, body from public.case_messages where case_id = pg_temp.cid('DCR-1') and kind = 'text'$$,
    $$values ('a2100000-0000-4000-8000-0000000000b1'::uuid, 'staff'::text, 'Insurer called about this one'::text)$$,
    'the note is a staff-only message from the creator');
select is((select count(*)::int from public.parties where case_id = pg_temp.cid('DCR-1') and role = 'insured' and name = 'R Sharma'), 1, 'insured party recorded');
select is((select count(*)::int from public.notifications where case_id = pg_temp.cid('DCR-1')), 0, 'no notification when the creator owns the case');
select is((select count(*)::int from public.audit_log where action = 'CASE_CREATED' and record_id = pg_temp.cid('DCR-1')
             and actor_id = 'a2100000-0000-4000-8000-0000000000b1' and new_data->>'assignment' = 'self'), 1, 'audit row CASE_CREATED');

-- =====================================================================
-- 2. Office: owner rules
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-2","insured_name":"X"}',
                   'a2100000-0000-4000-8000-0000000000b2')$$,
    '42501', 'Office employees create cases for themselves only', 'office cannot create a case for someone else');
select lives_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-3","insured_name":"X"}',
                  'a2100000-0000-4000-8000-0000000000b1')$$, 'office may name itself as owner');

-- =====================================================================
-- 3. Values and template checks
-- =====================================================================
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4"}')$$,
    '22023', 'Required fields are empty: Insured name', 'missing required field refused, label named');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4","insured_name":"   "}')$$,
    '22023', 'Required fields are empty: Insured name', 'blank required field counts as missing');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insured_name":"X"}')$$,
    '22023', 'The claim number is required', 'claim no. required');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4","insured_name":"X","colour":"red"}')$$,
    '22023', 'Unknown field: colour', 'unknown key refused');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4","insured_name":"X","findings":"done"}')$$,
    '22023', 'Unknown field: findings', 'office (report) field refused at creation');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4","insured_name":42}')$$,
    '22023', 'Value of insured_name must be text', 'non-text value refused');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '["DCR-4"]')$$,
    '22023', 'Values must be a JSON object', 'values must be an object');
select throws_ok(format($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-4","insured_name":"X"}', null, %L)$$, repeat('n', 4001)),
    '22023', 'The note can be at most 4000 characters', 'note too long refused');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('theft'), '{"insurer_claim_no":"DCR-4"}')$$,
    '22023', 'Choose a template that is in use', 'inactive template refused');
select throws_ok($$select * from public.create_case_direct('00000000-0000-4000-8000-000000000000', '{"insurer_claim_no":"DCR-4"}')$$,
    '22023', 'Choose a template that is in use', 'unknown template refused');

-- =====================================================================
-- 4. Duplicate claim numbers
-- =====================================================================
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-1","insured_name":"X"}')$$,
    '23505', format('Case %s already has claim number DCR-1 for this insurer', pg_temp.cref('DCR-1')),
    'duplicate claim no. names the existing case when the caller can see it');
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-1","insured_name":"X"}')$$,
    '23505', 'A case with claim number DCR-1 already exists for this insurer',
    'duplicate claim no. on a case the caller cannot see: generic message, no case ref');

-- =====================================================================
-- 5. Orchestrator / admin: chosen owner or automatic assignment
-- =====================================================================
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select lives_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-5","insured_name":"Y"}',
                  'a2100000-0000-4000-8000-0000000000b1')$$, 'orchestrator creates a case for an office employee');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-6","insured_name":"Y"}',
                   'a2100000-0000-4000-8000-0000000000b3')$$,
    '22023', 'The owner must be an active office, orchestrator or admin user', 'inactive owner refused');
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-6","insured_name":"Y"}',
                   'a2100000-0000-4000-8000-0000000000f1')$$,
    '22023', 'The owner must be an active office, orchestrator or admin user', 'field user cannot own a case');
select lives_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-7","insured_name":"Z"}')$$,
    'orchestrator creates a case with automatic assignment');
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-8","insured_name":"Z"}',
                  'a2100000-0000-4000-8000-0000000000a1')$$, 'admin creates a case for itself');

reset role;
select is((select office_owner_id from public.cases where id = pg_temp.cid('DCR-5')), 'a2100000-0000-4000-8000-0000000000b1'::uuid, 'chosen owner set');
select results_eq($$select assigned_by from public.case_assignments where case_id = pg_temp.cid('DCR-5')$$,
    $$values ('a2100000-0000-4000-8000-0000000000c1'::uuid)$$, 'assignment recorded as made by the orchestrator');
select is((select count(*)::int from public.notifications where case_id = pg_temp.cid('DCR-5') and kind = 'case_assigned'
             and user_id = 'a2100000-0000-4000-8000-0000000000b1'), 1, 'chosen owner notified');
select is((select body from public.case_messages where case_id = pg_temp.cid('DCR-5') and kind = 'system'),
    'Case created by D Orch and assigned to D Office 1', 'message names creator and owner');
select is((select office_owner_id from public.cases where id = pg_temp.cid('DCR-7')), 'a2100000-0000-4000-8000-0000000000b2'::uuid,
    'automatic assignment follows the assignment rule');
select is((select assignment_method from public.cases where id = pg_temp.cid('DCR-7')), 'auto', 'assignment method auto');
select results_eq($$select from_status::text, to_status::text from public.case_status_history where case_id = pg_temp.cid('DCR-7') order by from_status nulls first$$,
    $$values (null::text, 'received'::text), ('received'::text, 'assigned'::text)$$, 'history: received, then assigned');
select is((select count(*)::int from public.notifications where case_id = pg_temp.cid('DCR-7') and kind = 'case_assigned'
             and user_id = 'a2100000-0000-4000-8000-0000000000b2'), 1, 'auto-assigned owner notified');
select is((select count(*)::int from public.case_messages where case_id = pg_temp.cid('DCR-7') and kind = 'system' and visibility = 'staff'
             and body in ('Case created by D Orch', 'Case assigned automatically to D Office 2')), 2,
    'creation and automatic assignment messages, both staff-only');
select is((select new_data->>'assignment' from public.audit_log where action = 'CASE_CREATED' and record_id = pg_temp.cid('DCR-7')), 'auto',
    'audit row records the automatic assignment');

-- =====================================================================
-- 6. Field and anonymous callers
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"a2100000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-9","insured_name":"F"}')$$,
    '42501', 'Only office staff can create cases', 'field user refused');
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select * from public.create_case_direct(pg_temp.tpl('od'), '{"insurer_claim_no":"DCR-9","insured_name":"F"}')$$,
    '42501', null::text, 'anon has no execute privilege');

select * from finish();
rollback;
