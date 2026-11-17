-- =====================================================================
-- Report preview for locked cases (7.7, D51)
--
-- prepare_report_version() refuses a case whose status no longer allows a new version (waiting for
-- approval, submitted, closed, cancelled), so the preview of a finished report showed "No preview".
-- Looking at a report changes nothing, so the preview may use the same data in every status.
--
--   public.prepare_report_preview(case)   same payload as prepare_report_version(), same access rules
--                                          (office staff on a case they manage, orchestrator, admin;
--                                          the case must have a template), but no editable-status check.
--
-- Generating a version is unchanged: create_report_version() and prepare_report_version() keep the
-- status guard. The relaxed path is read-only: the status check is skipped only for a non-locking call
-- made through prepare_report_preview (transaction-local setting `app.report_preview`); a locking
-- call (create_report_version) always checks the status, whatever the setting says.
-- =====================================================================

create or replace function private.report_generation_case(p_case_id uuid, p_lock boolean) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare
    v_case    public.cases;
    v_preview boolean := (not p_lock) and coalesce(current_setting('app.report_preview', true), '') = 'on';
begin
    if not public.is_staff() then
        raise exception 'Only office staff can generate reports' using errcode = '42501';
    end if;
    if p_lock then
        select * into v_case from public.cases c where c.id = p_case_id for update;
    else
        select * into v_case from public.cases c where c.id = p_case_id;
    end if;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can generate this report' using errcode = '42501';
    end if;
    if not v_preview and not private.report_editable_status(v_case.status) then
        raise exception '%', case v_case.status
            when 'orchestrator_review' then 'The report is waiting for approval or approved, so no new version can be made'
            when 'submitted' then private.submitted_case_message()
            when 'closed' then 'The case is closed'
            else 'The case is cancelled' end
            using errcode = '55000';
    end if;
    if v_case.template_id is null then
        raise exception 'This case has no template' using errcode = '22023';
    end if;
    return v_case;
end $$;
revoke all on function private.report_generation_case(uuid, boolean) from public, anon, authenticated;

-- Security invoker: the access checks run inside prepare_report_version() as for the caller.
create or replace function public.prepare_report_preview(p_case_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare v_result jsonb;
begin
    perform set_config('app.report_preview', 'on', true);
    v_result := public.prepare_report_version(p_case_id);
    perform set_config('app.report_preview', 'off', true);
    return v_result;
end $$;
revoke all on function public.prepare_report_preview(uuid) from public, anon;
grant execute on function public.prepare_report_preview(uuid) to authenticated;
