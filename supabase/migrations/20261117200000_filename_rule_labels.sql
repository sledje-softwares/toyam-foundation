-- Piece H: label insurer email attachments by file name, in the database, at arrival (D25).
--
-- ICICI Lombard names its attachments after what they show ("Front View(1)_<ts>_<id>_<claimno>_<date>.jpg",
-- "DRIVING LICENSE(1)_…", "ECLAIM_<ref>_<digits>.PDF"). evidence_categories.filename_patterns already holds
-- case-insensitive regexes for those names; this migration applies them when the evidence row is inserted, so
-- these files never need the LLM labeller.
--
--   * private.filename_label_variants(name): deterministic normalisation of a file name
--   * private.apply_filename_labels(evidence_id): inserts active 'filename_rule' labels, never overrides a
--     human / operator label, idempotent, skips the queued 'label' job when it labelled the file
--   * trigger trg_evidence_filename_label (AFTER INSERT, capture_source = 'email_attachment'); never fails the insert
--   * public.backfill_filename_labels(): service-role only, labels existing unlabelled email attachments

-- ---------------------------------------------------------------------
-- 1. Label guard: allow the rule labeller (flag set only inside apply_filename_labels)
-- ---------------------------------------------------------------------
-- Intake runs confirm_intake() as the signed-in office user; the guard would otherwise refuse
-- source 'filename_rule' for staff. Same flag pattern as app.withdrawing.
create or replace function private.evidence_labels_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        new.created_at := now();
        if coalesce(current_setting('app.filename_rule', true), '') = 'on' and new.source = 'filename_rule' then
            new.created_by := null;
            return new;
        end if;
        new.created_by := coalesce((select auth.uid()), new.created_by);
        if public.is_field() and new.source <> 'operator' then
            raise exception 'Field users can only add operator tags' using errcode = '42501';
        end if;
        if public.is_staff() and new.source not in ('human', 'operator') then
            raise exception 'Staff labels are recorded as human labels' using errcode = '42501';
        end if;
        return new;
    end if;
    -- updates: only deactivation
    if (to_jsonb(new) - 'is_active') is distinct from (to_jsonb(old) - 'is_active') or new.is_active then
        raise exception 'Labels can only be deactivated' using errcode = '42501';
    end if;
    return new;
end $$;

