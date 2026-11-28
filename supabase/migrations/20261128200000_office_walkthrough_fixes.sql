-- =====================================================================
-- Office UI walkthrough fixes (2026-11-27 findings)
--
--   A. Incident date follows the template. private.parse_loss_date(text) reads the date part of
--      `YYYY-MM-DD`, `YYYY-MM-DD HH:MM` / `YYYY-MM-DDTHH:MM…`, `DD/MM/YYYY` and `DD-MM-YYYY` (optionally
--      followed by a time); anything else, an impossible date or an empty value gives null — it never
--      raises. case_field_values_sync_case (G6, 20261115800000) now also mirrors the template field
--      `date_of_loss` (ICL, date) or `loss_datetime` (IGI, datetime) to cases.incident_date. Intake
--      (create_case_from_intake, confirm_intake), create_case_direct, save_case_field_values and the
--      pipeline all write case_field_values, so the trigger covers them. cases_mirror_guard keeps API
--      roles from changing incident_date directly when the case's template has one of these keys
--      (trigger now also on incident_date). Existing cases are backfilled from their stored values.
--   B. Approvals in the thread (staff-only system messages). report_approvals_guard posts
--        "Approval requested by <name> for report version N" on a request,
--        "Report approved by <name>" / "Changes requested by <name>: <comment>" on a decision.
--      approve_own_report (D47) keeps its single "Report version N approved by <name>" message: it sets
--      app.self_approval so the guard does not post the request / decision messages as well.
--      Otherwise both functions are unchanged (copied from 20261115800000 / 20261115900000).
--   C. complete_field_task never blocks on the checklist; when the task has mandatory checklist items
--      that are not done (v_case_checklist; done = status <> pending or matched evidence, as the web's
--      checklistProgress()), it posts a staff-only "Task completed by <name> with D of T required
--      checklist items collected". Otherwise unchanged (copied from 20261119100000).
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Incident date
-- ---------------------------------------------------------------------
create or replace function private.parse_loss_date(p_value text) returns date
language plpgsql immutable set search_path = '' as $$
declare
    v text := btrim(coalesce(p_value, ''));
    m text[];
begin
    if v = '' then
        return null;
    end if;
    -- ISO date, optionally with a time (space or T separator)
    m := regexp_match(v, '^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\s*\d{1,2}:\d{2}.*)?$');
    if m is not null then
        return make_date(m[1]::int, m[2]::int, m[3]::int);
    end if;
    -- Indian day-first date with / or -, optionally followed by a time
    m := regexp_match(v, '^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?:[ ,T]\s*\d{1,2}[:.]\d{2}.*)?$');
    if m is not null then
        return make_date(m[4]::int, m[3]::int, m[1]::int);
    end if;
    return null;
exception when others then
    return null;   -- impossible dates (31/02/2026) and out-of-range numbers
end $$;
revoke all on function private.parse_loss_date(text) from public, anon, authenticated;

create or replace function private.case_field_values_sync_case() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_key  text;
    v_val  text;
    v_date date;
    v_case public.cases;
begin
    select f.key into v_key from public.case_template_fields f where f.id = new.field_id;
    if v_key is null or v_key not in ('insurer_claim_no', 'policy_no', 'date_of_loss', 'loss_datetime') then
        return null;
    end if;
    v_val := nullif(btrim(coalesce(new.value, '')), '');
    select * into v_case from public.cases c where c.id = new.case_id;
    if v_key = 'insurer_claim_no' then
        if v_val is null then
            raise exception 'The claim number cannot be empty' using errcode = '23514';
        end if;
        if v_val is distinct from v_case.insurer_claim_no then
            if exists (select 1 from public.cases c
                        where c.insurer_id = v_case.insurer_id and c.insurer_claim_no = v_val and c.id <> v_case.id) then
                raise exception 'Another case of this insurer already has claim number %', v_val using errcode = '23505';
            end if;
            update public.cases set insurer_claim_no = v_val where id = new.case_id;
        end if;
    elsif v_key = 'policy_no' then
        if v_val is distinct from v_case.policy_no then
            update public.cases set policy_no = v_val where id = new.case_id;
        end if;
    else
        v_date := private.parse_loss_date(v_val);
        if v_date is distinct from v_case.incident_date then
            update public.cases set incident_date = v_date where id = new.case_id;
        end if;
    end if;
    return null;
end $$;

