-- M2 admin: admin_list_users, last-admin guard, insurer rules, report-templates bucket,
-- checklist template rules and RPCs, audit. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a1','authenticated','authenticated','m-admin@example.com',null,'{"role":"admin","full_name":"M Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a2','authenticated','authenticated','m-orch@example.com',null,'{"role":"orchestrator","full_name":"M Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000a3','authenticated','authenticated','m-office@example.com',null,'{"role":"office","full_name":"M Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919844444444','{"role":"field","full_name":"M Field"}','{}');

-- =====================================================================
-- DB1 admin_list_users
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok($$select * from public.admin_list_users()$$, '42501', null::text, 'office cannot call admin_list_users');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok($$select * from public.admin_list_users()$$, '42501', null::text, 'orchestrator cannot call admin_list_users');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select * from public.admin_list_users()$$, '42501', null::text, 'field cannot call admin_list_users');
reset role;
set local role anon;
select throws_ok($$select * from public.admin_list_users()$$, '42501', null::text, 'anon cannot call admin_list_users');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select results_eq($$select email, phone, role::text from public.admin_list_users('10000000-0000-4000-8000-0000000000a3')$$,
    $$values ('m-office@example.com'::text, null::text, 'office')$$, 'admin gets email and role for one user');
select is((select phone from public.admin_list_users('10000000-0000-4000-8000-0000000000f1')), '919844444444', 'admin gets mobile');
select cmp_ok((select count(*) from public.admin_list_users()), '>=', 4::bigint, 'admin lists all users');
reset role;

-- =====================================================================
-- DB2 last active admin
-- =====================================================================
update public.profiles set is_active = false
 where role = 'admin' and id <> '10000000-0000-4000-8000-0000000000a1';   -- allowed: fixture admin remains
select is((select count(*)::int from public.profiles where role = 'admin' and is_active), 1, 'fixture admin is the only active admin');
select throws_ok($$update public.profiles set is_active = false where id = '10000000-0000-4000-8000-0000000000a1'$$,
    '42501', 'There must be at least one active admin', 'cannot deactivate the last admin');
select throws_ok($$update public.profiles set role = 'office' where id = '10000000-0000-4000-8000-0000000000a1'$$,
    '42501', 'There must be at least one active admin', 'cannot demote the last admin');
select throws_ok($$delete from public.profiles where id = '10000000-0000-4000-8000-0000000000a1'$$,
    '42501', 'There must be at least one active admin', 'cannot delete the last admin');
select lives_ok($$update public.profiles set role = 'admin' where id = '10000000-0000-4000-8000-0000000000a2'$$, 'second admin can be added');
select lives_ok($$update public.profiles set is_active = false where id = '10000000-0000-4000-8000-0000000000a1'$$,
    'an admin can be deactivated when another is active');
update public.profiles set is_active = true where id = '10000000-0000-4000-8000-0000000000a1';
update public.profiles set role = 'orchestrator' where id = '10000000-0000-4000-8000-0000000000a2';

-- =====================================================================
-- DB3 insurers
-- =====================================================================
insert into public.insurers (id, name, code, sender_domains) values
 ('20000000-0000-4000-8000-000000000001', 'M Insurer One', 'MI1', '{" Foo.Example ","BAR.example","foo.example"}');
select results_eq($$select sender_domains::text[] from public.insurers where code = 'MI1'$$,
    $$values (array['bar.example','foo.example']::text[])$$, 'domains trimmed, lower-cased, de-duplicated, sorted');
select throws_ok($$insert into public.insurers (name, code, sender_domains) values ('M Insurer Two', 'MI2', '{FOO.example}')$$,
    '23505', 'Domain foo.example is already used by M Insurer One', 'cross-insurer domain duplicate names the insurer');
select lives_ok($$update public.insurers set tat_days = 20 where code = 'MI1'$$, 'own domains do not clash on update');
select throws_ok($$insert into public.insurers (name, code) values ('M Bad Code', 'ab')$$, '23514', null::text, 'lower-case code rejected');
select throws_ok($$insert into public.insurers (name, code) values ('M Bad Code 2', 'TOOLONGCODE1')$$, '23514', null::text, 'over-long code rejected');
select throws_ok($$insert into public.insurers (name, code, tat_days) values ('M Bad TAT', 'MBT', 366)$$, '23514', null::text, 'tat_days above 365 rejected');

-- =====================================================================
-- DB4 report-templates bucket
-- =====================================================================
select results_eq($$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'report-templates'$$,
    $$values (false, 10485760::bigint, array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']::text[])$$,
    'report-templates is private, 10 MiB, .docx only');
insert into storage.objects (bucket_id, name, owner_id) values ('report-templates', 'existing.docx', null);
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is((select count(*)::int from storage.objects where bucket_id = 'report-templates'), 1, 'office can read report templates');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('report-templates', 'o.docx', '10000000-0000-4000-8000-0000000000a3')$$,
    '42501', null::text, 'office cannot upload report templates');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('report-templates', 'a.docx', '10000000-0000-4000-8000-0000000000a1')$$,
    'admin can upload report templates');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'report-templates';
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'report-templates'), 2, 'report templates cannot be deleted through the API');

-- =====================================================================
-- DB5-DB8 checklist rules
-- =====================================================================
insert into public.checklist_templates (id, name, claim_type, is_active) values
 ('30000000-0000-4000-8000-000000000001', 'M Visit A', 'health', true),
 ('30000000-0000-4000-8000-000000000002', 'M Visit B', 'health', true);
