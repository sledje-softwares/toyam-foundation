-- D42. Checklist activation re-points case templates; checklist name length 3-80.
--
-- 1. activate_checklist_template(p_id) takes out of use every in-use checklist with the same
--    claim type, the same insurer scope (insurer_id, null = all insurers) and the same name
--    (case-insensitive) — the scope of uq_active_template. In the same transaction it now moves
--    case_template_checklists links from those checklists to p_id, so new cases from linked case
--    templates get the new items at once. Each moved link is written to audit_log
--    (action CHECKLIST_REPOINTED, table case_template_checklists, record_id = case template id).
--    task_checklist_items are copies and are not touched.
-- 2. checklist_templates.updated_at and trg_checklist_templates_updated (public.set_updated_at)
--    already exist since 20261111000000; nothing to add (covered by tests/12).
-- 3. Name length 3-80 (matches the web form), as a check constraint and in save_checklist_template.

-- ---------------------------------------------------------------------
-- 3. Name length
-- ---------------------------------------------------------------------
alter table public.checklist_templates
    add constraint ct_name_len check (char_length(btrim(name)) between 3 and 80);

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
    v_cat uuid;
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can save checklists' using errcode = '42501';
    end if;
    if p_name is null or char_length(btrim(p_name)) not between 3 and 80 then
        raise exception 'Checklist name must be 3-80 characters' using errcode = '22023';
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

        delete from public.checklist_template_items i
         where i.template_id = v_id
           and i.id not in (select (e->>'id')::uuid from jsonb_array_elements(p_items) e
                             where e->>'id' is not null);
        update public.checklist_template_items i set position = i.position + 100000
         where i.template_id = v_id;
    end if;

    for v_item, v_ord in select e, o::int from jsonb_array_elements(p_items) with ordinality as x(e, o) loop
        v_item_id := nullif(v_item->>'id', '')::uuid;
        v_cat     := nullif(v_item->>'category_id', '')::uuid;
        if v_item_id is not null then
            update public.checklist_template_items i
               set position = v_ord,
                   description = btrim(v_item->>'description'),
                   required_evidence_type = coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                   is_mandatory = coalesce((v_item->>'is_mandatory')::boolean, true),
                   camera_only = coalesce((v_item->>'camera_only')::boolean, false),
                   category_id = v_cat
             where i.id = v_item_id and i.template_id = v_id;
            if not found then
                raise exception 'Item % does not belong to this checklist', v_item_id using errcode = '22023';
            end if;
        else
            insert into public.checklist_template_items
                (template_id, position, description, required_evidence_type, is_mandatory, camera_only, category_id)
            values (v_id, v_ord, btrim(v_item->>'description'),
                    coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                    coalesce((v_item->>'is_mandatory')::boolean, true),
                    coalesce((v_item->>'camera_only')::boolean, false),
                    v_cat);
        end if;
    end loop;

    return query select v_id, v_version;
end $$;

-- ---------------------------------------------------------------------
-- 1. Audit helper for a moved link (case_template_checklists has no id column, so no audit_row trigger)
-- ---------------------------------------------------------------------
create or replace function private.audit_checklist_repoint(
    p_case_template uuid, p_old_checklist uuid, p_new_checklist uuid, p_is_default boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can change checklists' using errcode = '42501';
    end if;
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (auth.uid(), 'CHECKLIST_REPOINTED', 'case_template_checklists', p_case_template,
            jsonb_build_object('template_id', p_case_template, 'checklist_template_id', p_old_checklist),
            jsonb_build_object('template_id', p_case_template, 'checklist_template_id', p_new_checklist,
                               'is_default', p_is_default));
end $$;
revoke execute on function private.audit_checklist_repoint(uuid, uuid, uuid, boolean) from public, anon;
grant  execute on function private.audit_checklist_repoint(uuid, uuid, uuid, boolean) to authenticated, service_role;

create or replace function public.activate_checklist_template(p_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
    v public.checklist_templates;
    v_old uuid[];
    r record;
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can change checklists' using errcode = '42501';
    end if;
    select * into v from public.checklist_templates t where t.id = p_id for update;
    if not found then
        raise exception 'Checklist not found' using errcode = 'P0002';
    end if;

    -- replaced = in use, same claim type, same insurer scope, same name (case-insensitive)
    with off as (
        update public.checklist_templates t set is_active = false
         where t.is_active and t.id <> p_id and t.claim_type = v.claim_type
           and t.insurer_id is not distinct from v.insurer_id and lower(t.name) = lower(v.name)
        returning t.id)
    select coalesce(array_agg(off.id), '{}') into v_old from off;
    update public.checklist_templates t set is_active = true where t.id = p_id;

    if cardinality(v_old) = 0 then
        return;
    end if;

    -- move each case-template link from a replaced checklist to p_id (one link per case template;
    -- if it already links p_id the old link is dropped and is_default carried over)
    for r in
        select l.template_id, l.checklist_template_id, l.is_default
          from public.case_template_checklists l
         where l.checklist_template_id = any (v_old)
         order by l.template_id, l.checklist_template_id
           for update
    loop
        if exists (select 1 from public.case_template_checklists l
                    where l.template_id = r.template_id and l.checklist_template_id = p_id) then
            update public.case_template_checklists l set is_default = l.is_default or r.is_default
             where l.template_id = r.template_id and l.checklist_template_id = p_id;
            delete from public.case_template_checklists l
             where l.template_id = r.template_id and l.checklist_template_id = r.checklist_template_id;
        else
            update public.case_template_checklists l set checklist_template_id = p_id
             where l.template_id = r.template_id and l.checklist_template_id = r.checklist_template_id;
        end if;
        perform private.audit_checklist_repoint(r.template_id, r.checklist_template_id, p_id, r.is_default);
    end loop;
end $$;
revoke execute on function public.activate_checklist_template(uuid) from public, anon;
grant  execute on function public.activate_checklist_template(uuid) to authenticated, service_role;