-- security invoker on purpose: current_user is the real caller (the sync above runs as the owner)
create or replace function private.cases_mirror_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if current_user in ('authenticated', 'anon') then
        if new.insurer_claim_no is distinct from old.insurer_claim_no
           and exists (select 1 from public.case_template_fields f
                        where f.template_id = new.template_id and f.key = 'insurer_claim_no') then
            raise exception 'Change the claim number in the report workspace' using errcode = '42501';
        end if;
        if new.policy_no is distinct from old.policy_no
           and exists (select 1 from public.case_template_fields f
                        where f.template_id = new.template_id and f.key = 'policy_no') then
            raise exception 'Change the policy number in the report workspace' using errcode = '42501';
        end if;
        if new.incident_date is distinct from old.incident_date
           and exists (select 1 from public.case_template_fields f
                        where f.template_id = new.template_id and f.key in ('date_of_loss', 'loss_datetime')) then
            raise exception 'Change the date of loss in the report workspace' using errcode = '42501';
        end if;
    end if;
    return new;
end $$;
drop trigger trg_cases_mirror_guard on public.cases;
create trigger trg_cases_mirror_guard before update of insurer_claim_no, policy_no, incident_date on public.cases
    for each row execute function private.cases_mirror_guard();

-- backfill: cases whose template has a loss-date field and a stored value for it (returns rows changed;
-- kept as a function so the test can run it again)
create or replace function private.sync_incident_dates() returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
    update public.cases c
       set incident_date = x.d
      from (select distinct on (v.case_id) v.case_id, private.parse_loss_date(v.value) as d
              from public.case_field_values v
              join public.cases c2 on c2.id = v.case_id
              join public.case_template_fields f on f.id = v.field_id and f.template_id = c2.template_id
             where f.key in ('date_of_loss', 'loss_datetime')
             order by v.case_id, f.key) x
     where x.case_id = c.id and c.incident_date is distinct from x.d;
    get diagnostics v_n = row_count;
    return v_n;
end $$;
revoke all on function private.sync_incident_dates() from public, anon, authenticated;
select private.sync_incident_dates();

-- ---------------------------------------------------------------------
-- B. Approval events in the thread (staff-only)
-- ---------------------------------------------------------------------
create or replace function private.report_approvals_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_case    public.cases;
    v_missing int;
    v_labels  text;
    v_self    boolean := coalesce(current_setting('app.self_approval', true), '') = 'on';
    v_name    text;
    v_version int;
