-- =====================================================================
-- Device OCR on the field phone (docs/14 gap 35, phone part; docs/11 "Device OCR and description")
--
-- The field app reads the text of every photo it sends with Google ML Kit (Latin + Devanagari,
-- bundled models, offline) on the 1600 px copy it already makes (D51), masks Aadhaar-like numbers
-- and builds a short description from the operator's tag and the first text lines. Once the
-- original (and its copies) are stored it records the result with record_device_ocr().
--
--   A. evidence_ocr.summary        short description of the photo (applies to the original and both
--                                  copies: they show the same picture). Staff read it like the OCR
--                                  text; never on evidence (rule 2: core evidence fields are immutable).
--      evidence_ocr.source_width   which copy was read (1600); blocks are in that copy's pixel
--                                  coordinates (evidence_derivatives.pixel_width / pixel_height).
--   B. Field users no longer insert OCR rows directly: the old insert policy is dropped and a guard
--      trigger silently drops field-originated rows that do not come through record_device_ocr()
--      (post_thread_message's legacy `ocr` item, the late-upload and drain paths), so masking and
--      the size checks cannot be bypassed and an unchecked device row never supersedes server OCR.
--   C. private.mask_aadhaar(text)  server-side copy of the phone's masking (defence in depth).
--   D. record_device_ocr(...)      field operator who captured the photo, while they still may upload
--                                  copies to the case (private.field_derivative_access: sees the case,
--                                  or inside the D43 late window). Idempotent per (photo, page 1).
--                                  With confident text the queued server `ocr` job is skipped
--                                  ("device OCR present").
--
-- Errcodes: 42501 not a field operator / no longer on the case · P0002 photo not found among the
-- caller's uploads · 22023 bad input · 55000 photo withdrawn.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Columns
-- ---------------------------------------------------------------------
alter table public.evidence_ocr
    add column summary      text check (summary is null or char_length(summary) <= 300),
    add column source_width int  check (source_width is null or source_width in (384, 1600));
comment on column public.evidence_ocr.summary is
    'Short description of the file built on the phone from the operator''s tag and the first OCR lines '
    '(no model); applies to the original and its 384 / 1600 copies. Aadhaar-like numbers masked.';
comment on column public.evidence_ocr.source_width is
    'Shrunk copy that was read (1600); blocks are in that copy''s pixel coordinates. Null = the original / page.';

-- one device row per file and page (idempotency of record_device_ocr)
create unique index uq_evidence_ocr_device on public.evidence_ocr (evidence_id, page_no) where engine = 'mlkit_device';

insert into public.app_settings (key, value, description) values
    ('device_ocr_skip_confidence_pct', '70',
     'Device OCR with text and a mean confidence at or above this percentage skips the queued server OCR job')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- B. Field users write OCR only through record_device_ocr()
-- ---------------------------------------------------------------------
drop policy p_ocr_field_w on public.evidence_ocr;

-- Fires before trg_evidence_ocr_supersede (alphabetical), so a dropped row never supersedes anything.
create or replace function private.evidence_ocr_field_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if public.is_field() and coalesce(current_setting('app.device_ocr', true), '') <> 'on' then
        return null;   -- legacy / unchecked device OCR: dropped without failing the message
    end if;
    return new;
end $$;
revoke all on function private.evidence_ocr_field_guard() from public, anon, authenticated;
create trigger trg_evidence_ocr_field_guard before insert on public.evidence_ocr
    for each row execute function private.evidence_ocr_field_guard();

-- ---------------------------------------------------------------------
-- C. Aadhaar masking (same rule as apps/field/src/ocr/mask.ts)
-- ---------------------------------------------------------------------
-- 12 digits, first 2-9, plain or grouped 4-4-4 (space / hyphen, at most two between groups), not
-- part of a longer digit run -> "XXXX XXXX 1234".
create or replace function private.mask_aadhaar(p_text text) returns text
language sql immutable set search_path = '' as $$
    select regexp_replace(p_text, '(^|[^0-9])[2-9][0-9]{3}[ -]{0,2}[0-9]{4}[ -]{0,2}([0-9]{4})(?![0-9])', '\1XXXX XXXX \2', 'g');
$$;
revoke all on function private.mask_aadhaar(text) from public, anon, authenticated;
grant execute on function private.mask_aadhaar(text) to service_role;

-- ---------------------------------------------------------------------
-- D. record_device_ocr
-- ---------------------------------------------------------------------
-- p_blocks: [{text, bbox:[x,y,w,h], conf (0-1 or null), line (int >= 0)}] in the 1600 px copy's pixels.
-- Returns {evidence_id, ocr_id, recorded, is_current, server_ocr_skipped}.
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
    select coalesce(jsonb_agg(jsonb_build_object('text', private.mask_aadhaar(b->>'text'), 'bbox', b->'bbox',
                                                 'conf', b->'conf', 'line', (b->>'line')::int) order by i), '[]'::jsonb)
      into v_blocks
      from jsonb_array_elements(p_blocks) with ordinality t (b, i);

    perform set_config('app.device_ocr', 'on', true);
    insert into public.evidence_ocr (evidence_id, page_no, engine, engine_version, lang, text, blocks, mean_confidence,
                                     is_current, created_by, summary, source_width)
    values (v_ev.id, 1, 'mlkit_device', nullif(p_engine_version, ''), nullif(p_lang, ''), private.mask_aadhaar(p_text),
            v_blocks, p_mean_confidence, v_current, v_uid,
            nullif(btrim(private.mask_aadhaar(coalesce(p_description, ''))), ''), p_source_width)
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
