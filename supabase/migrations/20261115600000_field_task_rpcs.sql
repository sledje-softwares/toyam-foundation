-- =====================================================================
-- Field task lifecycle RPCs and hardening (docs/12-office-pages/tasks.md, DB gaps 1-3; D43, D44)
--
--   0. private.can_manage_case(case) (D44) — created here only when the D44 migration has not
--      already done so (same definition).
--   A. cancel_field_task(task, reason), reassign_field_task(task, assignee, reason),
--      update_field_task(task, title, instructions, due_at, location_text).
--      Security definer; staff only; the caller must manage the task's case (D44); the task must
--      be open (pending / in progress); reasons are 3-500 characters. Each posts the event into
--      the case thread (visible to the operators on the case, without the reason) and, where a
--      reason is taken, a staff-only system message with the reason (D32); notifies the affected
--      operator(s) and the case owner when someone else acted; and writes an audit_log row
--      (TASK_CANCELLED / TASK_REASSIGNED / TASK_UPDATED) next to the generic row audit.
--      Reassignment only changes tasks.assignee_id: tasks_track_holds() closes the old operator's
--      hold at server time and opens one for the new operator, so the D43 late-upload window
--      (held_until + late_upload_grace_hours) applies to the old operator unchanged.
--   B. create_field_task(): caller manages the case; case exists and is not closed / cancelled;
--      parent task (if given) is on the same case; checklist (if given) is in use and offered for
--      the case (linked to its case template, or — when the template has no in-use link or the
--      case has no template — of its claim type for its insurer or all insurers, as the web form
--      offers); new optional p_reason sets tasks.reason (3-500 characters). Old calls still work:
--      the new parameter is last and defaulted.
--   C. reassign_case(): reason 3-500 characters; rejects the current owner; rejects cases that
--      are submitted, closed or cancelled. Still orchestrator / admin only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. D44 helper (only if missing)
-- ---------------------------------------------------------------------
do $do$
begin
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'private' and p.proname = 'can_manage_case') then
        execute $f$
create or replace function private.can_manage_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true when 'orchestrator' then true
    when 'office' then exists (select 1 from public.cases c where c.id = p_case_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
$f$;
        execute 'grant execute on function private.can_manage_case(uuid) to authenticated, service_role';
    end if;
end $do$;

-- ---------------------------------------------------------------------
-- Shared helpers (private, not callable by clients)
-- ---------------------------------------------------------------------
create or replace function private.require_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_reason, ''));
begin
    if char_length(v) not between 3 and 500 then
        raise exception 'A reason of 3 to 500 characters is required' using errcode = '22023';
    end if;
    return v;
end $$;

-- Locks an open task the caller may manage; raises otherwise.
create or replace function private.lock_manageable_task(p_task_id uuid) returns public.tasks
language plpgsql security definer set search_path = '' as $$
declare v public.tasks;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can change field tasks' using errcode = '42501';
    end if;
    select * into v from public.tasks t where t.id = p_task_id for update;
    if not found then
        raise exception 'Task not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(v.case_id) then
        raise exception 'You can change field tasks only on your own cases' using errcode = '42501';
    end if;
    if v.status not in ('pending', 'in_progress') then
        raise exception 'This task is % and can no longer be changed', v.status using errcode = '22023';
    end if;
    return v;
end $$;

