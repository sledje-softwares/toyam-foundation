-- M6 processing pipeline worker (services/pipeline, D34–D38): atomic writers for its outputs.
--
--   1. public.record_llm_labels(evidence_id, result, superseded): one LLM answer for one file, in one
--      transaction. The file's earlier active `llm` labels are deactivated (kept), the new labels are
--      inserted (description on the first row only), and the file's LLM field matches are replaced by the
--      answer's (matches from other sources, e.g. a category -> field map, are kept and not duplicated).
--      A retried or re-run job therefore never leaves two active LLM answers. With
--      `superseded` (D37 escalation) the first model's labels are stored as inactive rows in the same
--      transaction. When the office has already corrected the file (an active `human` label), the new
--      labels are stored inactive: humans decide.
--   2. public.record_field_suggestions(evidence_id, rows): replaces the file's pending rule suggestions
--      (source text_rule); decided suggestions stay, and a value already decided for a field is not
--      suggested again.
--
-- Both are service-role only (the worker); the apps never call them.

-- ---------------------------------------------------------------------
-- 1. LLM labels and field matches
-- ---------------------------------------------------------------------
-- p_result / p_superseded: {pipeline_version, model, labels: [{code, confidence}], fields: [{key, confidence}],
--                           needs_detail, detail_reason, description}
-- Returns {labels, superseded, field_matches, held_for_review}.
create or replace function public.record_llm_labels(p_evidence_id uuid, p_result jsonb, p_superseded jsonb default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_template uuid;
    v_version  text := nullif(btrim(p_result->>'pipeline_version'), '');
    v_model    text := nullif(btrim(p_result->>'model'), '');
    v_human    boolean;
    v_bad      text;
    v_labels   int;
    v_old      int := 0;
    v_fields   int;
begin
    select c.template_id into v_template
      from public.evidence e join public.cases c on c.id = e.case_id
     where e.id = p_evidence_id;
    if not found then
        raise exception 'Evidence not found' using errcode = 'P0002';
    end if;
    if v_version is null or v_model is null then
        raise exception 'pipeline_version and model are required' using errcode = '22023';
    end if;
    if jsonb_typeof(p_result->'labels') is distinct from 'array' or jsonb_array_length(p_result->'labels') = 0 then
        raise exception 'At least one label is required' using errcode = '22023';
    end if;
    if p_superseded is not null and (nullif(btrim(p_superseded->>'pipeline_version'), '') is null
                                     or nullif(btrim(p_superseded->>'model'), '') is null
                                     or jsonb_typeof(p_superseded->'labels') is distinct from 'array') then
        raise exception 'superseded needs pipeline_version, model and labels' using errcode = '22023';
    end if;

    select string_agg(distinct x->>'code', ', ') into v_bad
      from jsonb_array_elements(p_result->'labels' || coalesce(p_superseded->'labels', '[]'::jsonb)) x
     where not exists (select 1 from public.evidence_categories c where c.code = x->>'code' and c.is_active);
    if v_bad is not null then
        raise exception 'Unknown category: %', v_bad using errcode = '22023';
    end if;
    select string_agg(distinct x->>'key', ', ') into v_bad
      from jsonb_array_elements(coalesce(p_result->'fields', '[]'::jsonb)) x
     where not exists (select 1 from public.case_template_fields f where f.template_id = v_template and f.key = x->>'key');
    if v_bad is not null then
        raise exception 'Unknown field for the case template: %', v_bad using errcode = '22023';
    end if;

    -- one writer per file at a time
    perform pg_advisory_xact_lock(hashtextextended('record_llm_labels:' || p_evidence_id::text, 0));

    v_human := exists (select 1 from public.evidence_labels l
                        where l.evidence_id = p_evidence_id and l.is_active and l.source = 'human');

    update public.evidence_labels l set is_active = false
     where l.evidence_id = p_evidence_id and l.is_active and l.source = 'llm';

    if p_superseded is not null then
        insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, is_active,
                                            needs_detail, detail_reason, description, model)
        select p_evidence_id, c.id, least(greatest(coalesce((x.l->>'confidence')::real, 0), 0), 1), 'llm',
               p_superseded->>'pipeline_version', false,
               coalesce((p_superseded->>'needs_detail')::boolean, true),
               left(nullif(btrim(p_superseded->>'detail_reason'), ''), 300),
               case when x.o = 1 then left(nullif(btrim(p_superseded->>'description'), ''), 1000) end,
               left(p_superseded->>'model', 100)
          from jsonb_array_elements(p_superseded->'labels') with ordinality as x(l, o)
          join public.evidence_categories c on c.code = x.l->>'code';
        get diagnostics v_old = row_count;
    end if;

    -- first occurrence of a code wins (the parser already removes duplicates)
    insert into public.evidence_labels (evidence_id, category_id, confidence, source, pipeline_version, is_active,
                                        needs_detail, detail_reason, description, model)
    select p_evidence_id, d.category_id, d.confidence, 'llm', v_version, not v_human,
           coalesce((p_result->>'needs_detail')::boolean, true),
           left(nullif(btrim(p_result->>'detail_reason'), ''), 300),
           case when d.rn = 1 then left(nullif(btrim(p_result->>'description'), ''), 1000) end,
           left(v_model, 100)
      from (select distinct on (c.id) c.id as category_id, x.o as rn,
                   least(greatest(coalesce((x.l->>'confidence')::real, 0), 0), 1) as confidence
              from jsonb_array_elements(p_result->'labels') with ordinality as x(l, o)
              join public.evidence_categories c on c.code = x.l->>'code'
             order by c.id, x.o) d
     order by d.rn;
    get diagnostics v_labels = row_count;

    -- LLM field matches mirror the current answer (the table has no is_active; readers take every row).
    -- Only rows written by earlier LLM answers of this file are replaced (their model is on its llm labels);
    -- matches from other sources (e.g. a category -> field map, model 'category_map') are left alone and
    -- never duplicated.
    delete from public.evidence_field_matches m
     where m.evidence_id = p_evidence_id
       and (m.model = left(v_model, 100)
            or m.model in (select l.model from public.evidence_labels l
                            where l.evidence_id = p_evidence_id and l.source = 'llm' and l.model is not null));
    insert into public.evidence_field_matches (evidence_id, field_id, score, model, pipeline_version)
    select distinct on (f.id) p_evidence_id, f.id, least(greatest(coalesce((x->>'confidence')::real, 0), 0), 1),
           left(v_model, 100), v_version
      from jsonb_array_elements(coalesce(p_result->'fields', '[]'::jsonb)) x
      join public.case_template_fields f on f.template_id = v_template and f.key = x->>'key'
     order by f.id, (x->>'confidence')::real desc nulls last
    on conflict (evidence_id, field_id, pipeline_version) do nothing;
    get diagnostics v_fields = row_count;

    return jsonb_build_object('labels', v_labels, 'superseded', v_old, 'field_matches', v_fields, 'held_for_review', v_human);
