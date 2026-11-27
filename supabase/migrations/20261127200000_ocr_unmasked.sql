-- D55 (2026-11-27): no Aadhaar masking before the report step. record_device_ocr() stores the text,
-- blocks and description exactly as the phone sent them (office staff read them; field operators still
-- cannot, rule 4). Same signature, grants and security as 20261119600000; only the private.mask_aadhaar
-- calls are gone. Masking now happens only when photos are placed in a report (blacked out on the
-- report copy; original evidence unchanged).
-- Evidence_ocr rows already stored keep their masked text (nothing is rewritten).

create or replace function public.record_device_ocr(
    p_case_id uuid, p_original_sha256 text, p_source_width int, p_engine_version text, p_lang text,
    p_text text, p_blocks jsonb, p_mean_confidence real, p_description text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid     uuid := (select auth.uid());
    v_ev      public.evidence;
    v_id      uuid;
    v_current boolean;
    v_skipped int := 0;
    v_blocks  jsonb;
begin
    if not public.is_field() then
        raise exception 'Only field operators record text read on their phone' using errcode = '42501';
    end if;
    if p_original_sha256 is null or p_original_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception 'SHA-256 must be 64 lower-case hex characters' using errcode = '22023';
    end if;
    if p_source_width is distinct from 1600 then
        raise exception 'Device OCR is read from the 1600 px copy' using errcode = '22023';
    end if;
    if p_text is null or char_length(p_text) > 20000 then
        raise exception 'Text must be present and at most 20000 characters' using errcode = '22023';
    end if;
    if p_description is not null and char_length(p_description) > 240 then
        raise exception 'Description must be at most 240 characters' using errcode = '22023';
    end if;
    if char_length(coalesce(p_engine_version, '')) > 100 or char_length(coalesce(p_lang, '')) > 32 then
        raise exception 'Engine version (100) or language (32) too long' using errcode = '22023';
    end if;
    if p_mean_confidence is not null and (p_mean_confidence < 0 or p_mean_confidence > 1 or p_mean_confidence = 'NaN') then
        raise exception 'Mean confidence must be between 0 and 1' using errcode = '22023';
    end if;
    if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) > 2000 then
        raise exception 'Blocks must be an array of at most 2000 entries' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(p_blocks) b
         where jsonb_typeof(b) <> 'object'
            or jsonb_typeof(b->'text') is distinct from 'string' or char_length(b->>'text') > 2000
            or jsonb_typeof(b->'bbox') is distinct from 'array' or jsonb_array_length(b->'bbox') <> 4
            or exists (select 1 from jsonb_array_elements(b->'bbox') n where jsonb_typeof(n) <> 'number' or (n #>> '{}')::numeric < 0)
            or (b ? 'conf' and jsonb_typeof(b->'conf') <> 'null'
                and (jsonb_typeof(b->'conf') <> 'number' or (b->>'conf')::numeric not between 0 and 1))
            or jsonb_typeof(b->'line') is distinct from 'number' or (b->>'line')::numeric < 0
            or (b->>'line')::numeric <> trunc((b->>'line')::numeric)) then
        raise exception 'Each block needs {text, bbox:[x,y,w,h] >= 0, conf 0-1 or null, line >= 0}' using errcode = '22023';
    end if;

    select * into v_ev from public.evidence e where e.case_id = p_case_id and e.sha256 = p_original_sha256;
    if not found or v_ev.captured_by is distinct from v_uid then
        raise exception 'Photo not found among your uploads on this case' using errcode = 'P0002';
    end if;
    if v_ev.evidence_type <> 'photo' then
        raise exception 'Only photos are read on the phone' using errcode = '22023';
    end if;
    if v_ev.withdrawn_at is not null then
        raise exception 'This photo was withdrawn' using errcode = '55000';
    end if;
    if not private.field_derivative_access(p_case_id, v_uid) then
        raise exception 'You no longer work on this case' using errcode = '42501';
    end if;

    -- retry: the first recording stands
    select o.id, o.is_current into v_id, v_current from public.evidence_ocr o
     where o.evidence_id = v_ev.id and o.page_no = 1 and o.engine = 'mlkit_device';
    if found then
        return jsonb_build_object('evidence_id', v_ev.id, 'ocr_id', v_id, 'recorded', false, 'is_current', v_current,
                                  'server_ocr_skipped', false);
    end if;

    -- server OCR already read this file (from the original): keep it current, store ours beside it
    v_current := not exists (select 1 from public.evidence_ocr o
                              where o.evidence_id = v_ev.id and o.page_no = 1 and o.is_current and o.engine <> 'mlkit_device');
    select coalesce(jsonb_agg(jsonb_build_object('text', b->>'text', 'bbox', b->'bbox',
                                                 'conf', b->'conf', 'line', (b->>'line')::int) order by i), '[]'::jsonb)
      into v_blocks
      from jsonb_array_elements(p_blocks) with ordinality t (b, i);

    perform set_config('app.device_ocr', 'on', true);
    insert into public.evidence_ocr (evidence_id, page_no, engine, engine_version, lang, text, blocks, mean_confidence,
                                     is_current, created_by, summary, source_width)
    values (v_ev.id, 1, 'mlkit_device', nullif(p_engine_version, ''), nullif(p_lang, ''), p_text,
            v_blocks, p_mean_confidence, v_current, v_uid,
            nullif(btrim(coalesce(p_description, '')), ''), p_source_width)
    on conflict (evidence_id, page_no) where engine = 'mlkit_device' do nothing
    returning id into v_id;
    perform set_config('app.device_ocr', 'off', true);
    if v_id is null then   -- a concurrent retry won
        select o.id, o.is_current into v_id, v_current from public.evidence_ocr o
         where o.evidence_id = v_ev.id and o.page_no = 1 and o.engine = 'mlkit_device';
        return jsonb_build_object('evidence_id', v_ev.id, 'ocr_id', v_id, 'recorded', false, 'is_current', v_current,
                                  'server_ocr_skipped', false);
    end if;

    -- confident text: the server OCR stage has nothing to add (a running job is left to the worker,
    -- which also skips files with a current mlkit_device row)
    if v_current and btrim(p_text) <> ''
       and p_mean_confidence >= private.setting_int('device_ocr_skip_confidence_pct', 70) / 100.0 then
        update public.processing_jobs j
           set status = 'skipped', finished_at = now(), last_error = 'device OCR present', locked_at = null
         where j.evidence_id = v_ev.id and j.stage = 'ocr' and j.status = 'queued';
        get diagnostics v_skipped = row_count;
    end if;

    return jsonb_build_object('evidence_id', v_ev.id, 'ocr_id', v_id, 'recorded', true, 'is_current', v_current,
                              'server_ocr_skipped', v_skipped > 0);
end $$;
revoke all on function public.record_device_ocr(uuid, text, int, text, text, text, jsonb, real, text) from public, anon;
grant execute on function public.record_device_ocr(uuid, text, int, text, text, text, jsonb, real, text) to authenticated;

comment on column public.evidence_ocr.summary is
    'Short description of the photo built on the field phone from the operator tag and the first text lines '
    '(no model); applies to the original and its 384 / 1600 copies. Stored as read (D55).';
comment on function private.mask_aadhaar(text) is
    'Aadhaar-like numbers to XXXX XXXX last4. No longer called by record_device_ocr (D55); kept for report-time use and reference.';
