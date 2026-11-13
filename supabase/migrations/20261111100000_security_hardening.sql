-- =====================================================================
-- Security hardening of the Phase 1 schema (M1 1.1 / 1.3)
--
-- Fixes found when applying 20261111000000_phase1_initial_schema.sql to a
-- real Supabase stack and testing RLS per role:
--
--  A. Security-definer helpers lived in the API-exposed `public` schema and
--     were callable via RPC by anon. Moved to a non-exposed `private` schema.
--  B. Functions without a fixed search_path (search-path hijack risk).
--  C. Deactivated field users kept access: field policies only checked
--     assignee_id/captured_by = auth.uid(), not role/is_active.
--  D. tasks_field_guard let field users change reason, location, created_by,
--     timestamps; and reopen / cancel tasks.
--  E. Field users could update any column of their checklist items
--     (e.g. clear camera_only to dodge gallery flagging, change is_mandatory).
--  F. evidence_guard left mime_type, size_bytes, device_info, gps_accuracy_m,
--     created_at mutable; staff could insert evidence as another user;
--     evidence could reference a checklist item / task of another case.
--  G. SHA-256 values were not format-checked.
--  H. Policies applied to PUBLIC (incl. anon) and anon kept default table
--     privileges; anon now has no access to the public schema's tables.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Private schema for security-definer helpers (not exposed by the API)
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- RLS policies and triggers reference functions by OID, so moving them is safe.
alter function public.current_user_role()          set schema private;
alter function public.field_can_see_case(uuid)     set schema private;
alter function public.cases_status_history()       set schema private;
alter function public.audit_row()                  set schema private;

create or replace function private.current_user_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
    select p.role from public.profiles p where p.id = (select auth.uid()) and p.is_active;
$$;

create or replace function private.field_can_see_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.tasks t
                   where t.case_id = p_case_id and t.assignee_id = (select auth.uid()));
$$;

create or replace function private.cases_status_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        insert into public.case_status_history (case_id, from_status, to_status, changed_by)
        values (new.id, null, new.status, auth.uid());
    elsif new.status is distinct from old.status then
        insert into public.case_status_history (case_id, from_status, to_status, changed_by)
        values (new.id, old.status, new.status, auth.uid());
        if new.status = 'closed' and new.closed_at is null then
            new.closed_at := now();
        end if;
    end if;
    return new;
