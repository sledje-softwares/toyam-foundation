-- =====================================================================
-- Completing field work and closing a case (docs/14 gaps: "task done" action, close after ack)
--
--   A. complete_field_task(task, note) — security definer. Callable by
--        (a) the assigned, active field operator on their own open task, and
--        (b) staff who manage the task's case (private.can_manage_case, D44; orchestrator / admin all).
--      The task must be pending / in progress; the case must not be submitted, closed or cancelled
--      (D46: left-over work on a submitted case is cancelled, not completed). Only tasks.status changes;
--      the existing triggers do the rest:
--        tasks_field_guard  → completed_at = server time (and started_at when it was never started)
--        tasks_after_change → thread event, case owner notified, last open task moves the case
--                             field_in_progress → office_review (unchanged rule)
--        tasks_track_holds  → the hold ends now; files captured before stay accepted for the D43
--                             late-upload window (late_upload_grace_hours)
--      The optional note (≤ 1000 characters) is posted as a system message: visible on the case when
--      the operator wrote it, staff-only when staff did (D32). Staff completion notifies the operator.
--      audit_log TASK_COMPLETED (next to the generic row audit).
--   B. tasks_after_change: the completion event names who acted — "<operator> marked field work
--      complete" when the operator did, "Field work marked complete by the office" when staff did; the
--      owner is not notified of their own action. Otherwise unchanged (copied from 20261113000100).
--   C. tasks_field_guard: field users can no longer complete a task with a direct UPDATE (API roles);
--      completion goes through complete_field_task. Starting a task (pending → in progress, done by
--      post_thread_message as the caller) is unchanged; p_tasks_field_u stays for that.
--   D. close_case(case, note) — security definer; case owner / orchestrator / admin (D44). Only from
--      `submitted`, with no open field task, and the latest submission acknowledged by the insurer
--      (record_submission_ack). Orchestrators / admins may close without an acknowledgement when they
--      give a reason (3-500 characters; e.g. a portal that never confirms); office staff record the
--      acknowledgement first. Sets status closed (cases_status_history writes the history row and
--      closed_at), notes the reason in the history, staff-only thread event, owner notified when
--      someone else closed, audit_log CASE_CLOSED. A closed case is final: reopen_case() still accepts
--      only submitted cases (D46, unchanged).
--   E. cases_closed_guard: API roles cannot move a case into or out of `closed` with a direct UPDATE
--      (p_cases_staff allows status writes); close_case runs as its owner and is not affected.
-- =====================================================================

-- ---------------------------------------------------------------------
-- C. tasks_field_guard: completion only through complete_field_task
--    (copied from 20261111100000_security_hardening.sql; the completion check is new)
-- ---------------------------------------------------------------------
-- security invoker on purpose: current_user is the API role on a direct write and the function owner
-- inside the security-definer RPCs.
create or replace function public.tasks_field_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if public.is_field() then
        if (to_jsonb(new) - array['status','started_at','completed_at','updated_at'])
           is distinct from
           (to_jsonb(old) - array['status','started_at','completed_at','updated_at']) then
            raise exception 'Field users may only update task status'
                using errcode = '42501';
        end if;
        if new.status is distinct from old.status and not (
               (old.status = 'pending'     and new.status in ('in_progress','completed'))
            or (old.status = 'in_progress' and new.status = 'completed')) then
            raise exception 'Field users cannot move a task from % to %', old.status, new.status
                using errcode = '42501';
        end if;
        if new.status = 'completed' and old.status is distinct from 'completed'
           and current_user in ('authenticated', 'anon') then
            raise exception 'Use "Mark task done" in the app to finish field work' using errcode = '42501';
        end if;
        -- Trusted server time for field transitions
        new.started_at   := old.started_at;
        new.completed_at := old.completed_at;
    end if;
    if new.status is distinct from old.status then
        if new.status in ('in_progress','completed') and new.started_at is null then
            new.started_at := now();
        end if;
        if new.status = 'completed' and new.completed_at is null then
            new.completed_at := now();
        end if;
    end if;
    return new;
