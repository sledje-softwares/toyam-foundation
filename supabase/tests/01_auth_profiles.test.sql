-- Profile creation from auth.users (migration 20261111110000_auth_profiles)
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 -- role in app_metadata; user_metadata tries to claim admin
 ('00000000-0000-0000-0000-000000000000', '90000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'p1@example.com', null, '{"provider":"email","role":"office","full_name":"Paula One","region":"Pune"}', '{"role":"admin","full_name":"Fake"}'),
 -- only user_metadata role
 ('00000000-0000-0000-0000-000000000000', '90000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
  'p2@example.com', null, '{"provider":"email"}', '{"role":"admin"}'),
 -- invalid app_metadata role, phone user
 ('00000000-0000-0000-0000-000000000000', '90000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
  null, '919844444444', '{"provider":"phone","role":"superuser"}', '{}');

select is((select role::text from public.profiles where id = '90000000-0000-4000-8000-000000000001'), 'office',
    'role taken from app_metadata');
select is((select role::text || '/' || is_active from public.profiles where id = '90000000-0000-4000-8000-000000000001'),
    'office/true', 'user_metadata role is ignored; profile active');
select is((select full_name || '/' || region from public.profiles where id = '90000000-0000-4000-8000-000000000001'),
    'Paula One/Pune', 'full_name and region from app_metadata');
select is((select role::text || '/' || is_active from public.profiles where id = '90000000-0000-4000-8000-000000000002'),
    'field/false', 'no app_metadata role -> least-privileged, inactive');
select is((select role::text || '/' || is_active from public.profiles where id = '90000000-0000-4000-8000-000000000003'),
    'field/false', 'invalid app_metadata role -> least-privileged, inactive');
select is((select phone from public.profiles where id = '90000000-0000-4000-8000-000000000003'), '919844444444',
    'phone copied to profile');

-- User edits own user_metadata: no effect on role
update auth.users set raw_user_meta_data = '{"role":"admin"}' where id = '90000000-0000-4000-8000-000000000002';
select is((select role::text || '/' || is_active from public.profiles where id = '90000000-0000-4000-8000-000000000002'),
    'field/false', 'changing user_metadata does not grant a role');

-- Inactive user gets nothing
set local role authenticated;
set local request.jwt.claims to '{"sub":"90000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.is_staff(), false, 'inactive user is not staff');
select is_empty($$select 1 from public.cases$$, 'inactive user sees no cases');
select results_eq($$select id from public.profiles$$, $$values ('90000000-0000-4000-8000-000000000002'::uuid)$$,
    'inactive user can still read own profile (to show "not active")');
reset role;
set local request.jwt.claims to '';

-- Admin API sets app_metadata.role after creation (first time) -> applied and activated
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"orchestrator"}'
 where id = '90000000-0000-4000-8000-000000000002';
select is((select role::text || '/' || is_active from public.profiles where id = '90000000-0000-4000-8000-000000000002'),
    'orchestrator/true', 'first app_metadata role assignment is applied');

-- Later app_metadata changes do not override profiles (profiles is the source of truth)
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
 where id = '90000000-0000-4000-8000-000000000001';
select is((select role::text from public.profiles where id = '90000000-0000-4000-8000-000000000001'), 'office',
    'later app_metadata role change does not override the profile');

-- Phone change syncs
update auth.users set phone = '919855555555' where id = '90000000-0000-4000-8000-000000000003';
select is((select phone from public.profiles where id = '90000000-0000-4000-8000-000000000003'), '919855555555',
    'phone change synced to profile');

-- Deleting the auth user removes the profile
delete from auth.users where id = '90000000-0000-4000-8000-000000000003';
select is_empty($$select 1 from public.profiles where id = '90000000-0000-4000-8000-000000000003'$$,
    'profile removed with auth user');

select * from finish();
rollback;
