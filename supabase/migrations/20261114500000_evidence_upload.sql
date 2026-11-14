-- Signed-in evidence presigner (edge function `evidence-upload`, build plan 1.4 / 5.7).
--   A. evidence_upload_target(task, sha256[]): the task's case and which of the hashes the case
--      already stores, so the function signs the conventional key and the app skips files that are
--      already in R2 (rule 6). Staff, the task's assignee, or anyone who held the task (D43).
--   B. post_thread_message: a file whose (case_id, sha256) is already stored is skipped instead of
--      failing with 23505, as the late / drain path already does, so a retry never blocks the outbox.
--      The message itself is still stored (its text and remaining files).

-- ---------------------------------------------------------------------
-- A. Upload target
-- ---------------------------------------------------------------------
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
       and (public.is_staff()
            or (public.is_field() and (t.assignee_id = v_uid
                or exists (select 1 from public.task_holds h where h.task_id = t.id and h.profile_id = v_uid))));
    if v_case is null then
        raise exception 'Task not found' using errcode = '42501';
    end if;
    return query
        select v_case, coalesce(array(select distinct e.sha256 from public.evidence e
                                       where e.case_id = v_case and e.sha256 = any (p_sha256)), '{}'::text[]);
end $$;
revoke all on function public.evidence_upload_target(uuid, text[]) from public, anon;
grant execute on function public.evidence_upload_target(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- B. post_thread_message: duplicates are skipped (otherwise unchanged from 20261114400000)
-- ---------------------------------------------------------------------
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
        v_ev := null;
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
        on conflict (case_id, sha256) where sha256 is not null do nothing   -- already stored: skip (rule 6)
        returning id into v_ev;
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

    -- first upload starts the field task
    if public.is_field() and v_task is not null then
        update public.tasks t set status = 'in_progress' where t.id = v_task and t.status = 'pending';
    end if;
    return v_msg;
end $$;
