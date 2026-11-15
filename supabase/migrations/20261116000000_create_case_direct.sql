-- =====================================================================
-- Direct case creation by office staff (D49; web /cases/new)
--
--   create_case_direct(p_template_id, p_values, p_owner_id, p_note) -> (case_id, case_ref)
--
-- A case that did not arrive by email (phone call, insurer portal, walk-in) is created from the
-- active template of its insurer x claim type x variant (D20), like a confirmed intake:
--   * caller is staff. Office: the owner is always the caller (D44/D49; another p_owner_id is
--     refused). Orchestrator / admin: an active office / orchestrator / admin owner, or null to run
--     the automatic assignment (D40, trg_cases_after_insert_assign -> private.auto_assign_case).
--   * the template must be active and its insurer active; insurer and claim type come from it.
--   * p_values {"<intake field key>": "<text>" | null}: keys must be intake fields of the template
--     (insurer_claim_no is always accepted, it is required for every case); every required intake
--     field filled; values are text of at most 20000 characters (trimmed, CRLF -> LF).
--   * duplicate (insurer_id, insurer_claim_no) is refused (23505) naming the existing case ref only
--     when the caller may see that case (private.can_manage_case), else a generic message.
--   * case: case_ref, due_at (insurer TAT), status history from the cases triggers; created_by =
--     caller; policy_no / suspicion_summary / parties from the values as create_case_from_intake does.
--     Chosen owner: inserted as assigned (manual), the insert trigger writes the case_assignments row,
--     the owner is notified when it is not the caller. Automatic: the insert trigger assigns and
--     notifies (or alerts the orchestrators when no one is available).
--   * field values with source 'office'; staff-only system message "Case created by <name>" and the
--     optional note as a staff-only message from the caller (D32); audit_log row CASE_CREATED.
-- =====================================================================

create or replace function public.create_case_direct(p_template_id uuid, p_values jsonb,
                                                     p_owner_id uuid default null, p_note text default null)