end $$;
revoke execute on function public.tasks_field_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- B. tasks_after_change: completion event names who acted
--    (copied from 20261113000100_revised_flow.sql; only the 'completed' branch changed)
-- ---------------------------------------------------------------------
create or replace function private.tasks_after_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_case public.cases; v_name text; v_open int; v_actor uuid := (select auth.uid());
begin
    select * into v_case from public.cases where id = new.case_id;
    select full_name into v_name from public.profiles where id = new.assignee_id;
    if tg_op = 'INSERT' then
        perform private.post_system_message(new.case_id,
            case when new.kind = 're_investigation' then coalesce(new.instructions, new.title)
                 else 'Field work assigned to ' || coalesce(v_name, 'operator') || ': ' || new.title end,
            new.id,
            case when new.kind = 're_investigation' then 'request'::public.message_kind else 'system'::public.message_kind end,
            v_actor);
        if new.assignee_id is not null then
            perform private.notify(new.assignee_id,
                case when new.kind = 're_investigation' then 'field_request' else 'task_assigned' end,
                new.case_id, coalesce(v_case.case_ref, '') || ': ' || new.title, new.instructions, 'task:' || new.id);
        end if;
        if new.status in ('pending', 'in_progress')
           and v_case.status in ('received', 'intake_confirmed', 'assigned', 'office_review', 'orchestrator_review') then
            update public.cases set status = 'field_in_progress' where id = new.case_id;
        end if;
    elsif new.status is distinct from old.status and new.status in ('completed', 'cancelled') then
        if new.status = 'completed' then
            perform private.post_system_message(new.case_id,
                case when v_actor is null or v_actor is not distinct from new.assignee_id
                     then coalesce(v_name, 'Operator') || ' marked field work complete: ' || new.title
                     else 'Field work marked complete by the office: ' || new.title end,
                new.id);
            if v_case.office_owner_id is not null and v_case.office_owner_id is distinct from v_actor then
                perform private.notify(v_case.office_owner_id, 'task_completed', new.case_id,
                    coalesce(v_case.case_ref, '') || ': field work complete', new.title, 'task_done:' || new.id);
            end if;
        end if;
        select count(*) into v_open from public.tasks t
         where t.case_id = new.case_id and t.status in ('pending', 'in_progress');
        if v_open = 0 and v_case.status = 'field_in_progress' then
            update public.cases set status = 'office_review' where id = new.case_id;
        end if;
    end if;
    return null;
