-- Report guards (gaps G4-G8, G12 from the reports structure pass; D44 ownership, D45 orchestrators edit reports).
--
--  A. save_case_field_values(): the only way staff write report values. Owner / orchestrator / admin
--     (private.can_manage_case, D44/D45), only while the report is editable, atomic compare-and-set per
--     field; conflicting fields are returned with their current value and who / when, not written.
--     Direct staff insert / update / delete on case_field_values is revoked (intake writes through
--     security-definer functions and is unaffected).
--  B. G6: cases.insurer_claim_no / policy_no follow the template fields of the same key (trigger),
--     the unique (insurer_id, insurer_claim_no) is checked with a readable message; clients can no
--     longer change those case columns directly when the template carries the field.
--  C. G5: requesting approval needs the case owner / orchestrator / admin, case in assigned or
--     office_review with no open task, and every required template field filled.
--  D. G7/G8/G12: submissions are records (no update / delete except set-once acknowledgement,
--     sender ids and reopen marks), staff insert only as themselves on cases they manage;
--     record_submission_ack(), record_manual_submission() (portal / other), reopen_case().

-- ---------------------------------------------------------------------
-- 0. D44 helper: created here only if the D44 migration has not created it yet (same body).
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
end
$do$;

-- Statuses in which the report values may change: everything before approval is requested
-- (docs/06 status automation: "Approval requested -> orchestrator_review"; "Submission recorded -> submitted").
create or replace function private.report_editable_status(p_status public.case_status) returns boolean
language sql immutable set search_path = '' as $$
    select p_status in ('received', 'intake_confirmed', 'assigned', 'field_in_progress', 'office_review');
$$;
revoke all on function private.report_editable_status(public.case_status) from public, anon;
grant execute on function private.report_editable_status(public.case_status) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- A. Field values: staff read; writes only through functions
-- ---------------------------------------------------------------------
drop policy p_cfv_staff on public.case_field_values;
create policy p_cfv_staff_r on public.case_field_values for select to authenticated using (public.is_staff());
revoke insert, update, delete, truncate on public.case_field_values from authenticated, anon;