end $$;

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (auth.uid(), tg_op, tg_table_name,
            coalesce(new.id, old.id),
            case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
            case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
    return coalesce(new, old);
end $$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.current_user_role()      to authenticated, service_role;
grant execute on function private.field_can_see_case(uuid) to authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public, anon;

-- Public role helpers (security invoker) now call the private helper.
create or replace function public.is_staff() returns boolean
language sql stable set search_path = '' as $$
    select coalesce(private.current_user_role() in ('admin','orchestrator','office'), false);
$$;

create or replace function public.is_admin() returns boolean
language sql stable set search_path = '' as $$
    select coalesce(private.current_user_role() = 'admin', false);
$$;

create or replace function public.is_field() returns boolean
language sql stable set search_path = '' as $$
    select coalesce(private.current_user_role() = 'field', false);
$$;

-- ---------------------------------------------------------------------
-- B. Fixed search_path on the remaining functions
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
    new.updated_at := now();
    return new;
end $$;

create or replace function public.cases_before_insert() returns trigger
language plpgsql set search_path = '' as $$
declare v_tat int;
begin
    if new.case_ref is null then
        new.case_ref := 'INV-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('public.case_ref_seq')::text, 6, '0');
    end if;
    if new.due_at is null then
        select i.tat_days into v_tat from public.insurers i where i.id = new.insurer_id;
        new.due_at := new.received_at + make_interval(days => coalesce(v_tat, 15));
    end if;
    return new;
end $$;

create or replace function public.apply_checklist_template(p_task_id uuid, p_template_id uuid)
returns int language sql set search_path = '' as $$
    with ins as (
        insert into public.task_checklist_items
            (task_id, source_template_item_id, position, description,
             required_evidence_type, is_mandatory, camera_only)
        select p_task_id, i.id, i.position, i.description,
               i.required_evidence_type, i.is_mandatory, i.camera_only
        from public.checklist_template_items i
        where i.template_id = p_template_id
        order by i.position
        returning 1
    )
    select count(*)::int from ins;
$$;

create or replace function public.evidence_autoflag() returns trigger
language plpgsql set search_path = '' as $$
begin
    if new.capture_source = 'gallery' and exists (
        select 1 from public.task_checklist_items c where c.id = new.checklist_item_id and c.camera_only
    ) then
        new.is_flagged  := true;
        new.flag_reason := coalesce(new.flag_reason, 'Gallery upload on camera-only item');
    end if;
    new.server_received_at := now();    -- never trust client-supplied server time
    new.created_at         := now();
    return new;
end $$;

-- ---------------------------------------------------------------------
-- C. Field policies require an active field profile
-- ---------------------------------------------------------------------
drop policy p_cases_field      on public.cases;
drop policy p_parties_field    on public.parties;
drop policy p_tasks_field_r    on public.tasks;
drop policy p_tasks_field_u    on public.tasks;
drop policy p_check_field_r    on public.task_checklist_items;
drop policy p_check_field_u    on public.task_checklist_items;
drop policy p_evidence_field_r on public.evidence;
drop policy p_evidence_field_w on public.evidence;
drop policy p_evidence_staff_w on public.evidence;
drop policy p_insurers_read    on public.insurers;
drop policy p_profiles_self    on public.profiles;

-- Own profile stays readable even when inactive (so the app can say "not active").
create policy p_profiles_self on public.profiles for select to authenticated
    using (id = (select auth.uid()) or public.is_staff());

create policy p_insurers_read on public.insurers for select to authenticated
    using (public.is_staff() or public.is_field());

create policy p_cases_field on public.cases for select to authenticated
    using (public.is_field() and private.field_can_see_case(id));
create policy p_parties_field on public.parties for select to authenticated
    using (public.is_field() and private.field_can_see_case(case_id));

create policy p_tasks_field_r on public.tasks for select to authenticated
    using (public.is_field() and assignee_id = (select auth.uid()));
create policy p_tasks_field_u on public.tasks for update to authenticated
    using      (public.is_field() and assignee_id = (select auth.uid()))
    with check (public.is_field() and assignee_id = (select auth.uid()));

create policy p_check_field_r on public.task_checklist_items for select to authenticated
    using (public.is_field() and exists (
        select 1 from public.tasks t where t.id = task_id and t.assignee_id = (select auth.uid())));
create policy p_check_field_u on public.task_checklist_items for update to authenticated
    using (public.is_field() and exists (
        select 1 from public.tasks t where t.id = task_id and t.assignee_id = (select auth.uid())
          and t.status in ('pending','in_progress')))
    with check (public.is_field() and exists (
        select 1 from public.tasks t where t.id = task_id and t.assignee_id = (select auth.uid())
          and t.status in ('pending','in_progress')));

create policy p_evidence_field_r on public.evidence for select to authenticated
    using (public.is_field() and captured_by = (select auth.uid()));
create policy p_evidence_field_w on public.evidence for insert to authenticated with check (
    public.is_field()
    and captured_by = (select auth.uid())
    and capture_source in ('camera','gallery')
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.case_id = evidence.case_id
                  and t.assignee_id = (select auth.uid())
                  and t.status in ('pending','in_progress'))
);
-- Staff may add evidence (e.g. web upload) but only in their own name.
create policy p_evidence_staff_w on public.evidence for insert to authenticated
    with check (public.is_staff() and captured_by = (select auth.uid()));

-- ---------------------------------------------------------------------
-- D. Field users: status-only task updates, forward-only, server timestamps
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- E. Field users: checklist items — status/note only
-- ---------------------------------------------------------------------
create or replace function public.checklist_field_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if public.is_field() then
        if (to_jsonb(new) - array['status','note','completed_at','updated_at'])
           is distinct from
           (to_jsonb(old) - array['status','note','completed_at','updated_at']) then
            raise exception 'Field users may only update checklist item status and note'
                using errcode = '42501';
        end if;
        if new.status = 'waived' and old.status is distinct from 'waived' then
            raise exception 'Only office staff may waive a checklist item' using errcode = '42501';
        end if;
        new.completed_at := case when new.status in ('captured','not_available')
                                 then coalesce(case when new.status = old.status then old.completed_at end, now())
                            end;
    end if;
    return new;