begin
    if tg_op = 'INSERT' then
        if not exists (select 1 from public.reports r where r.id = new.report_id and r.case_id = new.case_id) then
            raise exception 'Report does not belong to the case' using errcode = '23514';
        end if;
        select * into v_case from public.cases c where c.id = new.case_id for update;
        if (select auth.uid()) is not null and not private.can_manage_case(new.case_id) then
            raise exception 'Only the case owner, an orchestrator or an admin can request approval' using errcode = '42501';
        end if;
        if v_case.status not in ('assigned', 'office_review')
           or exists (select 1 from public.tasks t where t.case_id = new.case_id and t.status in ('pending', 'in_progress')) then
            raise exception '%', case
                when v_case.status = 'field_in_progress'
                  or exists (select 1 from public.tasks t where t.case_id = new.case_id and t.status in ('pending', 'in_progress'))
                    then 'Field work is still open'
                when v_case.status = 'orchestrator_review' then 'Approval has already been requested'
                else 'Approval can be requested only while the case is in office review' end
                using errcode = '55000';
        end if;
        select count(*), string_agg(f.label, ', ' order by s.position, f.position)
          into v_missing, v_labels
          from public.case_template_fields f
          join public.case_template_sections s on s.id = f.section_id
          left join public.case_field_values v on v.case_id = new.case_id and v.field_id = f.id
         where f.template_id = v_case.template_id and f.is_required
           and nullif(btrim(coalesce(v.value, '')), '') is null;
        if v_missing > 0 then
            raise exception '% required % empty: %', v_missing,
                case when v_missing = 1 then 'field is' else 'fields are' end, left(v_labels, 300)
                using errcode = '23514';
        end if;
        new.requested_by := coalesce((select auth.uid()), new.requested_by);
        new.requested_at := now();
        new.decision := 'pending'; new.decided_by := null; new.decided_at := null;
        update public.cases set status = 'orchestrator_review'
         where id = new.case_id and status in ('office_review', 'assigned');
        perform private.notify_orchestrators('approval_requested', new.case_id, 'Report waiting for approval',
                                             null, 'approval:' || new.id);
        if not v_self then
            select p.full_name into v_name from public.profiles p where p.id = new.requested_by;
            select r.version into v_version from public.reports r where r.id = new.report_id;
            perform private.post_system_message(new.case_id,
                'Approval requested by ' || coalesce(v_name, 'staff') || ' for report version ' || coalesce(v_version::text, '?'),
                null, 'system', null, 'staff');
        end if;
        return new;
    end if;
    if (new.case_id, new.report_id, new.requested_by, new.requested_at)
       is distinct from (old.case_id, old.report_id, old.requested_by, old.requested_at) then
        raise exception 'Approval request fields cannot change' using errcode = '42501';
    end if;
    if new.decision is distinct from old.decision then
        if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
            raise exception 'Only an orchestrator or admin can decide' using errcode = '42501';
        end if;
        if old.decision <> 'pending' or new.decision = 'pending' then
            raise exception 'An approval is decided once' using errcode = '42501';
        end if;
        new.decided_by := (select auth.uid());
        new.decided_at := now();
        if new.decision = 'changes_requested' then
            update public.cases set status = 'office_review' where id = new.case_id and status = 'orchestrator_review';
            perform private.notify(old.requested_by, 'changes_requested', new.case_id, 'Changes requested on report',
                                   new.comments, 'changes:' || new.id);
        end if;
        if not v_self then
            select p.full_name into v_name from public.profiles p where p.id = new.decided_by;
            perform private.post_system_message(new.case_id,
                case when new.decision = 'approved'
                     then 'Report approved by ' || coalesce(v_name, 'staff')
                     else 'Changes requested by ' || coalesce(v_name, 'staff')
                          || coalesce(': ' || nullif(btrim(coalesce(new.comments, '')), ''), '') end,
                null, 'system', null, 'staff');
        end if;
    end if;
    return new;
end $$;

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

    -- the guard skips its own request / decision thread messages; this function posts one message below
    perform set_config('app.self_approval', 'on', true);
    -- report_approvals_guard: owner / orchestrator / admin, case in assigned / office review, no open field
    -- task, every required field filled; moves the case to orchestrator_review and notifies orchestrators.
    insert into public.report_approvals (case_id, report_id, requested_by)
    values (v_report.case_id, p_report_id, v_uid)
    returning id into v_id;
    -- nobody else has to act (D47): withdraw the "waiting for approval" notifications of this request
    delete from public.notifications n where n.dedupe_key = 'approval:' || v_id::text;

    -- report_approvals_guard: decided once, by an orchestrator / admin; stamps decided_by / decided_at
    update public.report_approvals a set decision = 'approved', comments = v_comment where a.id = v_id;
    perform set_config('app.self_approval', 'off', true);

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

-- ---------------------------------------------------------------------
-- C. complete_field_task: note when required checklist items are missing (never blocks)
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
    v_req   int;
    v_done  int;
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

    select p.full_name into v_name from public.profiles p where p.id = v_uid;
    if v_note is not null then
        if v_field then
            perform private.post_system_message(v.case_id,
                'Note from ' || coalesce(v_name, 'the operator') || ' on completing "' || v.title || '": ' || v_note, v.id);
        else
            perform private.post_system_message(v.case_id,
                'Note on completing "' || v.title || '" (' || coalesce(v_name, 'staff') || '): ' || v_note,
                v.id, 'system', null, 'staff');
        end if;
    end if;

    -- required checklist items not collected: tell the office (same "done" as v_case_checklist / the web)
    select count(*)::int,
           count(*) filter (where k.status <> 'pending' or coalesce(k.evidence_count, 0) > 0)::int
      into v_req, v_done
      from public.v_case_checklist k
     where k.task_id = v.id and k.is_mandatory;
    if v_req > 0 and v_done < v_req then
        perform private.post_system_message(v.case_id,
            'Task completed by ' || coalesce(v_name, case when v_field then 'the operator' else 'staff' end)
            || ' with ' || v_done || ' of ' || v_req || ' required checklist items collected',
            v.id, 'system', null, 'staff');
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
revoke all on function public.complete_field_task(uuid, text) from public, anon;
grant execute on function public.complete_field_task(uuid, text) to authenticated, service_role;
