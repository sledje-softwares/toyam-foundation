-- =====================================================================
-- D30-D32 (2026-11-14)
--   A. Staff-only messages in the case thread (visibility 'staff'): orchestrator ↔ office
--      discussion that field operators never see; assignment and sending events are staff-only.
--   B. Orchestrator live view of the report being filled: v_report_progress, case_field_history().
--   C. LLM labelling as the main path + field-level matching (cross-encoder):
--      evidence_labels.description, evidence_field_matches.
--   D. Realtime publication for the thread, field values, labels and notifications.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Staff-only messages
-- ---------------------------------------------------------------------
alter table public.case_messages
    add column visibility text not null default 'all' check (visibility in ('all', 'staff'));
create index ix_case_messages_case_visibility on public.case_messages (case_id, visibility, created_at);
-- visibility is immutable: case_messages_guard rejects any change other than withdraw.

drop policy p_msg_field_r on public.case_messages;
create policy p_msg_field_r on public.case_messages for select to authenticated
    using (public.is_field() and visibility = 'all' and private.field_can_see_case(case_id));
drop policy p_msg_field_w on public.case_messages;
create policy p_msg_field_w on public.case_messages for insert to authenticated
    with check (public.is_field() and sender_id = (select auth.uid()) and kind in ('text', 'media', 'voice')
                and visibility = 'all' and private.field_can_post(case_id));

-- files posted in a staff-only message stay hidden from field users
drop policy p_evidence_field_r on public.evidence;
create policy p_evidence_field_r on public.evidence for select to authenticated
    using (public.is_field() and (captured_by = (select auth.uid())
           or (message_id is not null and withdrawn_at is null and private.field_can_see_case(case_id)
               and exists (select 1 from public.case_messages m where m.id = message_id and m.visibility = 'all'))));

-- system messages get a visibility (default: everyone on the case)
drop function private.post_system_message(uuid, text, uuid, public.message_kind, uuid);
create function private.post_system_message(p_case_id uuid, p_body text, p_task_id uuid default null,
                                            p_kind public.message_kind default 'system',
                                            p_sender uuid default null, p_visibility text default 'all') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    perform set_config('app.system_message', 'on', true);
    insert into public.case_messages (case_id, sender_id, kind, body, task_id, visibility)
    values (p_case_id, case when p_kind = 'system' then null else p_sender end,
            case when p_kind <> 'system' and p_sender is null then 'system' else p_kind end,
            p_body, p_task_id, p_visibility)
    returning id into v_id;
    perform set_config('app.system_message', 'off', true);
    return v_id;
end $$;
revoke all on function private.post_system_message(uuid, text, uuid, public.message_kind, uuid, text) from public, anon, authenticated;

