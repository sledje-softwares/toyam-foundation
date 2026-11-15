-- =====================================================================
-- Submitted cases and one-step approval (D46, D47)
--
--   A. D46 — a submitted case is reopened only when the insurer asks. No field task or
--      re-investigation on a `submitted` case: staff reopen it first (reopen_case, reason = the
--      insurer's request), which returns it to office review.
--        A1. create_field_task(): refuses submitted cases (same signature, security invoker, all
--            earlier checks kept; copied from 20261115600000_field_task_rpcs.sql).
--        A2. tasks_open_case_guard (before insert on tasks): the same rule for any signed-in caller,
--            so a direct insert under p_tasks_staff_i cannot bypass A1. Service role / migrations
--            (no auth.uid()) are not affected.
--        A3. reassign_field_task() and update_field_task() refuse submitted cases too (work there
--            should be finished; reopen first). cancel_field_task() stays allowed as the clean-up.
--      tasks_after_change needs no change: it never moves a submitted case.
--   B. D47 — orchestrators and admins approve their own reports in one step.
--      approve_own_report(report, comment): the approval request and the approval by the same
--      person in one transaction, under the unchanged report_approvals_guard rules (case in
--      assigned / office review, no open field task, every required field filled, report of the
--      case). Latest version only. The "waiting for approval" notifications the request raised are
--      withdrawn (nobody else needs to act); staff-only thread event; the case owner is notified
--      when someone else approved. Office employees keep request → orchestrator / admin decides.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Shared message
-- ---------------------------------------------------------------------
create or replace function private.submitted_case_message() returns text
language sql immutable set search_path = '' as $$
    select 'This case was submitted. Reopen it from Submissions when the insurer asks.'::text;
$$;
revoke all on function private.submitted_case_message() from public, anon;
grant execute on function private.submitted_case_message() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- A1. create_field_task (D46: refuses submitted)
-- ---------------------------------------------------------------------
create or replace function public.create_field_task(
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
    if v_status = 'submitted' then
        raise exception '%', private.submitted_case_message() using errcode = '22023';
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
-- A2. No new task on a submitted / closed / cancelled case for signed-in callers
-- ---------------------------------------------------------------------
-- Security definer (reads the case whatever the caller's RLS); the caller is identified by auth.uid(),
-- not current_user. Service role and migrations (no auth.uid()) are not restricted.
create or replace function private.tasks_open_case_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status public.case_status;
begin
    -- callers who may not add tasks to the case are refused by RLS (p_tasks_staff_i) with 42501
    if (select auth.uid()) is null or not private.can_manage_case(new.case_id) then
        return new;
    end if;
    select c.status into v_status from public.cases c where c.id = new.case_id;
    if v_status = 'submitted' then
        raise exception '%', private.submitted_case_message() using errcode = '22023';
    end if;
    if v_status in ('closed', 'cancelled') then
        raise exception 'This case is closed or cancelled, so it takes no new field work' using errcode = '22023';
    end if;
    return new;
end $$;
revoke all on function private.tasks_open_case_guard() from public, anon, authenticated;
create trigger trg_tasks_open_case_guard before insert on public.tasks
    for each row execute function private.tasks_open_case_guard();

-- ---------------------------------------------------------------------
-- A3. reassign_field_task / update_field_task refuse submitted cases
--     (copied from 20261115600000_field_task_rpcs.sql; only the case-status checks are new)
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
    if v_case.status = 'submitted' then
        raise exception '%', private.submitted_case_message() using errcode = '22023';
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

create or replace function public.update_field_task(
    p_task_id uuid, p_title text, p_instructions text default null, p_due_at timestamptz default null,
    p_location_text text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
    v        public.tasks := private.lock_manageable_task(p_task_id);
    v_title  text := btrim(coalesce(p_title, ''));
    v_instr  text := nullif(btrim(coalesce(p_instructions, '')), '');
    v_loc    text := nullif(btrim(coalesce(p_location_text, '')), '');
    v_ref    text;
    v_status public.case_status;
    v_what   text[] := '{}';
begin
    select c.case_ref, c.status into v_ref, v_status from public.cases c where c.id = v.case_id;
    if v_status = 'submitted' then
        raise exception '%', private.submitted_case_message() using errcode = '22023';
    end if;
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
-- B. D47: one-step approval by an orchestrator / admin
-- ---------------------------------------------------------------------
-- Returns the report_approvals id. The request rules are report_approvals_guard's (unchanged).
create or replace function public.approve_own_report(p_report_id uuid, p_comment text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_uid     uuid := (select auth.uid());
    v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
    v_report  public.reports;
    v_case    public.cases;
    v_id      uuid;
    v_name    text;
begin
    if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
        raise exception 'Only an orchestrator or admin approves a report in one step; office staff request approval'
            using errcode = '42501';
    end if;
    if char_length(v_comment) > 2000 then
        raise exception 'Keep the comment under 2000 characters' using errcode = '22023';
    end if;
    select * into v_report from public.reports r where r.id = p_report_id;
    if not found then
        raise exception 'Report not found' using errcode = 'P0002';
    end if;
    select * into v_case from public.cases c where c.id = v_report.case_id for update;
    if exists (select 1 from public.reports r where r.case_id = v_report.case_id and r.version > v_report.version) then
        raise exception 'Only the latest report version can be approved' using errcode = '22023';
    end if;
    if exists (select 1 from public.report_approvals a where a.report_id = p_report_id) then
        raise exception 'Approval was already requested for this version' using errcode = '55000';
    end if;

    -- report_approvals_guard: owner / orchestrator / admin, case in assigned / office review, no open field
    -- task, every required field filled; moves the case to orchestrator_review and notifies orchestrators.
    insert into public.report_approvals (case_id, report_id, requested_by)
    values (v_report.case_id, p_report_id, v_uid)
    returning id into v_id;
    -- nobody else has to act (D47): withdraw the "waiting for approval" notifications of this request
    delete from public.notifications n where n.dedupe_key = 'approval:' || v_id::text;

    -- report_approvals_guard: decided once, by an orchestrator / admin; stamps decided_by / decided_at
    update public.report_approvals a set decision = 'approved', comments = v_comment where a.id = v_id;

    select p.full_name into v_name from public.profiles p where p.id = v_uid;
    perform private.post_system_message(v_report.case_id,
        'Report version ' || v_report.version || ' approved by ' || coalesce(v_name, 'staff')
        || coalesce(': ' || v_comment, ''), null, 'system', null, 'staff');
    if v_case.office_owner_id is not null and v_case.office_owner_id <> v_uid then
        perform private.notify(v_case.office_owner_id, 'report_approved', v_report.case_id,
            coalesce(v_case.case_ref, '') || ': report approved', v_comment, 'report_approved:' || v_id::text);
    end if;
    return v_id;
end $$;
revoke all on function public.approve_own_report(uuid, text) from public, anon;
grant execute on function public.approve_own_report(uuid, text) to authenticated;
