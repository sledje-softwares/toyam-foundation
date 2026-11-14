-- =====================================================================
-- D44: office employees see only the cases assigned to them
--
-- An `office` user sees a case only while cases.office_owner_id = auth.uid(),
-- and with it everything that hangs off the case (field values, history,
-- assignments, thread incl. staff notes, evidence + labels / OCR / matches /
-- suggestions / jobs, tasks, checklist items, task holds, linked emails and
-- extractions, reports, report files / annexures / approvals, submissions,
-- parties, entities). `orchestrator` and `admin` keep full access. Unassigned
-- cases are visible to orchestrator / admin only. Field access is unchanged.
--
-- Intake queue: emails and extractions not yet linked to a case stay visible
-- to all staff (as before); once linked they follow the case.
--
-- Storage: `email-raw` objects are readable by an office user only when they
-- belong to an email / attachment / evidence row the user can see. `reports`
-- objects: office users only under cases/{case_id}/... of their own cases, or
-- a path recorded on a report / report file of their case.
--
-- create_field_task() and reassign_case() are not changed here (hardened in
-- a later migration). create_field_task is security invoker, so its inserts
-- now pass through the scoped task / checklist policies below.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Helpers (security definer, empty search_path, not exposed by the API)
-- ---------------------------------------------------------------------
create or replace function private.can_manage_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then exists (select 1 from public.cases c where c.id = p_case_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;
revoke all on function private.can_manage_case(uuid) from public, anon;
grant execute on function private.can_manage_case(uuid) to authenticated, service_role;

-- Row-level form for cases (works in WITH CHECK of an INSERT, where the row is not yet visible)
create or replace function private.can_manage_case_owner(p_office_owner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then p_office_owner_id is not null and p_office_owner_id = (select auth.uid())
    else false end
$$;

create or replace function private.can_manage_task(p_task_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then exists (select 1 from public.tasks t join public.cases c on c.id = t.case_id
                                where t.id = p_task_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;

create or replace function private.can_manage_evidence(p_evidence_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then exists (select 1 from public.evidence e join public.cases c on c.id = e.case_id
                                where e.id = p_evidence_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;

create or replace function private.can_manage_report(p_report_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then exists (select 1 from public.reports r join public.cases c on c.id = r.case_id
                                where r.id = p_report_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;

-- Intake rows: unlinked -> any staff (review queue); linked -> follows the case
create or replace function private.can_manage_intake(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_case_id is null then coalesce(private.current_user_role() in ('admin', 'orchestrator', 'office'), false)
              else private.can_manage_case(p_case_id) end
$$;

create or replace function private.can_manage_email(p_email_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.can_manage_intake(e.case_id) from public.emails e where e.id = p_email_id), false)
$$;

-- Office users see the phone outbox of operators who hold / held a task on one of their cases
create or replace function private.can_see_operator_outbox(p_profile_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then exists (select 1 from public.task_holds h
                                 join public.tasks t on t.id = h.task_id
                                 join public.cases c on c.id = t.case_id
                                where h.profile_id = p_profile_id and c.office_owner_id = (select auth.uid()))
    else false end
$$;

-- Storage: bucket email-raw (raw .eml, attachments, insurer files used as evidence)
create or replace function private.can_read_email_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then
         exists (select 1 from public.emails e
                  where e.raw_storage_path = p_name and private.can_manage_intake(e.case_id))
      or exists (select 1 from public.email_attachments a join public.emails e on e.id = a.email_id
                  where a.storage_path = p_name and private.can_manage_intake(e.case_id))
      or exists (select 1 from public.evidence ev
                  where ev.storage_backend = 'supabase' and ev.storage_path = p_name
                    and private.can_manage_case(ev.case_id))
    else false end
$$;

-- Storage: bucket reports. Convention for new objects: cases/{case_id}/...
create or replace function private.can_access_report_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then
         (split_part(p_name, '/', 1) = 'cases'
          and split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and split_part(p_name, '/', 3) <> ''
          and private.can_manage_case(split_part(p_name, '/', 2)::uuid))
      or exists (select 1 from public.reports r where r.storage_path = p_name and private.can_manage_case(r.case_id))
      or exists (select 1 from public.report_files f join public.reports r on r.id = f.report_id
                  where f.storage_path = p_name and private.can_manage_case(r.case_id))
    else false end
$$;

revoke all on function
    private.can_manage_case_owner(uuid), private.can_manage_task(uuid), private.can_manage_evidence(uuid),
    private.can_manage_report(uuid), private.can_manage_intake(uuid), private.can_manage_email(uuid),
    private.can_see_operator_outbox(uuid), private.can_read_email_object(text), private.can_access_report_object(text)
from public, anon;
grant execute on function
    private.can_manage_case_owner(uuid), private.can_manage_task(uuid), private.can_manage_evidence(uuid),
    private.can_manage_report(uuid), private.can_manage_intake(uuid), private.can_manage_email(uuid),
    private.can_see_operator_outbox(uuid), private.can_read_email_object(text), private.can_access_report_object(text)
to authenticated, service_role;

create index if not exists ix_emails_raw_path      on public.emails (raw_storage_path) where raw_storage_path is not null;
create index if not exists ix_attach_storage_path  on public.email_attachments (storage_path);
create index if not exists ix_cases_office_owner   on public.cases (office_owner_id);

-- ---------------------------------------------------------------------
-- 2. Table policies: staff-wide -> case-scoped
-- ---------------------------------------------------------------------
-- cases
drop policy p_cases_staff on public.cases;
create policy p_cases_staff on public.cases for all to authenticated
    using (private.can_manage_case(id))
    with check (private.can_manage_case_owner(office_owner_id));

-- case satellites keyed by case_id
drop policy p_parties_staff on public.parties;
create policy p_parties_staff on public.parties for all to authenticated
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

drop policy p_case_ent_staff on public.case_entities;
create policy p_case_ent_staff on public.case_entities for all to authenticated
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

drop policy p_hist_staff on public.case_status_history;
create policy p_hist_staff on public.case_status_history for select to authenticated
    using (private.can_manage_case(case_id));

drop policy p_cfv_staff on public.case_field_values;
create policy p_cfv_staff on public.case_field_values for all to authenticated
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

drop policy p_assignments_read on public.case_assignments;
create policy p_assignments_read on public.case_assignments for select to authenticated
    using (private.can_manage_case(case_id));

-- thread (incl. staff-only notes)
drop policy p_msg_staff_r on public.case_messages;
create policy p_msg_staff_r on public.case_messages for select to authenticated
    using (private.can_manage_case(case_id));
drop policy p_msg_staff_w on public.case_messages;
create policy p_msg_staff_w on public.case_messages for insert to authenticated
    with check (private.can_manage_case(case_id) and sender_id = (select auth.uid())
                and kind in ('text', 'media', 'voice'));

drop policy p_reads_own on public.case_thread_reads;
create policy p_reads_own on public.case_thread_reads for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid())
                and (private.can_manage_case(case_id) or (public.is_field() and private.field_can_see_case(case_id))));

-- tasks, checklist items, holds
-- Staff read and insert (create_field_task is security invoker and inserts as the caller). No staff
-- UPDATE / DELETE policy: changes go through the task RPCs (security definer), so they cannot be
-- bypassed with a direct table write. Field status updates (p_tasks_field_u) are unchanged.
drop policy p_tasks_staff on public.tasks;
create policy p_tasks_staff_r on public.tasks for select to authenticated
    using (private.can_manage_case(case_id));
create policy p_tasks_staff_i on public.tasks for insert to authenticated
    with check (private.can_manage_case(case_id));

drop policy p_checklist_staff on public.task_checklist_items;
create policy p_checklist_staff on public.task_checklist_items for all to authenticated
    using (private.can_manage_task(task_id)) with check (private.can_manage_task(task_id));

drop policy p_task_holds_staff on public.task_holds;
create policy p_task_holds_staff on public.task_holds for select to authenticated
    using (private.can_manage_task(task_id));

drop policy p_outbox_staff_r on public.device_outbox_status;
create policy p_outbox_staff_r on public.device_outbox_status for select to authenticated
    using (private.can_see_operator_outbox(profile_id));

-- email intake
drop policy p_emails_staff on public.emails;
create policy p_emails_staff on public.emails for all to authenticated
    using (private.can_manage_intake(case_id)) with check (private.can_manage_intake(case_id));

drop policy p_attach_staff on public.email_attachments;
create policy p_attach_staff on public.email_attachments for all to authenticated
    using (private.can_manage_email(email_id)) with check (private.can_manage_email(email_id));

drop policy p_extract_staff on public.intake_extractions;
create policy p_extract_staff on public.intake_extractions for all to authenticated
    using (private.can_manage_intake(case_id)) with check (private.can_manage_intake(case_id));

-- evidence and what the pipeline derives from it
drop policy p_evidence_staff_r on public.evidence;
create policy p_evidence_staff_r on public.evidence for select to authenticated
    using (private.can_manage_case(case_id));
drop policy p_evidence_staff_w on public.evidence;
create policy p_evidence_staff_w on public.evidence for insert to authenticated
    with check (private.can_manage_case(case_id) and captured_by = (select auth.uid()));
drop policy p_evidence_staff_u on public.evidence;
create policy p_evidence_staff_u on public.evidence for update to authenticated   -- flags / relevance only (trigger enforces)
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

drop policy p_ocr_staff on public.evidence_ocr;
create policy p_ocr_staff on public.evidence_ocr for select to authenticated
    using (private.can_manage_evidence(evidence_id));

drop policy p_labels_read on public.evidence_labels;
create policy p_labels_read on public.evidence_labels for select to authenticated
    using (private.can_manage_evidence(evidence_id)
           or (public.is_field() and exists (select 1 from public.evidence e where e.id = evidence_id)));
drop policy p_labels_staff_w on public.evidence_labels;
create policy p_labels_staff_w on public.evidence_labels for insert to authenticated
    with check (private.can_manage_evidence(evidence_id) and source in ('human', 'operator'));

drop policy p_field_matches_staff on public.evidence_field_matches;
create policy p_field_matches_staff on public.evidence_field_matches for select to authenticated
    using (private.can_manage_evidence(evidence_id));

drop policy p_suggest_staff on public.field_suggestions;
create policy p_suggest_staff on public.field_suggestions for select to authenticated
    using (private.can_manage_evidence(evidence_id));
drop policy p_suggest_staff_u on public.field_suggestions;
create policy p_suggest_staff_u on public.field_suggestions for update to authenticated
    using (private.can_manage_evidence(evidence_id)) with check (private.can_manage_evidence(evidence_id));

drop policy p_jobs_read on public.processing_jobs;
create policy p_jobs_read on public.processing_jobs for select to authenticated
    using (private.can_manage_evidence(evidence_id)
           or (public.is_field() and exists (select 1 from public.evidence e where e.id = evidence_id)));

-- reports, approvals, submissions
drop policy p_reports_staff on public.reports;
create policy p_reports_staff on public.reports for all to authenticated
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

drop policy p_rfiles_staff on public.report_files;
create policy p_rfiles_staff on public.report_files for all to authenticated
    using (private.can_manage_report(report_id)) with check (private.can_manage_report(report_id));

drop policy p_rannex_staff on public.report_annexures;
create policy p_rannex_staff on public.report_annexures for all to authenticated
    using (private.can_manage_report(report_id)) with check (private.can_manage_report(report_id));

drop policy p_approvals_r on public.report_approvals;
create policy p_approvals_r on public.report_approvals for select to authenticated
    using (private.can_manage_case(case_id));
drop policy p_approvals_i on public.report_approvals;
create policy p_approvals_i on public.report_approvals for insert to authenticated
    with check (private.can_manage_case(case_id) and requested_by = (select auth.uid()));
-- p_approvals_u (orchestrator / admin, who see every case) is unchanged

drop policy p_subs_staff on public.submissions;
create policy p_subs_staff on public.submissions for all to authenticated
    using (private.can_manage_case(case_id)) with check (private.can_manage_case(case_id));

-- ---------------------------------------------------------------------
-- 3. Storage policies
-- ---------------------------------------------------------------------
drop policy email_raw_staff_select on storage.objects;
create policy email_raw_staff_select on storage.objects for select to authenticated
    using (bucket_id = 'email-raw' and private.can_read_email_object(name));

drop policy reports_staff_select on storage.objects;
create policy reports_staff_select on storage.objects for select to authenticated
    using (bucket_id = 'reports' and private.can_access_report_object(name));
drop policy reports_staff_insert on storage.objects;
create policy reports_staff_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'reports' and private.can_access_report_object(name));
drop policy reports_staff_update on storage.objects;
create policy reports_staff_update on storage.objects for update to authenticated
    using (bucket_id = 'reports' and private.can_access_report_object(name))
    with check (bucket_id = 'reports' and private.can_access_report_object(name));

-- ---------------------------------------------------------------------
-- 4. Security-definer RPCs called by staff with a case / task / evidence id
-- ---------------------------------------------------------------------
create or replace function public.can_upload_case_file(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(private.can_manage_case(p_case_id) and exists (select 1 from public.cases c where c.id = p_case_id), false);
$$;

create or replace function public.can_upload_evidence(p_task_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(
        (public.is_staff() and exists (select 1 from public.tasks t
                                        where t.id = p_task_id and private.can_manage_case(t.case_id)))
        or (public.is_field() and exists (
                select 1 from public.tasks t
                where t.id = p_task_id
                  and t.assignee_id = (select auth.uid())
                  and t.status in ('pending', 'in_progress'))),
        false);
$$;

create or replace function public.case_field_history(p_case_id uuid)
returns table (changed_at timestamptz, actor_id uuid, actor_name text, action text, field_key text,
               old_value text, new_value text, source text)
language sql stable security definer set search_path = '' as $$
    select a.at, a.actor_id, p.full_name, a.action,
           f.key,
           a.old_data ->> 'value', a.new_data ->> 'value',
           coalesce(a.new_data ->> 'source', a.old_data ->> 'source')
      from public.audit_log a
      left join public.profiles p on p.id = a.actor_id
      left join public.case_template_fields f on f.id = coalesce(a.new_data ->> 'field_id', a.old_data ->> 'field_id')::uuid
     where private.can_manage_case(p_case_id)
       and a.table_name = 'case_field_values'
       and coalesce(a.new_data ->> 'case_id', a.old_data ->> 'case_id') = p_case_id::text
     order by a.at desc, a.id desc;
$$;

create or replace function public.case_outbox_status(p_case_id uuid)
returns table (profile_id uuid, full_name text, is_active boolean, device_id uuid, pending_count int,
               pending_bytes bigint, oldest_pending_at timestamptz, reported_at timestamptz)
language sql stable security definer set search_path = '' as $$
    select p.id, p.full_name, p.is_active, o.device_id, o.pending_count, o.pending_bytes, o.oldest_pending_at, o.reported_at
      from public.profiles p
      join public.device_outbox_status o on o.profile_id = p.id
     where p.id in (select h.profile_id from public.task_holds h join public.tasks t on t.id = h.task_id
                     where t.case_id = p_case_id)
       and (private.can_manage_case(p_case_id)
            or (public.is_field() and p.id = (select auth.uid()) and private.field_can_see_case(p_case_id)))
     order by o.pending_count desc, o.reported_at desc;
$$;

create or replace function public.case_thread_state(p_case_id uuid)
returns table (staff_last_read_at timestamptz, field_last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
    select max(r.last_read_at) filter (where p.role in ('admin', 'orchestrator', 'office')),
           max(r.last_read_at) filter (where p.role = 'field')
      from public.case_thread_reads r join public.profiles p on p.id = r.user_id
     where r.case_id = p_case_id
       and (private.can_manage_case(p_case_id) or (public.is_field() and private.field_can_see_case(p_case_id)));
$$;

create or replace function public.evidence_upload_target(p_task_id uuid, p_sha256 text[])
returns table (case_id uuid, stored_sha256 text[])
language plpgsql stable security definer set search_path = '' as $$
declare
    v_uid  uuid := (select auth.uid());
    v_case uuid;
begin
    if p_sha256 is null or cardinality(p_sha256) not between 1 and 30
       or exists (select 1 from unnest(p_sha256) s where s is null or s !~ '^[0-9a-f]{64}$') then
        raise exception 'sha256 must be 1-30 values of 64 lower-case hex characters' using errcode = '22023';
    end if;
    select t.case_id into v_case from public.tasks t
     where t.id = p_task_id
       and ((public.is_staff() and private.can_manage_case(t.case_id))
            or (public.is_field() and (t.assignee_id = v_uid
                or exists (select 1 from public.task_holds h where h.task_id = t.id and h.profile_id = v_uid))));
    if v_case is null then
        raise exception 'Task not found' using errcode = '42501';
    end if;
    return query
        select v_case, coalesce(array(select distinct e.sha256 from public.evidence e
                                       where e.case_id = v_case and e.sha256 = any (p_sha256)), '{}'::text[]);
end $$;

create or replace function public.set_evidence_labels(p_evidence_id uuid, p_category_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v_case uuid;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can correct labels' using errcode = '42501';
    end if;
    select e.case_id into v_case from public.evidence e where e.id = p_evidence_id;
    if not found then
        raise exception 'Evidence not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(v_case) then
        raise exception 'This file belongs to a case assigned to someone else' using errcode = '42501';
    end if;
    update public.evidence_labels l set is_active = false where l.evidence_id = p_evidence_id and l.is_active;
    insert into public.evidence_labels (evidence_id, category_id, confidence, source, created_by)
    select p_evidence_id, c, 1, 'human', (select auth.uid()) from unnest(coalesce(p_category_ids, '{}')) c;
end $$;

create or replace function public.post_staff_note(p_case_id uuid, p_client_message_id uuid, p_body text,
                                                  p_reply_to uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_uid  uuid := (select auth.uid());
    v_id   uuid;
    v_case public.cases;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can write staff notes' using errcode = '42501';
    end if;
    if p_client_message_id is null or nullif(btrim(coalesce(p_body, '')), '') is null then
        raise exception 'client_message_id and a body are required' using errcode = '22023';
    end if;
    select * into v_case from public.cases c where c.id = p_case_id;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'This case is assigned to someone else' using errcode = '42501';
    end if;
    select m.id into v_id from public.case_messages m
     where m.client_message_id = p_client_message_id and m.case_id = p_case_id;
    if v_id is not null then
        return v_id;
    end if;
    insert into public.case_messages (case_id, sender_id, kind, body, reply_to_id, client_message_id, visibility)
    values (p_case_id, v_uid, 'text', btrim(p_body), p_reply_to, p_client_message_id, 'staff')
    returning id into v_id;
    -- tell the case owner (when someone else writes) and the case's orchestrator (when the owner writes)
    if v_case.office_owner_id is not null and v_case.office_owner_id <> v_uid then
        perform private.notify(v_case.office_owner_id, 'staff_note', p_case_id,
                               coalesce(v_case.case_ref, '') || ': note from ' || coalesce((select full_name from public.profiles where id = v_uid), 'staff'),
                               left(btrim(p_body), 200), 'note:' || v_id);
    end if;
    if v_case.orchestrator_id is not null and v_case.orchestrator_id <> v_uid then
        perform private.notify(v_case.orchestrator_id, 'staff_note', p_case_id,
                               coalesce(v_case.case_ref, '') || ': note from ' || coalesce((select full_name from public.profiles where id = v_uid), 'staff'),
                               left(btrim(p_body), 200), 'note:' || v_id);
    end if;
    return v_id;
end $$;

-- After confirm_intake the reviewer may not own the new case (auto-assignment).
-- This returns its reference to the user who confirmed the extraction, and to nobody else.
create or replace function public.intake_confirmed_case_ref(p_extraction_id uuid) returns text
language sql stable security definer set search_path = '' as $$
    select c.case_ref
      from public.intake_extractions x join public.cases c on c.id = x.case_id
     where x.id = p_extraction_id and x.status = 'confirmed'
       and x.reviewed_by = (select auth.uid()) and public.is_staff();
$$;
revoke all on function public.intake_confirmed_case_ref(uuid) from public, anon;
grant execute on function public.intake_confirmed_case_ref(uuid) to authenticated, service_role;