end $$;
revoke all on function private.tasks_after_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- A. complete_field_task
-- ---------------------------------------------------------------------
create or replace function public.complete_field_task(p_task_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_uid   uuid := (select auth.uid());
    v_field boolean := public.is_field();
    v_note  text := nullif(btrim(coalesce(p_note, '')), '');
    v       public.tasks;
    v_case  public.cases;
    v_name  text;
begin
    if not v_field and not public.is_staff() then
        raise exception 'Only the assigned operator or office staff can mark field work complete' using errcode = '42501';
    end if;
    if char_length(v_note) > 1000 then
        raise exception 'Keep the note under 1000 characters' using errcode = '22023';
    end if;
    select * into v from public.tasks t where t.id = p_task_id for update;
    if not found then
        raise exception 'Task not found' using errcode = 'P0002';
    end if;
    if v_field then
        if v.assignee_id is distinct from v_uid then
            raise exception 'You can mark only your own field work complete' using errcode = '42501';
        end if;
    elsif not private.can_manage_case(v.case_id) then
        raise exception 'You can change field tasks only on your own cases' using errcode = '42501';
    end if;
    if v.status not in ('pending', 'in_progress') then
        raise exception 'This task is % and can no longer be changed', v.status using errcode = '22023';
    end if;
    select * into v_case from public.cases c where c.id = v.case_id;
    if v_case.status in ('submitted', 'closed', 'cancelled') then
        raise exception '%', case
            when v_field then 'This case is no longer open for field work. Ask the office.'
            when v_case.status = 'submitted' then 'This case was submitted, so its field work cannot be marked complete. Cancel left-over work instead'
            else 'This case is closed or cancelled, so its field work cannot be marked complete' end
            using errcode = '22023';
    end if;

    -- triggers: completed_at = server time; thread event + owner notified; last open task moves the case to
    -- office review; the hold ends now and the D43 late-upload window starts
    update public.tasks t set status = 'completed' where t.id = v.id;

    if v_note is not null then
        select p.full_name into v_name from public.profiles p where p.id = v_uid;
        if v_field then
            perform private.post_system_message(v.case_id,
                'Note from ' || coalesce(v_name, 'the operator') || ' on completing "' || v.title || '": ' || v_note, v.id);
        else
            perform private.post_system_message(v.case_id,
                'Note on completing "' || v.title || '" (' || coalesce(v_name, 'staff') || '): ' || v_note,
                v.id, 'system', null, 'staff');
        end if;
    end if;
    if not v_field and v.assignee_id is not null then
        perform private.notify(v.assignee_id, 'task_completed', v.case_id,
            coalesce(v_case.case_ref, '') || ': field work marked complete by the office', v.title,
            'task_completed_by_office:' || v.id);
    end if;

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (v_uid, 'TASK_COMPLETED', 'tasks', v.id,
            jsonb_build_object('status', v.status, 'assignee_id', v.assignee_id),
            jsonb_build_object('status', 'completed', 'by', case when v_field then 'operator' else 'office' end,
                               'note', v_note));
end $$;

-- ---------------------------------------------------------------------
-- E. Into / out of `closed` only through close_case (API roles)
-- ---------------------------------------------------------------------
-- security invoker on purpose: current_user is the API role on a direct write and the function owner
-- inside close_case / system jobs.
create or replace function private.cases_closed_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if new.status is distinct from old.status and 'closed' in (new.status, old.status)
       and current_user in ('authenticated', 'anon') then
        raise exception '%', case when new.status = 'closed'
            then 'Close the case from Submissions (close_case)'
            else 'A closed case cannot be reopened' end
            using errcode = '42501';
    end if;
    return new;
end $$;
revoke all on function private.cases_closed_guard() from public, anon, authenticated;
create trigger trg_cases_closed_guard before update of status on public.cases
    for each row execute function private.cases_closed_guard();

-- ---------------------------------------------------------------------
-- D. close_case
-- ---------------------------------------------------------------------
create or replace function public.close_case(p_case_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_uid    uuid := (select auth.uid());
    v_lead   boolean := coalesce(private.current_user_role() in ('orchestrator', 'admin'), false);
    v_note   text := nullif(btrim(coalesce(p_note, '')), '');
    v_case   public.cases;
    v_sub    public.submissions;
    v_acked  boolean;
    v_name   text;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can close cases' using errcode = '42501';
    end if;
    select * into v_case from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can close this case' using errcode = '42501';
    end if;
    if char_length(v_note) > 500 then
        raise exception 'Keep the note under 500 characters' using errcode = '22023';
    end if;
    if v_case.status <> 'submitted' then
        raise exception '%', case v_case.status
            when 'closed' then 'The case is already closed'
            when 'cancelled' then 'The case is cancelled'
            else 'Only a submitted case can be closed' end
            using errcode = '55000';
    end if;
    if exists (select 1 from public.tasks t where t.case_id = p_case_id and t.status in ('pending', 'in_progress')) then
        raise exception 'Field work is still open on this case. Cancel it before closing' using errcode = '55000';
    end if;
    select s.* into v_sub from public.submissions s where s.case_id = p_case_id
     order by s.submitted_at desc, s.id desc limit 1;
    if v_sub.id is null then
        raise exception 'No submission is recorded for this case' using errcode = '55000';
    end if;
    v_acked := v_sub.acknowledged_at is not null;
    if not v_acked then
        if not v_lead then
            raise exception 'Record the insurer''s acknowledgement before closing the case' using errcode = '55000';
        end if;
        if char_length(coalesce(v_note, '')) < 3 then
            raise exception 'Say why the case is closed without the insurer''s acknowledgement (3 to 500 characters)'
                using errcode = '22023';
        end if;
    end if;

    -- cases_status_history: history row and closed_at = now()
    update public.cases set status = 'closed' where id = p_case_id;
    update public.case_status_history h
       set note = case when v_acked then 'Closed' else 'Closed without acknowledgement' end || coalesce(': ' || v_note, '')
     where h.id = (select max(x.id) from public.case_status_history x
                    where x.case_id = p_case_id and x.from_status = 'submitted' and x.to_status = 'closed');

    select p.full_name into v_name from public.profiles p where p.id = v_uid;
    perform private.post_system_message(p_case_id,
        'Case closed by ' || coalesce(v_name, 'staff')
        || case when v_acked then '' else ' without the insurer''s acknowledgement' end
        || coalesce(': ' || v_note, ''), null, 'system', null, 'staff');
    if v_case.office_owner_id is not null and v_case.office_owner_id <> v_uid then
        perform private.notify(v_case.office_owner_id, 'case_closed', p_case_id,
                               coalesce(v_case.case_ref, '') || ': case closed', v_note, 'case_closed:' || p_case_id);
    end if;

    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (v_uid, 'CASE_CLOSED', 'cases', p_case_id,
            jsonb_build_object('status', v_case.status),
            jsonb_build_object('status', 'closed', 'submission_id', v_sub.id, 'acknowledged', v_acked, 'note', v_note));
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function public.complete_field_task(uuid, text), public.close_case(uuid, text) from public, anon;
grant execute on function public.complete_field_task(uuid, text), public.close_case(uuid, text) to authenticated, service_role;