-- assignment and reassignment reasons are internal
create or replace function private.assign_case(p_case_id uuid, p_assignee uuid, p_method text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
    perform set_config('app.assigning', p_case_id::text, true);
    update public.cases c
       set office_owner_id = p_assignee,
           assignment_method = p_method,
           office_assigned_at = now(),
           status = case when c.status in ('received', 'intake_confirmed') then 'assigned'::public.case_status else c.status end
     where c.id = p_case_id;
    perform set_config('app.assigning', '', true);
    insert into public.case_assignments (case_id, assignee_id, method, assigned_by, reason)
    values (p_case_id, p_assignee, p_method, (select auth.uid()), p_reason);
    select full_name into v_name from public.profiles where id = p_assignee;
    perform private.post_system_message(p_case_id,
        case when p_method = 'auto' then 'Case assigned automatically to ' else 'Case reassigned to ' end
        || coalesce(v_name, 'staff') || coalesce(' — ' || nullif(p_reason, 'Automatic assignment'), ''),
        null, 'system', null, 'staff');
    perform private.notify(p_assignee, 'case_assigned', p_case_id, 'New case assigned to you', p_reason,
                           'case_assigned:' || p_case_id);
end $$;

-- "report sent" is internal too
create or replace function private.submissions_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    update public.cases set status = 'submitted'
     where id = new.case_id and status not in ('submitted', 'closed', 'cancelled');
    perform private.post_system_message(new.case_id, 'Report sent to the insurer (' || new.channel || ')',
                                        null, 'system', null, 'staff');
    return null;
end $$;

-- Staff note: orchestrator ↔ office discussion on a case (never shown to field users)
create or replace function public.post_staff_note(p_case_id uuid, p_client_message_id uuid, p_body text,
                                                  p_reply_to uuid default null) returns uuid
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
    select m.id into v_id from public.case_messages m where m.client_message_id = p_client_message_id;
    if v_id is not null then
        return v_id;
    end if;
    select * into v_case from public.cases c where c.id = p_case_id;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
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

-- ---------------------------------------------------------------------
-- B. Orchestrator live view of the report
-- ---------------------------------------------------------------------
create or replace view public.v_report_progress with (security_invoker = true) as
select c.id                                                                            as case_id,
       s.id                                                                            as section_id,
       s.key                                                                           as section_key,
       s.title,
       s.position,
       count(f.id)                                                                     as fields_total,
       count(f.id) filter (where f.is_required)                                        as required_total,
       count(v.id) filter (where nullif(btrim(v.value), '') is not null)               as fields_filled,
       count(v.id) filter (where f.is_required and nullif(btrim(v.value), '') is not null) as required_filled,
       count(v.id) filter (where v.source = 'email_parser')                            as from_email,
       count(v.id) filter (where v.source = 'suggestion')                              as from_suggestions,
       count(v.id) filter (where v.source in ('office', 'llm'))                        as entered,
       max(v.updated_at)                                                               as last_updated_at,
       (array_agg(v.updated_by order by v.updated_at desc) filter (where v.id is not null))[1] as last_updated_by
  from public.cases c
  join public.case_template_sections s on s.template_id = c.template_id
  left join public.case_template_fields f on f.section_id = s.id
  left join public.case_field_values v on v.case_id = c.id and v.field_id = f.id
 group by c.id, s.id, s.key, s.title, s.position;

-- Who changed which field, from the audit log (staff only; the audit log itself stays admin-only)
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
     where public.is_staff()
       and a.table_name = 'case_field_values'
       and coalesce(a.new_data ->> 'case_id', a.old_data ->> 'case_id') = p_case_id::text
     order by a.at desc, a.id desc;
$$;

-- ---------------------------------------------------------------------
-- C. LLM labels and field-level matching (D30)
-- ---------------------------------------------------------------------
alter table public.evidence_labels add column description text check (char_length(description) <= 1000);

create table public.evidence_field_matches (
    id               uuid primary key default gen_random_uuid(),
    evidence_id      uuid not null references public.evidence(id),
    field_id         uuid not null references public.case_template_fields(id),
    score            real not null check (score between 0 and 1),   -- normalised cross-encoder score
    model            text not null,
    pipeline_version text not null default 'v1',
    created_at       timestamptz not null default now(),
    unique (evidence_id, field_id, pipeline_version)
);
create index ix_evidence_field_matches_field on public.evidence_field_matches (field_id, score desc);
alter table public.evidence_field_matches enable row level security;
create policy p_field_matches_staff on public.evidence_field_matches for select to authenticated using (public.is_staff());
-- written by the pipeline (service role); field users have no access

-- ---------------------------------------------------------------------
-- D. Realtime (Supabase postgres_changes respects RLS)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        foreach t in array array['case_messages', 'case_field_values', 'evidence_labels', 'notifications'] loop
            if not exists (select 1 from pg_publication_tables
                            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
                execute format('alter publication supabase_realtime add table public.%I', t);
            end if;
        end loop;
    end if;
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on table public.evidence_field_matches from anon;
revoke execute on function public.post_staff_note(uuid, uuid, text, uuid), public.case_field_history(uuid) from public, anon;
grant  execute on function public.post_staff_note(uuid, uuid, text, uuid), public.case_field_history(uuid) to authenticated, service_role;
-- evidence_field_matches is pipeline output (re-creatable), deliberately not audited