returns table (case_id uuid, case_ref text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
    v_uid      uuid := (select auth.uid());
    v_role     public.user_role := private.current_user_role();
    v_tpl      public.case_templates;
    v_owner    uuid;
    v_mode     text;
    v_vals     jsonb := '{}';
    v_key      text;
    v_raw      jsonb;
    v_value    text;
    v_claim    text;
    v_missing  text;
    v_existing public.cases;
    v_note     text := nullif(btrim(replace(coalesce(p_note, ''), E'\r\n', E'\n'), E' \t\r\n'), '');
    v_case     uuid;
    v_ref      text;
    v_name     text;
    v_val      text;
    v_creator  text;
    v_ownname  text;
begin
    if coalesce(v_role not in ('office', 'orchestrator', 'admin'), true) then
        raise exception 'Only office staff can create cases' using errcode = '42501';
    end if;

    -- owner
    if v_role = 'office' then
        if p_owner_id is not null and p_owner_id <> v_uid then
            raise exception 'Office employees create cases for themselves only' using errcode = '42501';
        end if;
        v_owner := v_uid; v_mode := 'self';
    elsif p_owner_id is null then
        v_owner := null; v_mode := 'auto';
    else
        if not exists (select 1 from public.profiles p where p.id = p_owner_id and p.is_active
                         and p.role in ('office', 'orchestrator', 'admin')) then
            raise exception 'The owner must be an active office, orchestrator or admin user' using errcode = '22023';
        end if;
        v_owner := p_owner_id; v_mode := case when p_owner_id = v_uid then 'self' else 'chosen' end;
    end if;

    -- template
    select t.* into v_tpl from public.case_templates t join public.insurers i on i.id = t.insurer_id
     where t.id = p_template_id and t.is_active and i.is_active;
    if not found then
        raise exception 'Choose a template that is in use' using errcode = '22023';
    end if;

    -- values
    if p_values is null or jsonb_typeof(p_values) <> 'object' then
        raise exception 'Values must be a JSON object' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(p_values)) > 300 then
        raise exception 'Too many fields' using errcode = '22023';
    end if;
    for v_key, v_raw in select * from jsonb_each(p_values) loop
        if v_key <> 'insurer_claim_no' and not exists (
            select 1 from public.case_template_fields f
             where f.template_id = v_tpl.id and f.key = v_key and f.source = 'intake') then
            raise exception 'Unknown field: %', left(v_key, 80) using errcode = '22023';
        end if;
        if jsonb_typeof(v_raw) not in ('string', 'null') then
            raise exception 'Value of % must be text', left(v_key, 80) using errcode = '22023';
        end if;
        v_value := nullif(btrim(replace(coalesce(v_raw #>> '{}', ''), E'\r\n', E'\n'), E' \t\r\n'), '');
        if char_length(v_value) > 20000 then
            raise exception 'Value of % is too long', left(v_key, 80) using errcode = '22023';
        end if;
        if v_value is not null then
            v_vals := v_vals || jsonb_build_object(v_key, v_value);
        end if;
    end loop;

    v_claim := v_vals ->> 'insurer_claim_no';
    if v_claim is null then
        raise exception 'The claim number is required' using errcode = '22023';
    end if;
    if char_length(v_claim) > 200 then
        raise exception 'The claim number is too long' using errcode = '22023';
    end if;
    select string_agg(f.label, ', ' order by s.position, f.position) into v_missing
      from public.case_template_fields f
      join public.case_template_sections s on s.id = f.section_id
     where f.template_id = v_tpl.id and f.source = 'intake' and f.is_required and not (v_vals ? f.key);
    if v_missing is not null then
        raise exception 'Required fields are empty: %', left(v_missing, 300) using errcode = '22023';
    end if;
    if char_length(v_note) > 4000 then
        raise exception 'The note can be at most 4000 characters' using errcode = '22023';
    end if;

    -- duplicate claim (readable message; the unique constraint still decides under a race)
    select c.* into v_existing from public.cases c
     where c.insurer_id = v_tpl.insurer_id and c.insurer_claim_no = v_claim;
    if found then
        if private.can_manage_case(v_existing.id) then
            raise exception 'Case % already has claim number % for this insurer', v_existing.case_ref, v_claim
                using errcode = '23505';
        end if;
        raise exception 'A case with claim number % already exists for this insurer', v_claim using errcode = '23505';
    end if;

    begin
        insert into public.cases (insurer_id, insurer_claim_no, policy_no, claim_type, suspicion_summary, received_at,
                                  template_id, created_by, office_owner_id, assignment_method, office_assigned_at, status)
        values (v_tpl.insurer_id, v_claim, v_vals ->> 'policy_no', v_tpl.claim_type,
                nullif(left(coalesce(v_vals ->> 'investigation_points', ''), 4000), ''),
                now(), v_tpl.id, v_uid, v_owner,
                case when v_owner is not null then 'manual' end,
                case when v_owner is not null then now() end,
                case when v_owner is not null then 'assigned' else 'received' end::public.case_status)
        returning id, case_ref into v_case, v_ref;
    exception when unique_violation then
        raise exception 'A case with claim number % already exists for this insurer', v_claim using errcode = '23505';
    end;
    -- the insert trigger auto-assigned (owner null) or recorded the chosen owner in case_assignments

    insert into public.case_field_values (case_id, field_id, value, source)
    select v_case, f.id, v_vals ->> f.key, 'office'
      from public.case_template_fields f
     where f.template_id = v_tpl.id and (v_vals ? f.key);

    v_name := v_vals ->> 'insured_name';
    if v_name is not null then
        insert into public.parties (case_id, role, name, phone, address)
        values (v_case, 'insured', left(v_name, 300), left(v_vals ->> 'insured_mobile', 100),
                coalesce(v_vals ->> 'policy_address', v_vals ->> 'insured_actual_address'));
    end if;
    v_val := v_vals ->> 'driver_name';
    if v_val is not null and v_val is distinct from v_name then
        insert into public.parties (case_id, role, name) values (v_case, 'driver', left(v_val, 300));
    end if;

    select p.full_name into v_creator from public.profiles p where p.id = v_uid;
    if v_mode = 'chosen' then
        select p.full_name into v_ownname from public.profiles p where p.id = v_owner;
        perform private.post_system_message(v_case,
            'Case created by ' || coalesce(v_creator, 'staff') || ' and assigned to ' || coalesce(v_ownname, 'staff'),
            null, 'system', null, 'staff');
        perform private.notify(v_owner, 'case_assigned', v_case, 'New case assigned to you',
                               'Created by ' || coalesce(v_creator, 'staff'), 'case_assigned:' || v_case);
    else
        perform private.post_system_message(v_case, 'Case created by ' || coalesce(v_creator, 'staff'),
                                            null, 'system', null, 'staff');
    end if;
    if v_note is not null then
        insert into public.case_messages (case_id, sender_id, kind, body, visibility)
        values (v_case, v_uid, 'text', v_note, 'staff');
    end if;

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (v_uid, 'CASE_CREATED', 'cases', v_case, null,
            jsonb_build_object('case_ref', v_ref, 'template_id', v_tpl.id, 'insurer_claim_no', v_claim,
                               'assignment', v_mode,
                               'office_owner_id', (select c.office_owner_id from public.cases c where c.id = v_case),
                               'fields', (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(v_vals) k),
                               'note', v_note is not null));

    return query select v_case, v_ref;
end $$;

revoke all on function public.create_case_direct(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.create_case_direct(uuid, jsonb, uuid, text) to authenticated;