select is((select version from public.checklist_templates where id = '30000000-0000-4000-8000-000000000001'), 1, 'version defaults to 1');
select throws_ok($$insert into public.checklist_templates (name, claim_type, is_active) values ('m visit a', 'health', true)$$,
    '23505', null::text, 'same name in the same scope cannot be in use twice');
select throws_ok($$insert into public.checklist_template_items (template_id, position, description) values ('30000000-0000-4000-8000-000000000001', 1, 'ab')$$,
    '23514', null::text, 'description shorter than 3 characters rejected');
select throws_ok($$insert into public.checklist_template_items (template_id, position, description, required_evidence_type, camera_only)
    values ('30000000-0000-4000-8000-000000000001', 1, 'Field notes', 'note', true)$$, '23514', null::text, 'camera-only note rejected');

-- DB6: deleting a template item used by a task copy
insert into public.checklist_template_items (id, template_id, position, description)
values ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 1, 'Front of building');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, status)
values ('32000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'M-1', 'health', 'assigned');
insert into public.tasks (id, case_id, title, assignee_id, status)
values ('33000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000001', 'MT', '10000000-0000-4000-8000-0000000000f1', 'pending');
insert into public.task_checklist_items (id, task_id, position, description, source_template_item_id)
values ('34000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000001', 1, 'Front of building', '31000000-0000-4000-8000-000000000001');
delete from public.checklist_template_items where id = '31000000-0000-4000-8000-000000000001';
select results_eq($$select source_template_item_id from public.task_checklist_items where id = '34000000-0000-4000-8000-000000000001'$$,
    $$values (null::uuid)$$, 'deleting a used template item clears the task copy link but keeps the copy');

-- =====================================================================
-- DB9 save_checklist_template (admin)
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok($$select * from public.save_checklist_template(null, null, 'X', 'health', null, '[{"description":"Item one"}]')$$,
    '42501', null::text, 'orchestrator cannot save checklists');
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
create temp table t_new on commit drop as
    select * from public.save_checklist_template(null, null, 'M New list', 'motor', null,
        '[{"description":"Item one"},{"description":"Item two","required_evidence_type":"document","is_mandatory":false},{"description":"Item three"}]');
grant all on t_new to authenticated;
select results_eq($$select version from t_new$$, $$values (1)$$, 'create returns version 1');
select is((select is_active from public.checklist_templates where id = (select id from t_new)), false, 'new template is not in use');

create temp table t_saved on commit drop as
    select * from public.save_checklist_template((select id from t_new), 1, 'M New list v2', 'motor', null,
        (select jsonb_build_array(
            jsonb_build_object('id', i3.id, 'description', 'Item three moved'),
            jsonb_build_object('description', 'Brand new item', 'camera_only', true),
            jsonb_build_object('id', i1.id, 'description', 'Item one kept'))
           from public.checklist_template_items i1, public.checklist_template_items i3
          where i1.template_id = (select id from t_new) and i1.position = 1
            and i3.template_id = (select id from t_new) and i3.position = 3));
grant all on t_saved to authenticated;
select results_eq($$select description from public.checklist_template_items where template_id = (select id from t_new) order by position$$,
    $$values ('Item three moved'::text), ('Brand new item'), ('Item one kept')$$, 'save reorders, inserts and deletes; renumbers 1..n');
select results_eq($$select array_agg(position order by position) from public.checklist_template_items where template_id = (select id from t_new)$$,
    $$values (array[1,2,3])$$, 'positions are contiguous');
select results_eq($$select version, (select name from public.checklist_templates where id = t_saved.id) from t_saved$$,
    $$values (2, 'M New list v2')$$, 'save bumps version and updates header');
select throws_ok($$select * from public.save_checklist_template((select id from t_new), 1, 'Stale', 'motor', null, '[{"description":"Item one"}]')$$,
    '40001', null::text, 'stale version rejected');
select throws_ok($$select * from public.save_checklist_template((select id from t_new), 2, 'Empty', 'motor', null, '[]')$$,
    '22023', null::text, 'zero items rejected');

-- =====================================================================
-- DB10 activate_checklist_template
-- =====================================================================
select lives_ok($$select public.activate_checklist_template('30000000-0000-4000-8000-000000000001')$$, 'activate on the in-use template is a no-op');
reset role;
insert into public.checklist_templates (id, name, claim_type, is_active)
values ('30000000-0000-4000-8000-000000000003', 'M Visit A', 'health', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select public.activate_checklist_template('30000000-0000-4000-8000-000000000003');
select results_eq($$select id::text, is_active from public.checklist_templates where lower(name) = 'm visit a' order by id$$,
    $$values ('30000000-0000-4000-8000-000000000001'::text, false), ('30000000-0000-4000-8000-000000000003', true)$$,
    'activate swaps the same-name template atomically');
select is((select is_active from public.checklist_templates where id = '30000000-0000-4000-8000-000000000002'), true,
    'activate leaves differently named checklists alone');
reset role;

-- =====================================================================
-- DB11 audit
-- =====================================================================
select cmp_ok((select count(*) from public.audit_log where table_name = 'checklist_templates'
                and actor_id = '10000000-0000-4000-8000-0000000000a1'), '>=', 3::bigint, 'template saves are audited with the admin as actor');
select cmp_ok((select count(*) from public.audit_log where table_name = 'checklist_template_items'
                and actor_id = '10000000-0000-4000-8000-0000000000a1'), '>=', 3::bigint, 'item changes are audited');

select * from finish();
rollback;