-- p_values:   {"<field key>": "<value>" | null, ...}   (null or blank clears the value)
-- p_expected: {"<field key>": "<value as loaded>" | null, ...}  one entry per key of p_values
-- returns     {"saved": ["key", ...], "conflicts": {"key": {value, source, updated_at, updated_by, updated_by_name}}}
create or replace function public.save_case_field_values(p_case_id uuid, p_values jsonb, p_expected jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_case      public.cases;
    v_key       text;
    v_raw       jsonb;
    v_value     text;
    v_expected  text;
    v_field_id  uuid;
    v_row       public.case_field_values;
    v_saved     text[] := '{}';
    v_conflicts jsonb  := '{}';
begin
    if not public.is_staff() then
        raise exception 'Only office staff can edit reports' using errcode = '42501';
    end if;
    if p_values is null or jsonb_typeof(p_values) <> 'object'
       or p_expected is null or jsonb_typeof(p_expected) <> 'object' then
        raise exception 'Values and expected values must be JSON objects' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(p_values)) > 300 then
        raise exception 'Too many fields in one save' using errcode = '22023';
    end if;

    -- One save per case at a time: the compare-and-set below cannot interleave with another save.
    select * into v_case from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can edit this report' using errcode = '42501';
    end if;
    if not private.report_editable_status(v_case.status) then
        raise exception '%', case v_case.status
            when 'orchestrator_review' then 'The report is waiting for approval or approved, so its values are locked'
            when 'submitted' then 'The report has been sent. Reopen the case to change it'
            when 'closed' then 'The case is closed'
            else 'The case is cancelled' end
            using errcode = '55000';
    end if;
    if v_case.template_id is null then
        raise exception 'This case has no template' using errcode = '22023';
    end if;

    for v_key, v_raw in select * from jsonb_each(p_values) loop
        select f.id into v_field_id from public.case_template_fields f
         where f.template_id = v_case.template_id and f.key = v_key;
        if v_field_id is null then
            raise exception 'Unknown field: %', left(v_key, 80) using errcode = '22023';
        end if;
        if jsonb_typeof(v_raw) not in ('string', 'null') then
            raise exception 'Value of % must be text', v_key using errcode = '22023';
        end if;
        if not (p_expected ? v_key) or jsonb_typeof(p_expected -> v_key) not in ('string', 'null') then
            raise exception 'Expected value of % is missing', v_key using errcode = '22023';
        end if;
        v_value    := nullif(btrim(replace(v_raw #>> '{}', E'\r\n', E'\n'), E' \t\r\n'), '');
        v_expected := p_expected ->> v_key;
        if char_length(v_value) > 20000 then
            raise exception 'Value of % is too long', v_key using errcode = '22023';
        end if;

        v_row := null;
        select * into v_row from public.case_field_values v
         where v.case_id = p_case_id and v.field_id = v_field_id for update;

        -- compare-and-set: the stored value must still be the value the editor loaded
        if btrim(replace(coalesce(v_row.value, ''), E'\r\n', E'\n'), E' \t\r\n')
           is distinct from btrim(replace(coalesce(v_expected, ''), E'\r\n', E'\n'), E' \t\r\n') then
            v_conflicts := v_conflicts || jsonb_build_object(v_key, jsonb_build_object(
                'value', v_row.value,
                'source', v_row.source,
                'updated_at', v_row.updated_at,
                'updated_by', v_row.updated_by,
                'updated_by_name', (select p.full_name from public.profiles p where p.id = v_row.updated_by)));
            continue;
        end if;
        if coalesce(v_row.value, '') = coalesce(v_value, '') then
            continue;   -- nothing changes
        end if;

        if v_row.id is null then
            insert into public.case_field_values (case_id, field_id, value, source)
            values (p_case_id, v_field_id, v_value, 'office');
        else
            update public.case_field_values
               set value = v_value, source = 'office', confidence = null, source_evidence_id = null, source_ref = null
             where id = v_row.id;
        end if;
        v_saved := v_saved || v_key;
    end loop;

    return jsonb_build_object('saved', to_jsonb(v_saved), 'conflicts', v_conflicts);
end $$;
revoke all on function public.save_case_field_values(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_case_field_values(uuid, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- B. G6: case columns follow the template fields insurer_claim_no / policy_no
-- ---------------------------------------------------------------------
create or replace function private.case_field_values_sync_case() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_key  text;
    v_val  text;
    v_case public.cases;
begin
    select f.key into v_key from public.case_template_fields f where f.id = new.field_id;
    if v_key is null or v_key not in ('insurer_claim_no', 'policy_no') then
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
    elsif v_val is distinct from v_case.policy_no then
        update public.cases set policy_no = v_val where id = new.case_id;
    end if;
    return null;
end $$;
create trigger trg_case_field_values_sync_case after insert or update of value on public.case_field_values
    for each row execute function private.case_field_values_sync_case();

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
    end if;
    return new;
end $$;
create trigger trg_cases_mirror_guard before update of insurer_claim_no, policy_no on public.cases
    for each row execute function private.cases_mirror_guard();

-- ---------------------------------------------------------------------
-- C. G5: approval request needs ownership, status and every required field
-- ---------------------------------------------------------------------
create or replace function private.report_approvals_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_case    public.cases;
    v_missing int;
    v_labels  text;
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
    end if;
    return new;
end $$;

-- ---------------------------------------------------------------------
-- D. Submissions: records; acknowledgement, manual / portal submission, reopen
-- ---------------------------------------------------------------------
alter table public.submissions
    add column acknowledged_by uuid references public.profiles(id),
    add column ack_note        text check (char_length(ack_note) <= 1000),
    add column reopened_at     timestamptz,
    add column reopened_by     uuid references public.profiles(id),
    add column reopen_reason   text check (char_length(reopen_reason) <= 500);

drop policy p_subs_staff on public.submissions;
create policy p_subs_staff_r on public.submissions for select to authenticated using (public.is_staff());
create policy p_subs_staff_i on public.submissions for insert to authenticated
    with check (public.is_staff() and submitted_by = (select auth.uid()) and private.can_manage_case(case_id));
revoke update, delete, truncate on public.submissions from authenticated, anon;

-- security invoker on purpose: API roles are held to the record rules; the functions below (owner)
-- check their own rules. Set-once columns: acknowledgement, insurer reference, sender ids, reopen marks.
create or replace function private.submissions_record_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
    c_set_once constant text[] := array['acknowledged_at', 'acknowledged_by', 'ack_note', 'insurer_reference',
                                        'sent_message_id', 'gmail_thread_id', 'reopened_at', 'reopened_by', 'reopen_reason'];
    v_old jsonb;
    v_new jsonb;
    k     text;
begin
    if current_user not in ('authenticated', 'anon', 'service_role') then
        return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
        raise exception 'Submissions are records and cannot be deleted' using errcode = '42501';
    end if;
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    if (v_new - c_set_once) is distinct from (v_old - c_set_once) then
        raise exception 'Only the acknowledgement of a submission can be recorded' using errcode = '42501';
    end if;
    foreach k in array c_set_once loop
        if v_old -> k <> 'null'::jsonb and (v_new -> k) is distinct from (v_old -> k) then
            raise exception '% is already recorded', k using errcode = '42501';
        end if;
    end loop;
    return new;
end $$;
create trigger trg_submissions_record_guard before update or delete on public.submissions
    for each row execute function private.submissions_record_guard();

-- Records the insurer's acknowledgement of a submission (once).
create or replace function public.record_submission_ack(p_submission_id uuid, p_ack_at timestamptz, p_note text,
                                                        p_insurer_reference text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_sub  public.submissions;
    v_at   timestamptz := coalesce(p_ack_at, now());
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_ref  text := nullif(btrim(coalesce(p_insurer_reference, '')), '');
begin
    if not public.is_staff() then
        raise exception 'Only office staff can record acknowledgements' using errcode = '42501';
    end if;
    select * into v_sub from public.submissions s where s.id = p_submission_id for update;
    if not found then
        raise exception 'Submission not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(v_sub.case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can record the acknowledgement' using errcode = '42501';
    end if;
    if v_sub.acknowledged_at is not null then
        raise exception 'The acknowledgement is already recorded' using errcode = '55000';
    end if;
    if v_at > now() + interval '5 minutes' then
        raise exception 'The acknowledgement time cannot be in the future' using errcode = '22023';
    end if;
    if v_at < v_sub.submitted_at - interval '1 day' then
        raise exception 'The acknowledgement cannot be before the report was sent' using errcode = '22023';
    end if;
    if char_length(v_note) > 1000 or char_length(v_ref) > 200 then
        raise exception 'Keep the note under 1000 and the reference under 200 characters' using errcode = '22023';
    end if;
    if v_ref is not null and v_sub.insurer_reference is not null and v_ref <> v_sub.insurer_reference then
        raise exception 'A different insurer reference is already recorded' using errcode = '22023';
    end if;
    update public.submissions
       set acknowledged_at = v_at, acknowledged_by = (select auth.uid()), ack_note = v_note,
           insurer_reference = coalesce(insurer_reference, v_ref)
     where id = v_sub.id;
    perform private.post_system_message(v_sub.case_id,
        'Insurer acknowledged the report (' || to_char(v_at at time zone 'Asia/Kolkata', 'DD Mon YYYY') || ')'
        || coalesce(' — ' || v_note, ''), null, 'system', null, 'staff');
end $$;
revoke all on function public.record_submission_ack(uuid, timestamptz, text, text) from public, anon;
grant execute on function public.record_submission_ack(uuid, timestamptz, text, text) to authenticated;

-- Records a report delivered outside the sender: uploaded to the insurer's portal, or delivered another way.
-- Email submissions are recorded by the sender (8.2) with the message ids. p_report_id null = latest version.
create or replace function public.record_manual_submission(p_case_id uuid, p_channel public.submission_channel,
                                                           p_formats text[], p_insurer_reference text, p_note text,
                                                           p_submitted_at timestamptz default null,
                                                           p_report_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_case   public.cases;
    v_report public.reports;
    v_at     timestamptz := coalesce(p_submitted_at, now());
    v_ref    text := nullif(btrim(coalesce(p_insurer_reference, '')), '');
    v_note   text := nullif(btrim(coalesce(p_note, '')), '');
    v_id     uuid;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can record submissions' using errcode = '42501';
    end if;
    select * into v_case from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can record a submission' using errcode = '42501';
    end if;
    if p_channel is null or p_channel = 'email' then
        raise exception 'Email submissions are recorded by the sender; choose portal or other' using errcode = '22023';
    end if;
    if p_formats is null or cardinality(p_formats) = 0 or cardinality(p_formats) <> (select count(distinct f) from unnest(p_formats) f) then
        raise exception 'Choose the formats that were delivered' using errcode = '22023';
    end if;
    if p_channel = 'portal' and v_ref is null then
        raise exception 'Enter the portal reference number' using errcode = '22023';
    end if;
    if p_channel = 'other' and v_note is null then
        raise exception 'Say how the report was delivered' using errcode = '22023';
    end if;
    if char_length(v_ref) > 200 or char_length(v_note) > 1000 then
        raise exception 'Keep the reference under 200 and the note under 1000 characters' using errcode = '22023';
    end if;
    if v_case.status not in ('assigned', 'office_review', 'orchestrator_review') then
        raise exception '%', case v_case.status
            when 'submitted' then 'The report has already been sent. Reopen the case to send it again'
            when 'field_in_progress' then 'Field work is still open'
            when 'closed' then 'The case is closed'
            when 'cancelled' then 'The case is cancelled'
            else 'The case is not ready to be sent' end
            using errcode = '55000';
    end if;
    select r.* into v_report from public.reports r where r.case_id = p_case_id order by r.version desc limit 1;
    if v_report.id is null then
        raise exception 'Generate a report version first' using errcode = '55000';
    end if;
    if p_report_id is not null and p_report_id <> v_report.id then
        raise exception 'Only the latest report version can be recorded as sent' using errcode = '22023';
    end if;
    if v_at > now() + interval '5 minutes' or v_at < v_report.created_at then
        raise exception 'The submission time must be between the report version''s creation and now' using errcode = '22023';
    end if;
    -- submissions_guard checks the approval and the formats the template allows
    insert into public.submissions (case_id, report_id, channel, submitted_at, submitted_by, insurer_reference, notes, formats)
    values (p_case_id, v_report.id, p_channel, v_at, (select auth.uid()), v_ref, v_note, p_formats)
    returning id into v_id;
    return v_id;
end $$;
revoke all on function public.record_manual_submission(uuid, public.submission_channel, text[], text, text, timestamptz, uuid) from public, anon;
grant execute on function public.record_manual_submission(uuid, public.submission_channel, text[], text, text, timestamptz, uuid) to authenticated;

-- Reopens a submitted case on an insurer's query: submitted -> office_review (the report is editable again
-- and needs a new version and approval), reason in the status history, staff-only thread event, owner notified.
create or replace function public.reopen_case(p_case_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_case   public.cases;
    v_uid    uuid := (select auth.uid());
    v_reason text := btrim(coalesce(p_reason, ''));
    v_sub    uuid;
    v_name   text;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can reopen cases' using errcode = '42501';
    end if;
    select * into v_case from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can reopen this case' using errcode = '42501';
    end if;
    if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
        raise exception 'A reason of 3 to 500 characters is required' using errcode = '22023';
    end if;
    if v_case.status <> 'submitted' then
        raise exception 'Only a submitted case can be reopened' using errcode = '55000';
    end if;

    update public.cases set status = 'office_review' where id = p_case_id;
    update public.case_status_history h set note = 'Reopened: ' || v_reason
     where h.id = (select max(x.id) from public.case_status_history x
                    where x.case_id = p_case_id and x.from_status = 'submitted' and x.to_status = 'office_review');

    select s.id into v_sub from public.submissions s where s.case_id = p_case_id
     order by s.submitted_at desc, s.id desc limit 1;
    if v_sub is not null then
        update public.submissions set reopened_at = now(), reopened_by = v_uid, reopen_reason = v_reason
         where id = v_sub and reopened_at is null;
    end if;

    select p.full_name into v_name from public.profiles p where p.id = v_uid;
    perform private.post_system_message(p_case_id,
        'Case reopened by ' || coalesce(v_name, 'staff') || ': ' || v_reason, null, 'system', null, 'staff');
    if v_case.office_owner_id is null then
        perform private.notify_orchestrators('case_reopened', p_case_id, coalesce(v_case.case_ref, '') || ': case reopened',
                                             v_reason, 'case_reopened:' || coalesce(v_sub::text, p_case_id::text));
    elsif v_case.office_owner_id <> v_uid then
        perform private.notify(v_case.office_owner_id, 'case_reopened', p_case_id,
                               coalesce(v_case.case_ref, '') || ': case reopened', v_reason,
                               'case_reopened:' || coalesce(v_sub::text, p_case_id::text));
    end if;
end $$;
revoke all on function public.reopen_case(uuid, text) from public, anon;
grant execute on function public.reopen_case(uuid, text) to authenticated;
