-- =====================================================================
-- D43 (2026-11-14): field app offline experience, server side.
--   A. Settings: late-upload grace (72 h) and drain window (7 days).
--   B. profiles.deactivated_at (server clock, set by trigger when is_active goes false).
--   C. task_holds: who held which task from when until when (server clock). Basis for late
--      uploads after a task is completed, cancelled or reassigned.
--   D. private.field_upload_allowed(): one rule for late uploads and for the remote-sign-out drain.
--   E. private.post_field_files(): shared insert path (message + files, per-item audit).
--      post_thread_message() falls back to it when the caller no longer holds an open task.
--      can_upload_evidence_at() is the presigner check that includes late uploads.
--   F. field_devices: per-device secret (hash only) registered while active; drain_* functions
--      (service role only; the field-drain edge function) let a deactivated operator's phone send
--      files captured before deactivation, then finish.
--   G. device_outbox_status: files waiting on each phone, reported by the app; read by staff.
-- Device time (evidence.device_captured_at) is untrusted (rule 3): it is only accepted inside a
-- server-clock window, and every late / drained file is written to audit_log.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description) values
    ('late_upload_grace_hours', '72', 'Files captured before a task closed or was reassigned are accepted for this long after it'),
    ('drain_window_days',       '7',  'A deactivated operator''s phone may send files captured before deactivation for this long')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- B. Deactivation time
-- ---------------------------------------------------------------------
alter table public.profiles add column deactivated_at timestamptz;
update public.profiles set deactivated_at = updated_at where not is_active;

-- security invoker on purpose: is_archive_writer() must see the real current_user
create or replace function private.profiles_deactivated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        new.deactivated_at := case when new.is_active then null else now() end;
    elsif new.is_active is distinct from old.is_active then
        new.deactivated_at := case when new.is_active then null else now() end;
    elsif new.deactivated_at is distinct from old.deactivated_at and not private.is_archive_writer() then
        raise exception 'deactivated_at is set by the server' using errcode = '42501';
    end if;
    return new;
end $$;
create trigger trg_profiles_deactivated_at before insert or update on public.profiles
    for each row execute function private.profiles_deactivated_at();
revoke all on function private.profiles_deactivated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- C. Task holds (server clock)
-- ---------------------------------------------------------------------
create table public.task_holds (
    id         bigint generated always as identity primary key,
    task_id    uuid        not null references public.tasks(id) on delete cascade,
    profile_id uuid        not null references public.profiles(id) on delete cascade,
    held_from  timestamptz not null default now(),
    held_until timestamptz,
    check (held_until is null or held_until >= held_from)
);
create index ix_task_holds_profile on public.task_holds (profile_id, task_id);
create unique index uq_task_holds_open on public.task_holds (task_id) where held_until is null;

insert into public.task_holds (task_id, profile_id, held_from, held_until)
select t.id, t.assignee_id, t.created_at,
       case when t.status in ('pending', 'in_progress') then null
            else greatest(t.created_at, coalesce(t.completed_at, t.updated_at)) end
  from public.tasks t where t.assignee_id is not null;

create or replace function private.tasks_track_holds() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
    v_new_open boolean := new.status in ('pending', 'in_progress') and new.assignee_id is not null;
    v_old_open boolean := false;
begin
    if tg_op = 'UPDATE' then
        v_old_open := old.status in ('pending', 'in_progress') and old.assignee_id is not null;
        if v_old_open and (not v_new_open or new.assignee_id is distinct from old.assignee_id) then
            update public.task_holds h set held_until = now()
             where h.task_id = old.id and h.held_until is null;
        end if;
    end if;
    if v_new_open and (not v_old_open or new.assignee_id is distinct from old.assignee_id) then
        insert into public.task_holds (task_id, profile_id, held_from) values (new.id, new.assignee_id, now());
    end if;
    return null;
end $$;
create trigger trg_tasks_track_holds after insert or update of status, assignee_id on public.tasks
    for each row execute function private.tasks_track_holds();
revoke all on function private.tasks_track_holds() from public, anon, authenticated;

alter table public.task_holds enable row level security;
create policy p_task_holds_staff on public.task_holds for select to authenticated using (public.is_staff());
revoke all on public.task_holds from anon;
revoke insert, update, delete, truncate on public.task_holds from authenticated;

