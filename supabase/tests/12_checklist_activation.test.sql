-- D42 (20261114300000_checklist_activation.sql): "Put in use" re-points case templates and audits it,
-- existing task copies stay, updated_at trigger, checklist name 3-80. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- ---------------------------------------------------------------------
-- Fixture (prefix 1c/2c/3c...): a1 admin, c1 orchestrator, b1 office; insurer CKA;
-- checklist A in use (all insurers), copy B not in use; task with items copied from A.
-- ---------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1c000000-0000-4000-8000-0000000000a1','authenticated','authenticated','k-admin@example.com',null,'{"role":"admin","full_name":"K Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1c000000-0000-4000-8000-0000000000c1','authenticated','authenticated','k-orch@example.com',null,'{"role":"orchestrator","full_name":"K Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1c000000-0000-4000-8000-0000000000b1','authenticated','authenticated','k-off@example.com',null,'{"role":"office","full_name":"K Office"}','{}');
insert into public.insurers (id, name, code, tat_days) values ('2c000000-0000-4000-8000-000000000001', 'Checklist Insurer', 'CKA', 10);

insert into public.checklist_templates (id, name, claim_type, insurer_id, is_active) values
 ('3c000000-0000-4000-8000-00000000000a', 'K Garage visit', 'motor', null, true),
 ('3c000000-0000-4000-8000-00000000000b', 'K Garage visit', 'motor', null, false);
insert into public.checklist_template_items (id, template_id, position, description) values
 ('3c100000-0000-4000-8000-00000000000a', '3c000000-0000-4000-8000-00000000000a', 1, 'Old item'),
 ('3c100000-0000-4000-8000-00000000000b', '3c000000-0000-4000-8000-00000000000b', 1, 'New item');

insert into public.cases (id, insurer_id, insurer_claim_no, claim_type)
values ('3c200000-0000-4000-8000-000000000001', '2c000000-0000-4000-8000-000000000001', 'CKA-1', 'motor');
insert into public.tasks (id, case_id, title) values ('3c300000-0000-4000-8000-000000000001', '3c200000-0000-4000-8000-000000000001', 'Garage visit');
insert into public.task_checklist_items (task_id, source_template_item_id, position, description)
values ('3c300000-0000-4000-8000-000000000001', '3c100000-0000-4000-8000-00000000000a', 1, 'Old item');
create temp table t_items on commit drop as
    select id, source_template_item_id, position, description, updated_at from public.task_checklist_items
     where task_id = '3c300000-0000-4000-8000-000000000001';
grant select on t_items to authenticated;

-- admin loads a case template that links the in-use checklist by name
set local role authenticated;
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
create temp table t_ct on commit drop as
    select (t).template_id as id from (select public.load_case_template(
        '{"insurer_code":"CKA","claim_type":"motor","variant":"od","name":"CKA Motor OD",
          "checklists":[{"name":"k garage visit","default":true}]}', 'cka-od.yaml') t) x;
select results_eq($$select checklist_template_id::text, is_default from public.case_template_checklists where template_id = (select id from t_ct)$$,
    $$values ('3c000000-0000-4000-8000-00000000000a'::text, true)$$, 'case template linked to the in-use checklist A');

-- =====================================================================
-- Role rule unchanged: only admins activate
-- =====================================================================
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000b')$$, '42501', null::text, 'office cannot put a checklist in use');
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select throws_ok($$select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000b')$$, '42501', null::text, 'orchestrator cannot put a checklist in use');
select throws_ok($$select private.audit_checklist_repoint(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), false)$$, '42501', null::text,
    'non-admin cannot write a re-point audit row');
reset role;
set local role anon;
select throws_ok($$select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000b')$$, '42501', null::text, 'anon cannot put a checklist in use');
reset role;

-- =====================================================================
-- Put B in use: A out of use, link moved to B, audited, task copies untouched
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000b')$$, 'admin puts the copy B in use');
select results_eq($$select id::text, is_active from public.checklist_templates where lower(name) = 'k garage visit' order by id$$,
    $$values ('3c000000-0000-4000-8000-00000000000a'::text, false), ('3c000000-0000-4000-8000-00000000000b', true)$$,
    'A goes out of use, B is in use');
select results_eq($$select checklist_template_id::text, is_default from public.case_template_checklists where template_id = (select id from t_ct)$$,
    $$values ('3c000000-0000-4000-8000-00000000000b'::text, true)$$, 'case template link re-pointed from A to B, is_default kept');
select is_empty($$select 1 from public.case_template_checklists where checklist_template_id = '3c000000-0000-4000-8000-00000000000a'$$,
    'nothing links the replaced checklist any more');
select set_eq($$select id, source_template_item_id, position, description, updated_at from public.task_checklist_items
                 where task_id = '3c300000-0000-4000-8000-000000000001'$$,
    $$select id, source_template_item_id, position, description, updated_at from t_items$$, 'existing task checklist items unchanged');
select results_eq($$select actor_id::text, old_data->>'checklist_template_id', new_data->>'checklist_template_id', (new_data->>'is_default')::boolean
                      from public.audit_log where action = 'CHECKLIST_REPOINTED' and table_name = 'case_template_checklists'
                       and record_id = (select id from t_ct)$$,
    $$values ('1c000000-0000-4000-8000-0000000000a1'::text, '3c000000-0000-4000-8000-00000000000a'::text,
              '3c000000-0000-4000-8000-00000000000b'::text, true)$$, 're-point audited with actor, old and new checklist');

-- reloading the same YAML changes nothing; a changed YAML links the in-use checklist B too
select is((select (t).created from (select public.load_case_template(
    '{"insurer_code":"CKA","claim_type":"motor","variant":"od","name":"CKA Motor OD",
      "checklists":[{"name":"k garage visit","default":true}]}', 'cka-od.yaml') t) x), false, 'identical reload is a no-op');
select results_eq($$select checklist_template_id::text from public.case_template_checklists where template_id = (select id from t_ct)$$,
    $$values ('3c000000-0000-4000-8000-00000000000b'::text)$$, 'identical reload keeps the re-pointed link');
create temp table t_ct2 on commit drop as
    select (t).template_id as id from (select public.load_case_template(
        '{"insurer_code":"CKA","claim_type":"motor","variant":"od","name":"CKA Motor OD v2",
          "checklists":[{"name":"k garage visit","default":true}]}', 'cka-od.yaml') t) x;
select results_eq($$select checklist_template_id::text from public.case_template_checklists where template_id = (select id from t_ct2)$$,
    $$values ('3c000000-0000-4000-8000-00000000000b'::text)$$, 'changed reload links the same in-use checklist B');

-- a checklist in another scope is not replaced and its links stay
reset role;
insert into public.checklist_templates (id, name, claim_type, insurer_id, is_active)
values ('3c000000-0000-4000-8000-00000000000c', 'K Garage visit', 'motor', '2c000000-0000-4000-8000-000000000001', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000c');
select results_eq($$select checklist_template_id::text, (select is_active from public.checklist_templates where id = l.checklist_template_id)
                      from public.case_template_checklists l where template_id = (select id from t_ct)$$,
    $$values ('3c000000-0000-4000-8000-00000000000b'::text, true)$$, 'insurer-specific copy does not replace or re-point the all-insurers checklist');

-- a case template that already links the new checklist: old link dropped, is_default carried over
reset role;
insert into public.case_template_checklists (template_id, checklist_template_id, is_default)
values ((select id from t_ct), '3c000000-0000-4000-8000-00000000000a', false);
update public.case_template_checklists set is_default = false
 where template_id = (select id from t_ct) and checklist_template_id = '3c000000-0000-4000-8000-00000000000a';
set local role authenticated;
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$select public.activate_checklist_template('3c000000-0000-4000-8000-00000000000a')$$, 'admin puts A back in use');
select results_eq($$select checklist_template_id::text, is_default from public.case_template_checklists where template_id = (select id from t_ct)$$,
    $$values ('3c000000-0000-4000-8000-00000000000a'::text, true)$$, 'duplicate link merged into one, default kept');
reset role;

-- =====================================================================
-- updated_at
-- =====================================================================
update public.checklist_templates set updated_at = now() - interval '1 day' where id = '3c000000-0000-4000-8000-00000000000b';
update public.checklist_templates set name = 'K Garage visit old' where id = '3c000000-0000-4000-8000-00000000000b';
select is((select updated_at from public.checklist_templates where id = '3c000000-0000-4000-8000-00000000000b'), now(),
    'updated_at set on update');

-- =====================================================================
-- Name 3-80
-- =====================================================================
select throws_ok($$insert into public.checklist_templates (name, claim_type, is_active) values ('ab', 'other', false)$$,
    '23514', null::text, 'name under 3 characters rejected');
select throws_ok($$insert into public.checklist_templates (name, claim_type, is_active) values ('  ab  ', 'other', false)$$,
    '23514', null::text, 'name is trimmed before the length check');
select throws_ok(format($$insert into public.checklist_templates (name, claim_type, is_active) values (%L, 'other', false)$$, repeat('x', 81)),
    '23514', null::text, 'name over 80 characters rejected');
select lives_ok(format($$insert into public.checklist_templates (name, claim_type, is_active) values ('abc', 'other', false), (%L, 'other', false)$$, repeat('x', 80)),
    'names of 3 and 80 characters accepted');
set local role authenticated;
set local request.jwt.claims to '{"sub":"1c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok($$select * from public.save_checklist_template(null, null, 'ab', 'other', null, '[{"description":"Item one"}]')$$,
    '22023', 'Checklist name must be 3-80 characters', 'save rejects a 2-character name');
select throws_ok(format($$select * from public.save_checklist_template(null, null, %L, 'other', null, '[{"description":"Item one"}]')$$, repeat('y', 81)),
    '22023', 'Checklist name must be 3-80 characters', 'save rejects an 81-character name');
reset role;

select * from finish();
rollback;