end $$;
create trigger trg_checklist_field_guard before update on public.task_checklist_items
    for each row execute function public.checklist_field_guard();

-- ---------------------------------------------------------------------
-- F. Evidence: immutability of every column except the flag (and FK set-null),
--    and consistency of case / task / checklist item / storage path
-- ---------------------------------------------------------------------
create or replace function public.evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Evidence records cannot be deleted' using errcode = '42501';
    end if;
    if (to_jsonb(new) - array['is_flagged','flag_reason','checklist_item_id'])
       is distinct from
       (to_jsonb(old) - array['is_flagged','flag_reason','checklist_item_id']) then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    -- checklist link may only be cleared (ON DELETE SET NULL of the checklist item)
    if new.checklist_item_id is distinct from old.checklist_item_id and new.checklist_item_id is not null then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    return new;
end $$;

create or replace function public.evidence_validate() returns trigger
language plpgsql set search_path = '' as $$
declare v_task_case uuid; v_item_task uuid;
begin
    if new.task_id is not null then
        select t.case_id into v_task_case from public.tasks t where t.id = new.task_id;
        if v_task_case is distinct from new.case_id then
            raise exception 'Evidence task does not belong to the case' using errcode = '23514';
        end if;
    end if;
    if new.checklist_item_id is not null then
        select c.task_id into v_item_task from public.task_checklist_items c where c.id = new.checklist_item_id;
        if new.task_id is null or v_item_task is distinct from new.task_id then
            raise exception 'Evidence checklist item does not belong to the task' using errcode = '23514';
        end if;
    end if;
    -- Storage path convention for task evidence: cases/{case_id}/tasks/{task_id}/{sha256}.{ext}
    if new.storage_path is not null and new.task_id is not null
       and new.capture_source in ('camera','gallery','web_upload')
       and new.storage_path !~ ('^cases/' || new.case_id::text || '/tasks/' || new.task_id::text
                                || '/' || new.sha256 || '\.[a-z0-9]{1,8}$') then
        raise exception 'Evidence storage_path must be cases/{case_id}/tasks/{task_id}/{sha256}.{ext}'
            using errcode = '23514';
    end if;
    return new;
end $$;
create trigger trg_evidence_validate before insert on public.evidence
    for each row execute function public.evidence_validate();

-- ---------------------------------------------------------------------
-- G. SHA-256 format (lowercase hex, 64 chars)
-- ---------------------------------------------------------------------
alter table public.evidence
    add constraint evidence_sha256_format check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
alter table public.email_attachments
    add constraint email_attachments_sha256_format check (sha256 ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------
-- H. No anonymous access at all. Policies are scoped to `authenticated`
--    and anon loses its default table privileges in public.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
    for r in select policyname, tablename from pg_policies
             where schemaname = 'public' and roles = '{public}'
    loop
        execute format('alter policy %I on public.%I to authenticated', r.policyname, r.tablename);
    end loop;
end $$;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------------
-- Function privileges: nothing is callable by anon; trigger functions by nobody
-- ---------------------------------------------------------------------
revoke execute on function public.is_staff(), public.is_admin(), public.is_field() from public, anon;
grant  execute on function public.is_staff(), public.is_admin(), public.is_field() to authenticated, service_role;

revoke execute on function public.apply_checklist_template(uuid, uuid) from public, anon;
grant  execute on function public.apply_checklist_template(uuid, uuid) to authenticated, service_role;

revoke execute on function
    public.set_updated_at(), public.cases_before_insert(), public.evidence_guard(),
    public.evidence_autoflag(), public.evidence_validate(), public.tasks_field_guard(),
    public.checklist_field_guard()
from public, anon, authenticated;
