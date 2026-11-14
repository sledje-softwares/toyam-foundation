-- D34: label first, OCR only where it is needed, vision model as second opinion.
--
--   1. Run order of processing stages becomes text_extract -> label -> ocr -> field_suggest
--      (an enum cannot be reordered, so the order lives in private.stage_rank()).
--   2. evidence_categories.needs_ocr: categories whose files carry text the report needs
--      (documents by default; set per category with `ocr:` in config/templates/_categories.yaml).
--   3. evidence_labels.needs_detail / detail_reason / model: the labeller says whether the file
--      must be read at full resolution, and which model produced the label (models are swapped
--      often; keep the name with every result).
--   4. public.ocr_wanted(evidence_id): the OCR stage's skip rule, for the worker (service role).

-- ---------------------------------------------------------------------
-- 1. Stage order
-- ---------------------------------------------------------------------
create or replace function private.stage_rank(p_stage public.processing_stage) returns int
language sql immutable set search_path = '' as $$
    select case p_stage
        when 'text_extract'  then 1   -- free text layer of PDFs, helps the labeller
        when 'label'         then 2   -- low-resolution vision label + needs_detail
        when 'ocr'           then 3   -- only where ocr_wanted()
        when 'field_suggest' then 4
    end;
$$;

-- A stage is claimable once every earlier stage (by stage_rank) of the same evidence and
-- pipeline version is no longer queued or running.
create or replace function public.claim_processing_jobs(p_stages public.processing_stage[], p_limit int, p_worker text)
returns setof public.processing_jobs
language sql security definer set search_path = '' as $$
    with c as (
        select j.id from public.processing_jobs j
         where j.status = 'queued' and j.run_after <= now() and j.stage = any (p_stages)
           and not exists (select 1 from public.processing_jobs p
                            where p.evidence_id = j.evidence_id and p.pipeline_version = j.pipeline_version
                              and private.stage_rank(p.stage) < private.stage_rank(j.stage)
                              and p.status in ('queued', 'running'))
         order by j.run_after, j.id
         limit greatest(p_limit, 1)
         for update skip locked
    )
    update public.processing_jobs j
       set status = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = p_worker,
           started_at = now(), last_error = null
      from c where j.id = c.id
    returning j.*;
$$;

-- ---------------------------------------------------------------------
-- 2. Categories that need OCR
-- ---------------------------------------------------------------------
alter table public.evidence_categories add column needs_ocr boolean not null default false;
update public.evidence_categories set needs_ocr = true where default_evidence_type = 'document';

create or replace function public.load_evidence_categories(p_categories jsonb) returns int
language plpgsql security invoker set search_path = '' as $$
declare v jsonb; v_n int := 0; v_type public.evidence_type;
begin
    if not (public.is_admin() or private.is_archive_writer()) then
        raise exception 'Only an admin can load categories' using errcode = '42501';
    end if;
    if jsonb_typeof(p_categories) <> 'array' then
        raise exception 'Categories must be a JSON array' using errcode = '22023';
    end if;
    for v in select * from jsonb_array_elements(p_categories) loop
        v_type := coalesce((v->>'default_evidence_type')::public.evidence_type, 'photo');
        insert into public.evidence_categories (code, name, description, default_evidence_type,
                                                filename_patterns, text_patterns, is_active, needs_ocr)
        values (v->>'code', v->>'name', v->>'description', v_type,
                coalesce(array(select jsonb_array_elements_text(v->'filename_patterns')), '{}'),
                coalesce(array(select jsonb_array_elements_text(v->'text_patterns')), '{}'),
                coalesce((v->>'is_active')::boolean, true),
                coalesce((v->>'ocr')::boolean, v_type = 'document'))
        on conflict (code) do update
           set name = excluded.name, description = excluded.description,
               default_evidence_type = excluded.default_evidence_type,
               filename_patterns = excluded.filename_patterns, text_patterns = excluded.text_patterns,
               is_active = excluded.is_active, needs_ocr = excluded.needs_ocr;
        v_n := v_n + 1;
    end loop;
    return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 3. Label detail flag and model
-- ---------------------------------------------------------------------
alter table public.evidence_labels
    add column needs_detail  boolean,
    add column detail_reason text check (char_length(detail_reason) <= 300),
    add column model         text    check (char_length(model) <= 100);

comment on column public.evidence_labels.needs_detail is
    'Labeller (D34): the file must be read at full resolution (text, numbers or a detail the report needs)';
comment on column public.evidence_labels.model is
    'Model that produced the label, e.g. provider/model-id; null for rules, operator and human labels';

-- ---------------------------------------------------------------------
-- 4. OCR skip rule
-- ---------------------------------------------------------------------
-- OCR is wanted for documents, for unlabelled files (to be safe), and for files with an active
-- label whose category needs OCR or that the labeller flagged as needing detail. Withdrawn files
-- are never wanted.
create or replace function public.ocr_wanted(p_evidence_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select e.withdrawn_at is null and (
                   e.evidence_type = 'document'
                or not exists (select 1 from public.evidence_labels l where l.evidence_id = e.id and l.is_active)
                or exists (select 1 from public.evidence_labels l
                             join public.evidence_categories c on c.id = l.category_id
                            where l.evidence_id = e.id and l.is_active
                              and (c.needs_ocr or coalesce(l.needs_detail, false))))
          from public.evidence e where e.id = p_evidence_id), false);
$$;

revoke all on function public.ocr_wanted(uuid) from public, anon, authenticated;
grant execute on function public.ocr_wanted(uuid) to service_role;
