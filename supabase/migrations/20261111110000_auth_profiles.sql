-- =====================================================================
-- Auth wiring (M1 1.2): every auth.users row gets a public.profiles row.
--
-- Role comes ONLY from raw_app_meta_data (app_metadata), which only the
-- service role / admin API can write. raw_user_meta_data (user_metadata) is
-- writable by the user themself and is never trusted for role or status.
--
-- Default when app_metadata.role is missing or invalid: role = 'field',
-- is_active = false. 'field' is the least-privileged role and an inactive
-- profile gets no access at all (private.current_user_role() returns null),
-- so a user created by mistake, or by any future signup path, can see
-- nothing until an admin explicitly assigns a role and activates them.
--
-- After creation, public.profiles is the source of truth for role and
-- is_active (admins edit it under RLS). The only later sync from auth is:
--   * app_metadata.role set for the first time on a profile that was
--     created without one (the admin API writes app_metadata in a separate
--     UPDATE after the INSERT on some code paths) -> role applied + activated;
--   * phone number changes -> profiles.phone.
-- =====================================================================

create or replace function private.app_role_from_meta(p_meta jsonb) returns public.user_role
language sql immutable set search_path = '' as $$
    select case when p_meta->>'role' in ('admin','orchestrator','office','field')
                then (p_meta->>'role')::public.user_role end;
$$;

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_role public.user_role := private.app_role_from_meta(new.raw_app_meta_data);
begin
    insert into public.profiles (id, full_name, phone, role, region, is_active)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_app_meta_data->>'full_name'), ''),
                 nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                 new.email::text, new.phone::text, 'Unnamed user'),
        nullif(new.phone::text, ''),
        coalesce(v_role, 'field'),
        nullif(trim(new.raw_app_meta_data->>'region'), ''),
        v_role is not null
    )
    on conflict (id) do nothing;
    return new;
end $$;

create or replace function private.handle_auth_user_updated() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_old_role public.user_role := private.app_role_from_meta(old.raw_app_meta_data);
    v_new_role public.user_role := private.app_role_from_meta(new.raw_app_meta_data);
begin
    if v_old_role is null and v_new_role is not null then
        update public.profiles
           set role = v_new_role,
               is_active = true,
               full_name = coalesce(nullif(trim(new.raw_app_meta_data->>'full_name'), ''), full_name),
               region    = coalesce(nullif(trim(new.raw_app_meta_data->>'region'), ''), region)
         where id = new.id;
    end if;
    if new.phone is distinct from old.phone then
        update public.profiles set phone = nullif(new.phone::text, '') where id = new.id;
    end if;
    return new;
end $$;

revoke all on function private.app_role_from_meta(jsonb)    from public, anon, authenticated;
revoke all on function private.handle_new_auth_user()       from public, anon, authenticated;
revoke all on function private.handle_auth_user_updated()   from public, anon, authenticated;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function private.handle_new_auth_user();

create trigger on_auth_user_updated
    after update of raw_app_meta_data, phone on auth.users
    for each row execute function private.handle_auth_user_updated();
