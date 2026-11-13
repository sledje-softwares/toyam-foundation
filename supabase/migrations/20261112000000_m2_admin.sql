-- =====================================================================
-- M2 Administration & master data (docs/08-m2-admin-design.md §4.1, DB1-DB11)
--   DB1  admin_list_users()            profile + sign-in details for admins
--   DB2  last-active-admin guard       profiles
--   DB3  insurer code / TAT / domains  insurers
--   DB4  report-templates bucket       storage
--   DB5  checklist_templates.version
--   DB6  task copy link survives template item deletion
--   DB7  checklist item checks
--   DB8  several checklists per claim type (unique by name)
--   DB9  save_checklist_template()     atomic editor save
--   DB10 activate_checklist_template() atomic swap
--   DB11 audit triggers on checklist tables
-- =====================================================================

-- ---------------------------------------------------------------------
-- DB1. admin_list_users
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users(p_user_id uuid default null)
returns table (
    id uuid, full_name text, role public.user_role, region text, is_active boolean,
    profile_phone text, created_at timestamptz, updated_at timestamptz,
    email text, phone text, last_sign_in_at timestamptz, banned_until timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can list users' using errcode = '42501';
    end if;
    return query
        select p.id, p.full_name, p.role, p.region, p.is_active, p.phone,
               p.created_at, p.updated_at,
               u.email::text, u.phone::text, u.last_sign_in_at, u.banned_until
          from public.profiles p
          join auth.users u on u.id = p.id
         where p_user_id is null or p.id = p_user_id
         order by p.full_name;
end $$;
revoke execute on function public.admin_list_users(uuid) from public, anon;
grant  execute on function public.admin_list_users(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- DB2. There must always be at least one active admin
-- ---------------------------------------------------------------------
create or replace function private.guard_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if old.role = 'admin' and old.is_active
       and (tg_op = 'DELETE' or new.role <> 'admin' or not new.is_active) then
        perform pg_advisory_xact_lock(hashtext('profiles_last_admin'));
        if not exists (select 1 from public.profiles p
                        where p.role = 'admin' and p.is_active and p.id <> old.id) then
            raise exception 'There must be at least one active admin' using errcode = '42501';
        end if;
    end if;
    return coalesce(new, old);
end $$;
revoke all on function private.guard_last_admin() from public, anon, authenticated;

create trigger trg_profiles_last_admin before update or delete on public.profiles
    for each row execute function private.guard_last_admin();

-- ---------------------------------------------------------------------
-- DB3. Insurer rules
-- ---------------------------------------------------------------------
alter table public.insurers
    add constraint insurers_code_format check (code ~ '^[A-Z0-9]{2,10}$'),
    add constraint insurers_tat_max check (tat_days <= 365);

create or replace function private.insurers_normalise_domains() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_dom text;
    v_other text;
begin
    new.sender_domains := coalesce((
        select array_agg(d::public.citext order by d)
          from (select distinct lower(btrim(x::text)) as d
                  from unnest(new.sender_domains) x
                 where btrim(x::text) <> '') s
    ), '{}'::public.citext[]);
    foreach v_dom in array new.sender_domains::text[] loop
        select i.name into v_other
          from public.insurers i
         where i.id <> new.id and v_dom = any (i.sender_domains::text[])
         limit 1;
        if found then
            raise exception 'Domain % is already used by %', v_dom, v_other using errcode = '23505';
        end if;
    end loop;
    return new;
end $$;
revoke all on function private.insurers_normalise_domains() from public, anon, authenticated;

create trigger trg_insurers_domains before insert or update on public.insurers
    for each row execute function private.insurers_normalise_domains();

-- ---------------------------------------------------------------------
-- DB4. report-templates bucket (admin writes, staff read, no delete)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-templates', 'report-templates', false, 10485760,
        array['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
    set public = excluded.public, file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

create policy report_templates_staff_select on storage.objects for select to authenticated
    using (bucket_id = 'report-templates' and public.is_staff());
create policy report_templates_admin_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'report-templates' and public.is_admin());
create policy report_templates_admin_update on storage.objects for update to authenticated
    using (bucket_id = 'report-templates' and public.is_admin())
    with check (bucket_id = 'report-templates' and public.is_admin());

-- ---------------------------------------------------------------------
-- DB5-DB8. Checklist templates
-- ---------------------------------------------------------------------
alter table public.checklist_templates add column version int not null default 1;

alter table public.task_checklist_items
    drop constraint task_checklist_items_source_template_item_id_fkey,
    add constraint task_checklist_items_source_template_item_id_fkey
        foreign key (source_template_item_id) references public.checklist_template_items(id) on delete set null;

alter table public.checklist_template_items
    add constraint cti_description_len check (char_length(btrim(description)) between 3 and 200),
    add constraint cti_camera_not_note check (not (camera_only and required_evidence_type = 'note'));

drop index public.uq_active_template;
create unique index uq_active_template
    on public.checklist_templates (claim_type,
                                   coalesce(insurer_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                   lower(name))
    where is_active;

-- ---------------------------------------------------------------------
-- DB9. save_checklist_template
-- p_items: ordered json array of {id?, description, required_evidence_type,
-- is_mandatory, camera_only}. p_template_id null = create (not in use).
-- ---------------------------------------------------------------------
create or replace function public.save_checklist_template(
    p_template_id uuid, p_expected_version int, p_name text, p_claim_type public.claim_type,
    p_insurer_id uuid, p_items jsonb)
returns table (id uuid, version int)
language plpgsql security invoker set search_path = '' as $$
declare
    v_id uuid := p_template_id;
    v_version int;
    v_n int;
    v_item jsonb;
    v_ord int;
    v_item_id uuid;
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can save checklists' using errcode = '42501';
    end if;
    if p_name is null or char_length(btrim(p_name)) not between 2 and 100 then
        raise exception 'Checklist name must be 2-100 characters' using errcode = '22023';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' then
        raise exception 'Items must be a JSON array' using errcode = '22023';
    end if;
    v_n := jsonb_array_length(p_items);
    if v_n not between 1 and 50 then
        raise exception 'A checklist needs 1 to 50 items' using errcode = '22023';
    end if;

    if v_id is null then
        insert into public.checklist_templates (name, claim_type, insurer_id, is_active)
        values (btrim(p_name), p_claim_type, p_insurer_id, false)
        returning checklist_templates.id, checklist_templates.version into v_id, v_version;
    else
        select t.version into v_version from public.checklist_templates t where t.id = v_id for update;
        if not found then
            raise exception 'Checklist not found' using errcode = 'P0002';
        end if;
        if v_version is distinct from p_expected_version then
            raise exception 'This checklist was changed by someone else (version % now, expected %)',
                v_version, p_expected_version using errcode = '40001';
        end if;
        update public.checklist_templates t
           set name = btrim(p_name), claim_type = p_claim_type, insurer_id = p_insurer_id,
               version = t.version + 1
         where t.id = v_id
        returning t.version into v_version;

        -- remove items not in the payload
        delete from public.checklist_template_items i
         where i.template_id = v_id
           and i.id not in (select (e->>'id')::uuid from jsonb_array_elements(p_items) e
                             where e->>'id' is not null);
        -- park kept items out of the way of the unique (template_id, position)
        update public.checklist_template_items i set position = i.position + 100000
         where i.template_id = v_id;
    end if;

    for v_item, v_ord in select e, o::int from jsonb_array_elements(p_items) with ordinality as x(e, o) loop
        v_item_id := nullif(v_item->>'id', '')::uuid;
        if v_item_id is not null then
            update public.checklist_template_items i
               set position = v_ord,
                   description = btrim(v_item->>'description'),
                   required_evidence_type = coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                   is_mandatory = coalesce((v_item->>'is_mandatory')::boolean, true),
                   camera_only = coalesce((v_item->>'camera_only')::boolean, false)
             where i.id = v_item_id and i.template_id = v_id;
            if not found then
                raise exception 'Item % does not belong to this checklist', v_item_id using errcode = '22023';
            end if;
        else
            insert into public.checklist_template_items
                (template_id, position, description, required_evidence_type, is_mandatory, camera_only)
            values (v_id, v_ord, btrim(v_item->>'description'),
                    coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                    coalesce((v_item->>'is_mandatory')::boolean, true),
                    coalesce((v_item->>'camera_only')::boolean, false));
        end if;
    end loop;

    return query select v_id, v_version;
end $$;
revoke execute on function public.save_checklist_template(uuid, int, text, public.claim_type, uuid, jsonb) from public, anon;
grant  execute on function public.save_checklist_template(uuid, int, text, public.claim_type, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- DB10. activate_checklist_template
-- ---------------------------------------------------------------------
create or replace function public.activate_checklist_template(p_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare v public.checklist_templates;
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can change checklists' using errcode = '42501';
    end if;
    select * into v from public.checklist_templates t where t.id = p_id for update;
    if not found then
        raise exception 'Checklist not found' using errcode = 'P0002';
    end if;
    update public.checklist_templates t set is_active = false
     where t.is_active and t.id <> p_id and t.claim_type = v.claim_type
       and t.insurer_id is not distinct from v.insurer_id and lower(t.name) = lower(v.name);
    update public.checklist_templates t set is_active = true where t.id = p_id;
end $$;
revoke execute on function public.activate_checklist_template(uuid) from public, anon;
grant  execute on function public.activate_checklist_template(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- DB11. Audit trail for checklists
-- ---------------------------------------------------------------------
create trigger trg_checklist_templates_audit after insert or update or delete on public.checklist_templates
    for each row execute function private.audit_row();
create trigger trg_checklist_template_items_audit after insert or update or delete on public.checklist_template_items
    for each row execute function private.audit_row();