-- ---------------------------------------------------------------------
-- D. The upload window rule (late uploads and drain)
-- A file captured (device clock) at p_captured_at by p_profile_id is accepted on p_task_id when
-- the profile held the task at that time and the window, by the server clock, is still open:
--   * captured_at >= held_from (task creation or the reassignment to this profile)
--   * captured_at <= held_until (completed / cancelled / reassigned), and < deactivated_at
--   * captured_at <= now()
--   * now() <= held_until + late_upload_grace_hours   (when the hold ended before deactivation)
--   * now() <= deactivated_at + drain_window_days      (when the profile is deactivated)
-- An open hold of an active profile yields no deadline (least(null, null)), so the function is
-- false there: that case is the normal open-task path.
-- ---------------------------------------------------------------------
create or replace function private.field_upload_allowed(p_task_id uuid, p_profile_id uuid, p_captured_at timestamptz)
returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(p_captured_at is not null and p_captured_at <= now() and exists (
        select 1 from public.task_holds h join public.profiles p on p.id = h.profile_id
         where h.task_id = p_task_id and h.profile_id = p_profile_id
           and p_captured_at >= h.held_from
           and (h.held_until is null or p_captured_at <= h.held_until)
           and (p.deactivated_at is null or p_captured_at < p.deactivated_at)
           and now() <= least(
                 case when h.held_until is not null and (p.deactivated_at is null or h.held_until <= p.deactivated_at)
                      then h.held_until + make_interval(hours => private.setting_int('late_upload_grace_hours', 72)) end,
                 case when p.deactivated_at is not null
                      then p.deactivated_at + make_interval(days => private.setting_int('drain_window_days', 7)) end)),
        false);