end $$;

comment on function public.record_llm_labels(uuid, jsonb, jsonb) is
    'Pipeline worker (service role): store one LLM label answer for a file atomically; earlier LLM labels deactivated, '
    'field matches replaced, inactive when a human label exists (D34, D35, D37)';

-- ---------------------------------------------------------------------
-- 2. Field value suggestions from OCR + rules
-- ---------------------------------------------------------------------
-- p_rows: [{ocr_id, field_key, value, confidence, block_index}]. Returns the number of suggestions inserted.
create or replace function public.record_field_suggestions(p_evidence_id uuid, p_rows jsonb)
returns int
language plpgsql security definer set search_path = '' as $$
declare
    v_template uuid;
    v_bad      text;
    v_n        int;
begin
    select c.template_id into v_template
      from public.evidence e join public.cases c on c.id = e.case_id
     where e.id = p_evidence_id;
    if not found then
        raise exception 'Evidence not found' using errcode = 'P0002';
    end if;
    if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
        raise exception 'Rows must be a JSON array' using errcode = '22023';
    end if;
    select string_agg(distinct x->>'field_key', ', ') into v_bad
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
     where not exists (select 1 from public.case_template_fields f where f.template_id = v_template and f.key = x->>'field_key');
    if v_bad is not null then
        raise exception 'Unknown field for the case template: %', v_bad using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
                where x->>'ocr_id' is not null
                  and not exists (select 1 from public.evidence_ocr o
                                   where o.id = (x->>'ocr_id')::uuid and o.evidence_id = p_evidence_id)) then
        raise exception 'OCR row does not belong to the file' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
                where nullif(btrim(x->>'value'), '') is null) then
        raise exception 'Suggestion value is required' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('record_field_suggestions:' || p_evidence_id::text, 0));

    delete from public.field_suggestions s
     where s.evidence_id = p_evidence_id and s.status = 'pending' and s.source = 'text_rule';

    insert into public.field_suggestions (evidence_id, ocr_id, field_id, value, confidence, block_index, source)
    select distinct on (f.id, btrim(x->>'value'))
           p_evidence_id, (x->>'ocr_id')::uuid, f.id, left(btrim(x->>'value'), 500),
           least(greatest(coalesce((x->>'confidence')::real, 0), 0), 1), (x->>'block_index')::int, 'text_rule'
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
      join public.case_template_fields f on f.template_id = v_template and f.key = x->>'field_key'
     where not exists (select 1 from public.field_suggestions d
                        where d.evidence_id = p_evidence_id and d.field_id = f.id and d.status <> 'pending'
                          and d.value = left(btrim(x->>'value'), 500))
     order by f.id, btrim(x->>'value'), (x->>'confidence')::real desc nulls last;
    get diagnostics v_n = row_count;
    return v_n;
end $$;

comment on function public.record_field_suggestions(uuid, jsonb) is
    'Pipeline worker (service role): replace the pending OCR-rule suggestions of a file; decided ones are kept';

-- ---------------------------------------------------------------------
-- Privileges: service role only
-- ---------------------------------------------------------------------
revoke all on function public.record_llm_labels(uuid, jsonb, jsonb), public.record_field_suggestions(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.record_llm_labels(uuid, jsonb, jsonb), public.record_field_suggestions(uuid, jsonb)
    to service_role;