-- Is the checklist one the case may use? Mirrors the web form (apps/web tasks/new/load.ts).
create or replace function private.checklist_offered_for_case(p_case_id uuid, p_checklist_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    with c as (select id, template_id, claim_type, insurer_id from public.cases where id = p_case_id),
    linked as (
        select l.checklist_template_id as id
          from c join public.case_template_checklists l on l.template_id = c.template_id
          join public.checklist_templates t on t.id = l.checklist_template_id and t.is_active)
    select case
        when exists (select 1 from linked) then exists (select 1 from linked where id = p_checklist_id)
        else exists (select 1 from c join public.checklist_templates t on t.id = p_checklist_id
                      where t.is_active and t.claim_type = c.claim_type
                        and (t.insurer_id is null or t.insurer_id = c.insurer_id))
    end;
$$;

-- Owner of the case hears about changes made by someone else (orchestrator / admin).
create or replace function private.notify_case_owner_of_task(p_case_id uuid, p_kind text, p_title text, p_body text,
                                                            p_dedupe text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
    select c.office_owner_id into v_owner from public.cases c where c.id = p_case_id;
    if v_owner is not null and v_owner is distinct from (select auth.uid()) then
        perform private.notify(v_owner, p_kind, p_case_id, p_title, p_body, p_dedupe);
    end if;
end $$;

revoke all on function private.require_reason(text), private.lock_manageable_task(uuid),
    private.checklist_offered_for_case(uuid, uuid), private.notify_case_owner_of_task(uuid, text, text, text, text)
    from public, anon, authenticated;
-- create_field_task() runs as the caller, so it needs the checklist check
grant execute on function private.checklist_offered_for_case(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- A1. Cancel
-- ---------------------------------------------------------------------
create or replace function public.cancel_field_task(p_task_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v        public.tasks := private.lock_manageable_task(p_task_id);
    v_reason text := private.require_reason(p_reason);
    v_ref    text;
begin
    select c.case_ref into v_ref from public.cases c where c.id = v.case_id;

    -- triggers: tasks_after_change moves the case to office review when no field work is left;
    -- tasks_track_holds ends the hold now (late uploads stay open for the grace period, D43)
    update public.tasks t set status = 'cancelled' where t.id = v.id;

    perform private.post_system_message(v.case_id, 'Field work cancelled: ' || v.title, v.id);
    perform private.post_system_message(v.case_id, 'Reason for cancelling "' || v.title || '": ' || v_reason,
                                        v.id, 'system', null, 'staff');
    if v.assignee_id is not null then
        perform private.notify(v.assignee_id, 'task_cancelled', v.case_id,
            coalesce(v_ref, '') || ': field work cancelled', v.title, 'task_cancelled:' || v.id);
    end if;
    perform private.notify_case_owner_of_task(v.case_id, 'task_cancelled',
        coalesce(v_ref, '') || ': field work cancelled', v.title || ' — ' || v_reason, 'task_cancelled:' || v.id);

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values ((select auth.uid()), 'TASK_CANCELLED', 'tasks', v.id,
            jsonb_build_object('status', v.status, 'assignee_id', v.assignee_id),
            jsonb_build_object('status', 'cancelled', 'reason', v_reason));
end $$;

-- ---------------------------------------------------------------------
-- A2. Reassign operator
-- ---------------------------------------------------------------------
create or replace function public.reassign_field_task(p_task_id uuid, p_assignee_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v          public.tasks := private.lock_manageable_task(p_task_id);
    v_reason   text := private.require_reason(p_reason);
    v_case     public.cases;
    v_old_name text;
    v_new_name text;
begin
    if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.is_active and p.role = 'field') then
        raise exception 'Assignee must be an active field operator' using errcode = '22023';
    end if;
    if p_assignee_id is not distinct from v.assignee_id then
        raise exception 'The task is already assigned to this operator' using errcode = '22023';
    end if;
    select * into v_case from public.cases c where c.id = v.case_id;
    if v_case.status in ('closed', 'cancelled') then
        raise exception 'This case is closed or cancelled, so its field work cannot be reassigned' using errcode = '22023';
    end if;
    select full_name into v_old_name from public.profiles where id = v.assignee_id;
    select full_name into v_new_name from public.profiles where id = p_assignee_id;

    -- the new operator starts afresh; tasks_track_holds closes the old hold and opens a new one
    update public.tasks t set assignee_id = p_assignee_id, status = 'pending', started_at = null where t.id = v.id;

    perform private.post_system_message(v.case_id,
        'Field work reassigned' || coalesce(' from ' || v_old_name, '') || ' to ' || coalesce(v_new_name, 'operator')
        || ': ' || v.title, v.id);
    perform private.post_system_message(v.case_id, 'Reason for reassigning "' || v.title || '": ' || v_reason,
                                        v.id, 'system', null, 'staff');
    perform private.notify(p_assignee_id,
        case when v.kind = 're_investigation' then 'field_request' else 'task_assigned' end,
        v.case_id, coalesce(v_case.case_ref, '') || ': ' || v.title, v.instructions, 'task:' || v.id);
    if v.assignee_id is not null then
        perform private.notify(v.assignee_id, 'task_unassigned', v.case_id,
            coalesce(v_case.case_ref, '') || ': field work moved to another operator', v.title, 'task_unassigned:' || v.id);
    end if;
    perform private.notify_case_owner_of_task(v.case_id, 'task_reassigned',
        coalesce(v_case.case_ref, '') || ': field work reassigned to ' || coalesce(v_new_name, 'operator'),
        v.title || ' — ' || v_reason, 'task_reassigned:' || v.id);

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values ((select auth.uid()), 'TASK_REASSIGNED', 'tasks', v.id,
            jsonb_build_object('assignee_id', v.assignee_id, 'status', v.status),
            jsonb_build_object('assignee_id', p_assignee_id, 'status', 'pending', 'reason', v_reason));
end $$;

-- ---------------------------------------------------------------------
-- A3. Edit title, instructions, due time, location (all values replace the current ones;
--     null / blank clears instructions, due time and location). Returns false when nothing changed.
-- ---------------------------------------------------------------------
create or replace function public.update_field_task(
    p_task_id uuid, p_title text, p_instructions text default null, p_due_at timestamptz default null,
    p_location_text text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
    v       public.tasks := private.lock_manageable_task(p_task_id);
    v_title text := btrim(coalesce(p_title, ''));
    v_instr text := nullif(btrim(coalesce(p_instructions, '')), '');
    v_loc   text := nullif(btrim(coalesce(p_location_text, '')), '');
    v_ref   text;
    v_what  text[] := '{}';
begin
    if char_length(v_title) not between 3 and 120 then
        raise exception 'A task title of 3 to 120 characters is required' using errcode = '22023';
    end if;
    if char_length(coalesce(v_instr, '')) > 4000 then
        raise exception 'Instructions can be at most 4000 characters' using errcode = '22023';
    end if;
    if v.kind = 're_investigation' and v_instr is null then
        raise exception 'A re-investigation needs its request text' using errcode = '22023';
    end if;
    if char_length(coalesce(v_loc, '')) > 300 then
        raise exception 'Location can be at most 300 characters' using errcode = '22023';
    end if;
    if p_due_at is distinct from v.due_at and p_due_at is not null
       and (p_due_at <= now() or p_due_at > now() + interval '366 days') then
        raise exception 'The due time must be in the future and within a year' using errcode = '22023';
    end if;

    if v_title  is distinct from v.title         then v_what := v_what || 'title'::text; end if;
    if v_instr  is distinct from v.instructions  then v_what := v_what || case when v.kind = 're_investigation' then 'request' else 'instructions' end; end if;
    if p_due_at is distinct from v.due_at        then v_what := v_what || 'due time'::text; end if;
    if v_loc    is distinct from v.location_text then v_what := v_what || 'location'::text; end if;
    if cardinality(v_what) = 0 then
        return false;
    end if;

    update public.tasks t
       set title = v_title, instructions = v_instr, due_at = p_due_at, location_text = v_loc
     where t.id = v.id;

    select c.case_ref into v_ref from public.cases c where c.id = v.case_id;
    perform private.post_system_message(v.case_id,
        'Field work updated (' || array_to_string(v_what, ', ') || '): ' || v_title, v.id);
    if v.assignee_id is not null then
        perform private.notify(v.assignee_id, 'task_updated', v.case_id,
            coalesce(v_ref, '') || ': field work updated', v_title || ' — ' || array_to_string(v_what, ', ') || ' changed',
            'task_updated:' || v.id);
    end if;

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values ((select auth.uid()), 'TASK_UPDATED', 'tasks', v.id,
            jsonb_build_object('title', v.title, 'instructions', v.instructions, 'due_at', v.due_at, 'location_text', v.location_text),
            jsonb_build_object('title', v_title, 'instructions', v_instr, 'due_at', p_due_at, 'location_text', v_loc,
                               'changed', to_jsonb(v_what)));
    return true;
end $$;

-- ---------------------------------------------------------------------
-- B. create_field_task (hardened; p_reason added last, defaulted)
-- ---------------------------------------------------------------------
drop function public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid);
create function public.create_field_task(
    p_case_id uuid, p_assignee_id uuid, p_title text, p_instructions text default null,
    p_checklist_template_id uuid default null, p_kind public.task_kind default 'initial',
    p_due_at timestamptz default null, p_location_text text default null, p_parent_task_id uuid default null,
    p_reason text default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
    v_task   uuid;
    v_status public.case_status;
    v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
    if not public.is_staff() then
        raise exception 'Only office staff can assign field work' using errcode = '42501';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'You can assign field work only on your own cases' using errcode = '42501';
    end if;
    select c.status into v_status from public.cases c where c.id = p_case_id;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if v_status in ('closed', 'cancelled') then
        raise exception 'This case is closed or cancelled, so it takes no new field work' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.is_active and p.role = 'field') then
        raise exception 'Assignee must be an active field operator' using errcode = '22023';
    end if;
    if p_title is null or char_length(btrim(p_title)) < 3 then
        raise exception 'A task title is required' using errcode = '22023';
    end if;
    if p_parent_task_id is not null
       and not exists (select 1 from public.tasks t where t.id = p_parent_task_id and t.case_id = p_case_id) then
        raise exception 'The earlier task must belong to the same case' using errcode = '22023';
    end if;
    if p_checklist_template_id is not null and not private.checklist_offered_for_case(p_case_id, p_checklist_template_id) then
        raise exception 'Choose a checklist that is in use for this case' using errcode = '22023';
    end if;
    if v_reason is not null and char_length(v_reason) not between 3 and 500 then
        raise exception 'The reason must be 3 to 500 characters' using errcode = '22023';
    end if;
    insert into public.tasks (case_id, kind, parent_task_id, title, instructions, reason, assignee_id, due_at,
                              location_text, created_by)
    values (p_case_id, p_kind, p_parent_task_id, btrim(p_title), p_instructions, v_reason, p_assignee_id, p_due_at,
            p_location_text, (select auth.uid()))
    returning id into v_task;
    if p_checklist_template_id is not null then
        perform public.apply_checklist_template(v_task, p_checklist_template_id);
    end if;
    return v_task;
end $$;

-- ---------------------------------------------------------------------
-- C. reassign_case (hardened)
-- ---------------------------------------------------------------------
create or replace function public.reassign_case(p_case_id uuid, p_assignee_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_case public.cases;
begin
    if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
        raise exception 'Only an orchestrator or admin can reassign cases' using errcode = '42501';
    end if;
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
        raise exception 'A reason of 3 to 500 characters is required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.is_active
                     and p.role in ('office', 'orchestrator', 'admin')) then
        raise exception 'Assignee must be an active office, orchestrator or admin user' using errcode = '22023';
    end if;
    select * into v_case from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if v_case.status in ('submitted', 'closed', 'cancelled') then
        raise exception 'A submitted, closed or cancelled case cannot be reassigned' using errcode = '22023';
    end if;
    if v_case.office_owner_id is not distinct from p_assignee_id then
        raise exception 'The case is already assigned to this user' using errcode = '22023';
    end if;
    perform private.assign_case(p_case_id, p_assignee_id, 'manual', btrim(p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function
    public.cancel_field_task(uuid, text),
    public.reassign_field_task(uuid, uuid, text),
    public.update_field_task(uuid, text, text, timestamptz, text),
    public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid, text),
    public.reassign_case(uuid, uuid, text)
from public, anon;
grant execute on function
    public.cancel_field_task(uuid, text),
    public.reassign_field_task(uuid, uuid, text),
    public.update_field_task(uuid, text, text, timestamptz, text),
    public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid, text),
    public.reassign_case(uuid, uuid, text)
to authenticated, service_role;