$$;
revoke all on function private.field_upload_allowed(uuid, uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- E. Shared insert path for late / drained files (owner only; called by definer wrappers)
-- p_mode 'late' (active operator, task no longer open for them) or 'drain' (deactivated operator).
-- Idempotent on client_message_id (same sender) and on (case_id, sha256): a file already stored is
-- skipped, not an error, so a retry never blocks the outbox. Every stored file gets an audit row.
-- ---------------------------------------------------------------------
create or replace function private.post_field_files(
    p_actor uuid, p_mode text, p_device_id uuid,
    p_case_id uuid, p_client_message_id uuid, p_kind public.message_kind, p_body text,
    p_task_id uuid, p_reply_to uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_msg    uuid;
    v_sender uuid;
    v_task   uuid := p_task_id;
    v_item   jsonb;
    v_ev     uuid;
    v_cat    uuid;
    v_at     timestamptz;
    v_hold   public.task_holds;
    v_deact  timestamptz;
    v_n      int := coalesce(jsonb_array_length(case when jsonb_typeof(p_items) = 'array' then p_items end), 0);
begin
    if p_mode not in ('late', 'drain') or p_actor is null then
        raise exception 'Invalid mode' using errcode = '22023';
    end if;
    if p_client_message_id is null then
        raise exception 'client_message_id is required' using errcode = '22023';
    end if;
    select m.id, m.sender_id into v_msg, v_sender from public.case_messages m where m.client_message_id = p_client_message_id;
    if v_msg is not null then
        if v_sender is distinct from p_actor then
            raise exception 'client_message_id is already used' using errcode = '42501';
        end if;
        return v_msg;                                         -- retry of an already stored message
    end if;
    if p_kind not in ('media', 'voice') then
        raise exception 'Only files can be sent after the task closed' using errcode = '22023';
    end if;
    if v_n = 0 then
        raise exception 'A media message needs at least one file' using errcode = '22023';
    end if;
    if v_n > 30 then
        raise exception 'At most 30 files per message' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i) <> 'object') then
        raise exception 'Each file must be an object' using errcode = '22023';
    end if;

    -- task: as given, or the actor's most recent hold on this case whose window covers every file
    if v_task is null then
        select h.task_id into v_task
          from public.task_holds h join public.tasks t on t.id = h.task_id
         where t.case_id = p_case_id and h.profile_id = p_actor
           and not exists (select 1 from jsonb_array_elements(p_items) i
                            where not private.field_upload_allowed(h.task_id, p_actor,
                                      (nullif(i->>'device_captured_at', ''))::timestamptz))
         order by h.held_from desc limit 1;
    end if;
    if v_task is null or not exists (select 1 from public.tasks t where t.id = v_task and t.case_id = p_case_id) then
        raise exception 'No task on this case accepts these files' using errcode = '42501', hint = 'upload_window_closed';
    end if;

    for v_item in select * from jsonb_array_elements(p_items) loop
        v_at := (nullif(v_item->>'device_captured_at', ''))::timestamptz;
        if not private.field_upload_allowed(v_task, p_actor, v_at) then
            raise exception 'File captured outside the upload window' using errcode = '42501', hint = 'upload_window_closed';
        end if;
        if coalesce(v_item->>'capture_source', '') not in ('camera', 'gallery', 'share') then
            raise exception 'capture_source must be camera, gallery or share' using errcode = '22023';
        end if;
        if coalesce(v_item->>'evidence_type', '') not in ('photo', 'video', 'audio', 'document') then
            raise exception 'evidence_type must be photo, video, audio or document' using errcode = '22023';
        end if;
        if coalesce(v_item->>'sha256', '') !~ '^[0-9a-f]{64}$'
           or coalesce(v_item->>'storage_path', '') !~ ('^cases/' || p_case_id::text || '/tasks/' || v_task::text
                                                       || '/' || (v_item->>'sha256') || '\.[a-z0-9]{1,8}$') then
            raise exception 'storage_path must be cases/{case_id}/tasks/{task_id}/{sha256}.{ext}' using errcode = '22023';
        end if;
    end loop;

    if p_reply_to is not null and not exists (select 1 from public.case_messages m
                                               where m.id = p_reply_to and m.case_id = p_case_id and m.visibility = 'all') then
        raise exception 'Reply must be to a message in this thread' using errcode = '22023';
    end if;

    select * into v_hold from public.task_holds h
     where h.task_id = v_task and h.profile_id = p_actor order by h.held_from desc limit 1;
    select p.deactivated_at into v_deact from public.profiles p where p.id = p_actor;

    insert into public.case_messages (case_id, sender_id, kind, body, task_id, reply_to_id, client_message_id)
    values (p_case_id, p_actor, p_kind, nullif(btrim(coalesce(p_body, '')), ''), v_task, p_reply_to, p_client_message_id)
    returning id into v_msg;

    for v_item in select * from jsonb_array_elements(p_items) loop
        v_ev := null;
        insert into public.evidence (case_id, task_id, checklist_item_id, message_id, evidence_type, capture_source,
                                     storage_path, mime_type, size_bytes, sha256, captured_by, original_filename,
                                     device_captured_at, latitude, longitude, gps_accuracy_m, device_info, exif)
        values (p_case_id, v_task,
                (select c.id from public.task_checklist_items c
                  where c.id = nullif(v_item->>'checklist_item_id', '')::uuid and c.task_id = v_task),
                v_msg,
                (v_item->>'evidence_type')::public.evidence_type,
                (v_item->>'capture_source')::public.capture_source,
                v_item->>'storage_path', v_item->>'mime_type', (v_item->>'size_bytes')::bigint,
                v_item->>'sha256', p_actor, v_item->>'original_filename',
                (v_item->>'device_captured_at')::timestamptz,
                (v_item->>'latitude')::double precision, (v_item->>'longitude')::double precision,
                (v_item->>'gps_accuracy_m')::real,
                case when jsonb_typeof(v_item->'device_info') = 'object' then v_item->'device_info' else '{}' end,
                case when jsonb_typeof(v_item->'exif') = 'object' then v_item->'exif' else '{}' end)
        on conflict (case_id, sha256) where sha256 is not null do nothing
        returning id into v_ev;

        insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
        values (p_actor,
                case when v_ev is null then upper(p_mode) || '_UPLOAD_DUPLICATE'
                     else upper(p_mode) || '_UPLOAD' end,
                'evidence', v_ev, null,
                jsonb_build_object('case_id', p_case_id, 'task_id', v_task, 'message_id', v_msg,
                                   'sha256', v_item->>'sha256', 'device_captured_at', v_item->>'device_captured_at',
                                   'held_from', v_hold.held_from, 'held_until', v_hold.held_until,
                                   'deactivated_at', v_deact, 'device_id', p_device_id));
        continue when v_ev is null;

        if nullif(v_item->>'category_code', '') is not null then
            select c.id into v_cat from public.evidence_categories c where c.code = v_item->>'category_code' and c.is_active;
            if v_cat is not null then
                insert into public.evidence_labels (evidence_id, category_id, confidence, source)
                values (v_ev, v_cat, 1, 'operator');
            end if;
        end if;
        if jsonb_typeof(v_item->'ocr') = 'object' and nullif(v_item->'ocr'->>'text', '') is not null then
            insert into public.evidence_ocr (evidence_id, page_no, engine, engine_version, lang, text, blocks, mean_confidence)
            values (v_ev, coalesce((v_item->'ocr'->>'page_no')::int, 1), coalesce(v_item->'ocr'->>'engine', 'device'),
                    v_item->'ocr'->>'engine_version', v_item->'ocr'->>'lang', v_item->'ocr'->>'text',
                    coalesce(v_item->'ocr'->'blocks', '[]'), (v_item->'ocr'->>'mean_confidence')::real);
        end if;
    end loop;
    return v_msg;