-- ---------------------------------------------------------------------
-- 2. Normalisation
-- ---------------------------------------------------------------------
-- Steps: drop the extension; lower-case; drop "(n)" counters; split on '_'; drop tokens that carry
-- identifiers (a run of 4+ digits, or 3+ digits in all: timestamps, ids, claim numbers, dates);
-- collapse spaces. Returns two variants so patterns written either way match: tokens joined with
-- '_' ("qc_initial1") and with a space ("qc initial1"). Pure function, same input, same output.
create or replace function private.filename_label_variants(p_name text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare v_base text; v_tok text; v_keep text[] := '{}'; v_us text; v_sp text;
begin
    if p_name is null then return '{}'; end if;
    v_base := lower(regexp_replace(btrim(p_name), '\.[A-Za-z0-9]{1,5}$', ''));
    v_base := regexp_replace(v_base, '\(\s*\d+\s*\)', ' ', 'g');
    foreach v_tok in array string_to_array(v_base, '_') loop
        v_tok := btrim(regexp_replace(v_tok, '\s+', ' ', 'g'));
        if v_tok = '' then continue; end if;
        if v_tok ~ '\d{4,}' or char_length(regexp_replace(v_tok, '\D', '', 'g')) >= 3 then continue; end if;
        v_keep := v_keep || v_tok;
    end loop;
    v_us := array_to_string(v_keep, '_');
    v_sp := btrim(regexp_replace(array_to_string(v_keep, ' '), '\s+', ' ', 'g'));
    return case when v_us = v_sp then array[v_us] else array[v_us, v_sp] end;
end $$;
comment on function private.filename_label_variants(text) is
    'Normalised variants of a file name for filename_patterns matching (extension, (n) counters and identifier tokens removed).';

-- Categories whose filename_patterns match a file name (each once). Invalid regexes are skipped with a warning.
-- Patterns are written PCRE/JS style in config; \b is translated to PostgreSQL's \y. _categories.yaml uses no
-- other PCRE-only syntax (no lookarounds; \d, \s, \w are valid in PostgreSQL).
create or replace function private.match_filename_categories(p_name text) returns setof uuid
language plpgsql stable set search_path = '' as $$
declare v_variants text[] := private.filename_label_variants(p_name); c record; p text; v_hit boolean; v_seen uuid[] := '{}';
begin
    if coalesce(array_length(v_variants, 1), 0) = 0 or v_variants[1] = '' then return; end if;
    for c in select ec.id, ec.code, ec.filename_patterns from public.evidence_categories ec
              where ec.is_active and ec.filename_patterns <> '{}' order by ec.code loop
        v_hit := false;
        foreach p in array c.filename_patterns loop
            begin
                -- config patterns are JS/PCRE style; PostgreSQL's \b is a backspace, its word boundary is \y
                p := replace(p, '\b', '\y');
                if exists (select 1 from unnest(v_variants) v where v ~* p) then v_hit := true; exit; end if;
            exception when others then
                raise warning 'filename_patterns of category % skipped: %', c.code, sqlerrm;
            end;
        end loop;
        if v_hit and not (c.id = any (v_seen)) then v_seen := v_seen || c.id; return next c.id; end if;
    end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Apply to one evidence row
-- ---------------------------------------------------------------------
-- Confidence 0.9 for every rule label: insurer file names are reliable but not proof; office can correct.
create or replace function private.apply_filename_labels(p_evidence_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v public.evidence; v_n int;
begin
    select * into v from public.evidence e where e.id = p_evidence_id;
    if not found or v.capture_source <> 'email_attachment' or v.original_filename is null then return 0; end if;
    if exists (select 1 from public.evidence_labels l
                where l.evidence_id = v.id and l.is_active and l.source in ('human', 'operator')) then
        return 0;
    end if;
    perform set_config('app.filename_rule', 'on', true);
    with ins as (
        insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version)
        select v.id, m, 0.9, 'filename_rule', 'filename-v1'
          from private.match_filename_categories(v.original_filename) m
        on conflict (evidence_id, category_id, source) where is_active do nothing
        returning 1)
    select count(*) into v_n from ins;
    perform set_config('app.filename_rule', 'off', true);
    -- labelled by rule: the LLM label stage has nothing left to do
    if exists (select 1 from public.evidence_labels l where l.evidence_id = v.id and l.is_active) then
        update public.processing_jobs j set status = 'skipped', finished_at = now()
         where j.evidence_id = v.id and j.stage = 'label' and j.status = 'queued';
    end if;
    return v_n;
end $$;

-- Trigger: must never make the evidence insert fail
create or replace function private.evidence_filename_label_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    begin
        perform private.apply_filename_labels(new.id);
    exception when others then
        perform set_config('app.filename_rule', 'off', true);
        raise warning 'filename labelling of evidence % failed: %', new.id, sqlerrm;
    end;
    return null;
end $$;
-- fires after trg_evidence_enqueue (alphabetical order) so the label job exists to be skipped
create trigger trg_evidence_filename_label after insert on public.evidence
    for each row when (new.capture_source = 'email_attachment')
    execute function private.evidence_filename_label_trg();

-- ---------------------------------------------------------------------
-- 4. Backfill (service role)
-- ---------------------------------------------------------------------
create or replace function public.backfill_filename_labels(p_limit int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_files int := 0;
begin
    for r in select e.id from public.evidence e
              where e.capture_source = 'email_attachment' and e.original_filename is not null
                and not exists (select 1 from public.evidence_labels l where l.evidence_id = e.id and l.is_active)
              order by e.server_received_at limit greatest(coalesce(p_limit, 1000), 1) loop
        if private.apply_filename_labels(r.id) > 0 then v_files := v_files + 1; end if;
    end loop;
    return v_files;
end $$;

revoke all on function private.filename_label_variants(text), private.match_filename_categories(text),
    private.apply_filename_labels(uuid), private.evidence_filename_label_trg() from public, anon, authenticated;
revoke all on function public.backfill_filename_labels(int) from public, anon, authenticated;
grant execute on function public.backfill_filename_labels(int) to service_role;