end $$;
revoke all on function private.post_field_files(uuid, text, uuid, uuid, uuid, public.message_kind, text, uuid, uuid, jsonb)
    from public, anon, authenticated, service_role;

-- Late path for the signed-in, active field operator (acts only as auth.uid()).
create or replace function private.post_late_message(
    p_case_id uuid, p_client_message_id uuid, p_kind public.message_kind, p_body text,
    p_task_id uuid, p_reply_to uuid, p_items jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_field() then
        raise exception 'Only an active field operator can send late files' using errcode = '42501';
    end if;
    return private.post_field_files((select auth.uid()), 'late', null, p_case_id, p_client_message_id, p_kind,
                                    p_body, p_task_id, p_reply_to, p_items);
end $$;
revoke all on function private.post_late_message(uuid, uuid, public.message_kind, text, uuid, uuid, jsonb) from public, anon;
grant execute on function private.post_late_message(uuid, uuid, public.message_kind, text, uuid, uuid, jsonb) to authenticated;

-- post_thread_message: unchanged, except that a field operator's files go through the late path
-- when the operator holds no open task on the case (or the given task is no longer theirs and open).
create or replace function public.post_thread_message(
    p_case_id uuid, p_client_message_id uuid, p_kind public.message_kind, p_body text default null,
    p_task_id uuid default null, p_reply_to uuid default null, p_items jsonb default '[]')
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
    v_uid  uuid := (select auth.uid());
    v_msg  uuid;
    v_task uuid := p_task_id;
    v_item jsonb;
    v_ev   uuid;
    v_cat  uuid;
begin
    if p_client_message_id is null then
        raise exception 'client_message_id is required' using errcode = '22023';
    end if;
    select m.id into v_msg from public.case_messages m where m.client_message_id = p_client_message_id;
    if v_msg is not null then
        return v_msg;                                         -- retry of an already stored message
    end if;
    if p_kind not in ('text', 'media', 'voice') then
        raise exception 'Use create_field_task() for requests' using errcode = '22023';
    end if;
    if p_kind = 'text' and nullif(btrim(coalesce(p_body, '')), '') is null then
        raise exception 'A text message needs a body' using errcode = '22023';
    end if;
    if p_kind in ('media', 'voice') and coalesce(jsonb_array_length(p_items), 0) = 0 then
        raise exception 'A media message needs at least one file' using errcode = '22023';
    end if;
    if coalesce(jsonb_array_length(p_items), 0) > 30 then
        raise exception 'At most 30 files per message' using errcode = '22023';
    end if;

    if p_kind in ('media', 'voice') and public.is_field() then
        if v_task is null then
            select t.id into v_task from public.tasks t
             where t.case_id = p_case_id and t.assignee_id = v_uid and t.status in ('pending', 'in_progress')
             order by t.created_at desc limit 1;
        elsif not exists (select 1 from public.tasks t where t.id = v_task and t.case_id = p_case_id
                             and t.assignee_id = v_uid and t.status in ('pending', 'in_progress')) then
            -- D43: files captured before the task closed / was reassigned
            return private.post_late_message(p_case_id, p_client_message_id, p_kind, p_body, p_task_id, p_reply_to, p_items);
        end if;
        if v_task is null then
            return private.post_late_message(p_case_id, p_client_message_id, p_kind, p_body, null, p_reply_to, p_items);
        end if;
    end if;

    insert into public.case_messages (case_id, sender_id, kind, body, task_id, reply_to_id, client_message_id)
    values (p_case_id, v_uid, p_kind, nullif(btrim(coalesce(p_body, '')), ''), v_task, p_reply_to, p_client_message_id)
    returning id into v_msg;

    for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
        insert into public.evidence (case_id, task_id, checklist_item_id, message_id, evidence_type, capture_source,
                                     storage_path, mime_type, size_bytes, sha256, captured_by, original_filename,
                                     device_captured_at, latitude, longitude, gps_accuracy_m, device_info, exif)
        values (p_case_id, v_task, nullif(v_item->>'checklist_item_id', '')::uuid, v_msg,
                (v_item->>'evidence_type')::public.evidence_type,
                (v_item->>'capture_source')::public.capture_source,
                v_item->>'storage_path', v_item->>'mime_type', (v_item->>'size_bytes')::bigint,
                v_item->>'sha256', v_uid, v_item->>'original_filename',
                (v_item->>'device_captured_at')::timestamptz,
                (v_item->>'latitude')::double precision, (v_item->>'longitude')::double precision,
                (v_item->>'gps_accuracy_m')::real,
                coalesce(v_item->'device_info', '{}'), coalesce(v_item->'exif', '{}'))
        returning id into v_ev;

        if nullif(v_item->>'category_code', '') is not null then
            select c.id into v_cat from public.evidence_categories c where c.code = v_item->>'category_code' and c.is_active;
            if v_cat is not null then
                insert into public.evidence_labels (evidence_id, category_id, confidence, source)
                values (v_ev, v_cat, 1, 'operator');
            end if;
        end if;
        if jsonb_typeof(v_item->'ocr') = 'object' and nullif(v_item->'ocr'->>'text', '') is not null then
            insert into public.evidence_ocr (evidence_id, page_no, engine, engine_version, lang, text, blocks, mean_confidence)
            values (v_ev, coalesce((v_item->'ocr'->>'page_no')::int, 1), coalesce(v_item->'ocr'->>'engine', 'device'),
                    v_item->'ocr'->>'engine_version', v_item->'ocr'->>'lang', v_item->'ocr'->>'text',
                    coalesce(v_item->'ocr'->'blocks', '[]'), (v_item->'ocr'->>'mean_confidence')::real);
        end if;
    end loop;

    -- first upload starts the field task
    if public.is_field() and v_task is not null then
        update public.tasks t set status = 'in_progress' where t.id = v_task and t.status = 'pending';
    end if;
    return v_msg;
end $$;

-- Presigner check including late uploads: open-task rule, or the D43 window for this capture time.
create or replace function public.can_upload_evidence_at(p_task_id uuid, p_device_captured_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(public.can_upload_evidence(p_task_id)
                    or (public.is_field() and private.field_upload_allowed(p_task_id, (select auth.uid()), p_device_captured_at)),
                    false);
$$;
revoke all on function public.can_upload_evidence_at(uuid, timestamptz) from public, anon;
grant execute on function public.can_upload_evidence_at(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- F. Field devices and the remote-sign-out drain
-- ---------------------------------------------------------------------
create table public.field_devices (
    device_id     uuid primary key,                         -- generated by the app at sign-in
    profile_id    uuid        not null references public.profiles(id) on delete cascade,
    secret_sha256 text        not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
    platform      text        not null default 'android' check (platform in ('android', 'ios')),
    registered_at timestamptz not null default now(),
    rotated_at    timestamptz,
    finished_at   timestamptz                               -- drain finished; device must not be used again
);
create index ix_field_devices_profile on public.field_devices (profile_id);
alter table public.field_devices enable row level security;   -- no policies: functions only
revoke all on public.field_devices from anon, authenticated;

-- Register (or rotate) this phone's drain secret while signed in and active. Only the SHA-256 of
-- the secret is sent and stored; the secret stays in the phone's keystore.
create or replace function public.register_field_device(p_device_id uuid, p_secret_sha256 text,
                                                        p_platform text default 'android') returns void
language plpgsql security definer set search_path = '' as $$
declare v public.field_devices;
begin
    if not public.is_field() then
        raise exception 'Only an active field operator can register a device' using errcode = '42501';
    end if;
    if p_device_id is null or coalesce(p_secret_sha256, '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_platform, '') not in ('android', 'ios') then
        raise exception 'device_id, a SHA-256 hex secret hash and platform android/ios are required' using errcode = '22023';
    end if;
    select * into v from public.field_devices d where d.device_id = p_device_id for update;
    if found and (v.profile_id <> (select auth.uid()) or v.finished_at is not null) then
        raise exception 'This device id cannot be used' using errcode = '42501';
    end if;
    insert into public.field_devices (device_id, profile_id, secret_sha256, platform)
    values (p_device_id, (select auth.uid()), p_secret_sha256, p_platform)
    on conflict (device_id) do update
        set secret_sha256 = excluded.secret_sha256, platform = excluded.platform,
            rotated_at = case when public.field_devices.secret_sha256 <> excluded.secret_sha256
                              then now() else public.field_devices.rotated_at end;
end $$;
revoke all on function public.register_field_device(uuid, text, text) from public, anon;
grant execute on function public.register_field_device(uuid, text, text) to authenticated;

-- Device secret check (no window check). Unknown device and wrong secret look the same.
create or replace function private.drain_verify(p_device_id uuid, p_secret text) returns public.field_devices
language plpgsql stable security definer set search_path = '' as $$
declare v public.field_devices;
begin
    if p_device_id is not null and coalesce(p_secret, '') ~ '^[0-9a-f]{64}$' then
        select * into v from public.field_devices d
         where d.device_id = p_device_id
           and d.secret_sha256 = encode(extensions.digest(p_secret, 'sha256'), 'hex');
    end if;
    if v.device_id is null then
        raise exception 'Unknown device' using errcode = '42501', hint = 'device_unknown';
    end if;
    return v;
end $$;

-- Device may drain now: verified, not finished, profile deactivated after registration, window open.
create or replace function private.drain_device(p_device_id uuid, p_secret text) returns public.field_devices
language plpgsql stable security definer set search_path = '' as $$
declare v public.field_devices; p public.profiles;
begin
    v := private.drain_verify(p_device_id, p_secret);
    if v.finished_at is not null then
        raise exception 'This device has finished sending' using errcode = '42501', hint = 'drain_finished';
    end if;
    select * into p from public.profiles where id = v.profile_id;
    if p.is_active or p.deactivated_at is null then
        raise exception 'Operator is active; use the normal upload path' using errcode = '42501', hint = 'not_deactivated';
    end if;
    if v.registered_at >= p.deactivated_at
       or now() > p.deactivated_at + make_interval(days => private.setting_int('drain_window_days', 7)) then
        raise exception 'The sending window after sign-out has closed' using errcode = '42501', hint = 'drain_window_closed';
    end if;
    return v;
end $$;
revoke all on function private.drain_verify(uuid, text), private.drain_device(uuid, text)
    from public, anon, authenticated, service_role;

-- state: 'drain' (send now), 'active' (operator is active again: normal path), 'closed' (window over
-- or finished: wipe). Raises device_unknown for a wrong secret.
create or replace function public.drain_status(p_device_id uuid, p_secret text)
returns table (state text, deactivated_at timestamptz, drain_until timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v public.field_devices; p public.profiles; v_until timestamptz;
begin
    v := private.drain_verify(p_device_id, p_secret);
    select * into p from public.profiles where id = v.profile_id;
    v_until := p.deactivated_at + make_interval(days => private.setting_int('drain_window_days', 7));
    return query select
        case when p.is_active then 'active'
             when v.finished_at is not null or p.deactivated_at is null or v.registered_at >= p.deactivated_at
                  or now() > v_until then 'closed'
             else 'drain' end,
        p.deactivated_at, v_until;
end $$;

-- Before presigning an R2 PUT for a drained file. Returns the case for the object key
-- cases/{case_id}/tasks/{task_id}/{sha256}.{ext}. Audited.
create or replace function public.drain_authorize_upload(p_device_id uuid, p_secret text, p_task_id uuid,
                                                         p_sha256 text, p_device_captured_at timestamptz)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.field_devices; v_case uuid;
begin
    v := private.drain_device(p_device_id, p_secret);
    if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then
        raise exception 'sha256 must be 64 hex characters' using errcode = '22023';
    end if;
    select t.case_id into v_case from public.tasks t where t.id = p_task_id;
    if v_case is null or not private.field_upload_allowed(p_task_id, v.profile_id, p_device_captured_at) then
        raise exception 'File captured outside the upload window' using errcode = '42501', hint = 'upload_window_closed';
    end if;
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (v.profile_id, 'DRAIN_PRESIGN', 'tasks', p_task_id, null,
            jsonb_build_object('device_id', p_device_id, 'case_id', v_case, 'sha256', p_sha256,
                               'device_captured_at', p_device_captured_at));
    return v_case;
end $$;

-- post_thread_message equivalent for a drained phone (files only; captions kept).
create or replace function public.drain_post_message(
    p_device_id uuid, p_secret text, p_case_id uuid, p_client_message_id uuid, p_kind public.message_kind,
    p_body text default null, p_task_id uuid default null, p_reply_to uuid default null, p_items jsonb default '[]')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.field_devices; v_msg uuid;
begin
    v := private.drain_verify(p_device_id, p_secret);
    -- a retry of a message already stored succeeds even after the window
    select m.id into v_msg from public.case_messages m
     where m.client_message_id = p_client_message_id and m.sender_id = v.profile_id;
    if v_msg is not null then
        return v_msg;
    end if;
    v := private.drain_device(p_device_id, p_secret);
    return private.post_field_files(v.profile_id, 'drain', p_device_id, p_case_id, p_client_message_id, p_kind,
                                    p_body, p_task_id, p_reply_to, p_items);
end $$;

-- Drain finished (outbox empty or operator chose to discard after confirmation): the device id is
-- retired; the app then wipes its cache. Idempotent.
create or replace function public.drain_finish(p_device_id uuid, p_secret text, p_discarded_count int default 0)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.field_devices;
begin
    v := private.drain_verify(p_device_id, p_secret);
    if v.finished_at is not null then
        return;
    end if;
    update public.field_devices set finished_at = now() where device_id = p_device_id;
    insert into public.device_outbox_status (device_id, profile_id, pending_count, pending_bytes, oldest_pending_at, reported_at)
    values (p_device_id, v.profile_id, 0, 0, null, now())
    on conflict (device_id) do update set pending_count = 0, pending_bytes = 0, oldest_pending_at = null, reported_at = now();
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (v.profile_id, 'DRAIN_FINISHED', 'field_devices', p_device_id, null,
            jsonb_build_object('discarded_count', greatest(coalesce(p_discarded_count, 0), 0)));
end $$;

-- ---------------------------------------------------------------------
-- G. Files waiting on a phone
-- ---------------------------------------------------------------------
create table public.device_outbox_status (
    device_id         uuid        primary key references public.field_devices(device_id) on delete cascade,
    profile_id        uuid        not null references public.profiles(id) on delete cascade,
    pending_count     int         not null check (pending_count between 0 and 100000),
    pending_bytes     bigint      not null check (pending_bytes >= 0),
    oldest_pending_at timestamptz,                          -- phone clock: when the oldest waiting file was captured
    reported_at       timestamptz not null default now()    -- server clock: last report = last online
);
create index ix_device_outbox_profile on public.device_outbox_status (profile_id);
alter table public.device_outbox_status enable row level security;
create policy p_outbox_staff_r on public.device_outbox_status for select to authenticated using (public.is_staff());
create policy p_outbox_own_r   on public.device_outbox_status for select to authenticated
    using (public.is_field() and profile_id = (select auth.uid()));
revoke all on public.device_outbox_status from anon;
revoke insert, update, delete, truncate on public.device_outbox_status from authenticated;

create or replace function private.upsert_outbox(p_device_id uuid, p_profile uuid, p_count int, p_bytes bigint,
                                                 p_oldest timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if p_count is null or p_count < 0 or p_count > 100000 or p_bytes is null or p_bytes < 0 then
        raise exception 'pending_count and pending_bytes must be non-negative' using errcode = '22023';
    end if;
    insert into public.device_outbox_status (device_id, profile_id, pending_count, pending_bytes, oldest_pending_at, reported_at)
    values (p_device_id, p_profile, p_count, p_bytes, case when p_count > 0 then p_oldest end, now())
    on conflict (device_id) do update
        set pending_count = excluded.pending_count, pending_bytes = excluded.pending_bytes,
            oldest_pending_at = excluded.oldest_pending_at, reported_at = now();
end $$;
revoke all on function private.upsert_outbox(uuid, uuid, int, bigint, timestamptz) from public, anon, authenticated, service_role;

-- Field app, signed in: report this phone's outbox (call on change, at most once a minute, and after each send).
create or replace function public.report_outbox_status(p_device_id uuid, p_pending_count int, p_pending_bytes bigint,
                                                       p_oldest_pending_at timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_field() then
        raise exception 'Only an active field operator can report an outbox' using errcode = '42501';
    end if;
    if not exists (select 1 from public.field_devices d where d.device_id = p_device_id
                      and d.profile_id = (select auth.uid()) and d.finished_at is null) then
        raise exception 'Register this device first' using errcode = '42501', hint = 'device_unknown';
    end if;
    perform private.upsert_outbox(p_device_id, (select auth.uid()), p_pending_count, p_pending_bytes, p_oldest_pending_at);
end $$;
revoke all on function public.report_outbox_status(uuid, int, bigint, timestamptz) from public, anon;
grant execute on function public.report_outbox_status(uuid, int, bigint, timestamptz) to authenticated;

-- Drained phone: same report without a JWT (field-drain function).
create or replace function public.drain_report_outbox(p_device_id uuid, p_secret text, p_pending_count int,
                                                      p_pending_bytes bigint, p_oldest_pending_at timestamptz default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v public.field_devices;
begin
    v := private.drain_verify(p_device_id, p_secret);
    if v.finished_at is not null then
        raise exception 'This device has finished sending' using errcode = '42501', hint = 'drain_finished';
    end if;
    perform private.upsert_outbox(p_device_id, v.profile_id, p_pending_count, p_pending_bytes, p_oldest_pending_at);
end $$;

-- Thread header: operators who held a task on the case and what is waiting on their phones
-- (staff: all such operators; a field operator: own devices only, on a case they can see).
create or replace function public.case_outbox_status(p_case_id uuid)
returns table (profile_id uuid, full_name text, is_active boolean, device_id uuid, pending_count int,
               pending_bytes bigint, oldest_pending_at timestamptz, reported_at timestamptz)
language sql stable security definer set search_path = '' as $$
    select p.id, p.full_name, p.is_active, o.device_id, o.pending_count, o.pending_bytes, o.oldest_pending_at, o.reported_at
      from public.profiles p
      join public.device_outbox_status o on o.profile_id = p.id
     where p.id in (select h.profile_id from public.task_holds h join public.tasks t on t.id = h.task_id
                     where t.case_id = p_case_id)
       and (public.is_staff()
            or (public.is_field() and p.id = (select auth.uid()) and private.field_can_see_case(p_case_id)))
     order by o.pending_count desc, o.reported_at desc;
$$;
revoke all on function public.case_outbox_status(uuid) from public, anon;
grant execute on function public.case_outbox_status(uuid) to authenticated;

-- drain_* are for the field-drain edge function (service role) only
revoke all on function
    public.drain_status(uuid, text),
    public.drain_authorize_upload(uuid, text, uuid, text, timestamptz),
    public.drain_post_message(uuid, text, uuid, uuid, public.message_kind, text, uuid, uuid, jsonb),
    public.drain_finish(uuid, text, int),
    public.drain_report_outbox(uuid, text, int, bigint, timestamptz)
from public, anon, authenticated;
grant execute on function
    public.drain_status(uuid, text),
    public.drain_authorize_upload(uuid, text, uuid, text, timestamptz),
    public.drain_post_message(uuid, text, uuid, uuid, public.message_kind, text, uuid, uuid, jsonb),
    public.drain_finish(uuid, text, int),
    public.drain_report_outbox(uuid, text, int, bigint, timestamptz)
to service_role;
