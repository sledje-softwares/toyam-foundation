-- =====================================================================
-- Category → field map per template version (docs/14 gap 26; docs/09 "Category → field map")
--
-- Files labelled without the vision LLM (insurer attachments by file name, operator tags, office
-- corrections) had no evidence_field_matches, because field matches only came from the LLM call (D35).
-- Each template version now carries a reviewed map "evidence category → report fields, with a score"
-- (config/templates/maps/<template>.yaml, sent by the loader as `category_fields`). Every labelled file
-- gets field matches from it at no per-file cost:
--
--   * public.case_template_category_fields: the map of one template version (staff read, admin write,
--     written by load_case_template like the other template tables)
--   * load_case_template(): validates and stores `category_fields` (unknown category / field fails the load)
--   * evidence_field_matches.category_id: the category a map-derived row came from (model 'category_map')
--   * private.derive_category_field_matches(evidence): recomputes the evidence's 'category_map' rows from its
--     active labels: score = map score × label confidence (null → 1), best category per field,
--     pipeline_version 'map-v1'. Labels from operator / filename_rule / text_rule / human always count;
--     labels from the LLM ('llm', 'model') only while the file has no model-produced field match
--     (fallback when the LLM returned no fields). Model rows are never touched.
--   * triggers: on evidence_labels insert / deactivation, and on insert of a model-produced match
--   * public.backfill_category_field_matches(limit): service role, fills existing evidence
-- Map rows are derived data (not evidence): stale ones are deleted, so a corrected label never keeps
-- pointing at the old category's fields.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The map table
-- ---------------------------------------------------------------------
-- lets the map reference a field of the same template version
alter table public.case_template_fields add constraint case_template_fields_id_template_key unique (id, template_id);

create table public.case_template_category_fields (
    template_id uuid not null references public.case_templates(id) on delete cascade,
    category_id uuid not null references public.evidence_categories(id),
    field_id    uuid not null,
    score       real not null check (score > 0 and score <= 1),
    primary key (template_id, category_id, field_id),
    foreign key (field_id, template_id) references public.case_template_fields(id, template_id) on delete cascade
);
create index ix_ctcf_field on public.case_template_category_fields (field_id);
comment on table public.case_template_category_fields is
    'Category → report field map of one template version (config/templates/maps/*.yaml); score 0–1 per pair';

alter table public.case_template_category_fields enable row level security;
create policy p_ctcf_read  on public.case_template_category_fields for select to authenticated using (public.is_staff());
create policy p_ctcf_admin on public.case_template_category_fields for all    to authenticated
    using (public.is_admin()) with check (public.is_admin());
revoke all on table public.case_template_category_fields from anon;

-- ---------------------------------------------------------------------
-- 2. Map-derived field matches carry their category
-- ---------------------------------------------------------------------
alter table public.evidence_field_matches
    add column category_id uuid references public.evidence_categories(id),
    add constraint ck_field_matches_map_category check ((model = 'category_map') = (category_id is not null));
comment on column public.evidence_field_matches.category_id is
    'model = ''category_map'': the label category whose template map produced this match; null for model matches';
create index ix_evidence_field_matches_evidence on public.evidence_field_matches (evidence_id);

-- ---------------------------------------------------------------------
-- 3. load_case_template(): store category_fields
-- ---------------------------------------------------------------------
-- Same as 20261117400000 plus the category_fields check and insert.
create or replace function public.load_case_template(p_config jsonb, p_source_file text default null,
                                                     p_activate boolean default true)
returns table (template_id uuid, version int, created boolean)
language plpgsql security invoker set search_path = '' as $$
declare
    v_sha        text := encode(extensions.digest(p_config::text, 'sha256'), 'hex');
    v_insurer    uuid;
    v_claim      public.claim_type := (p_config->>'claim_type')::public.claim_type;
    v_variant    text := coalesce(p_config->>'variant', 'general');
    v_existing   uuid;
    v_version    int;
    v_tid        uuid;
    v_sec        jsonb;  v_sec_ord int;  v_sec_id uuid;
    v_fld        jsonb;  v_fld_ord int;
    v_code       text;   v_cat_ord int;  v_cat uuid;
    v_missing    text[] := '{}';
    v_formats    text[];
    v_map        jsonb := p_config->'category_fields';
    v_entry      jsonb;  v_key text;  v_score jsonb;  v_bad boolean;
begin
    if not (public.is_admin() or private.is_archive_writer()) then
        raise exception 'Only an admin can load templates' using errcode = '42501';
    end if;
    select i.id into v_insurer from public.insurers i where i.code = p_config->>'insurer_code';
    if v_insurer is null then
        raise exception 'Unknown insurer code %', p_config->>'insurer_code' using errcode = '22023';
    end if;

    select t.id, t.version into v_existing, v_version from public.case_templates t
     where t.insurer_id = v_insurer and t.claim_type = v_claim and t.variant = v_variant and t.config_sha256 = v_sha
     order by t.version desc limit 1;
    if p_config ? 'report_layout' and jsonb_typeof(p_config->'report_layout') not in ('object', 'null') then
        raise exception 'report_layout must be an object' using errcode = '22023';
    end if;

    if v_existing is not null then
        if p_activate then
            update public.case_templates t set is_active = false
             where t.insurer_id = v_insurer and t.claim_type = v_claim and t.variant = v_variant
               and t.is_active and t.id <> v_existing;
            update public.case_templates t set is_active = true where t.id = v_existing;
        end if;
        return query select v_existing, v_version, false;
        return;
    end if;

    -- every category code must exist
    select coalesce(array_agg(distinct c.code), '{}') into v_missing
      from jsonb_array_elements(coalesce(p_config->'sections', '[]')) s,
           jsonb_array_elements_text(coalesce(s->'categories', '[]')) c(code)
     where not exists (select 1 from public.evidence_categories e where e.code = c.code);
    if cardinality(v_missing) > 0 then
        raise exception 'Unknown evidence categories: %', array_to_string(v_missing, ', ') using errcode = '22023';
    end if;

    -- category_fields: {<category code>: {<field key>: score}}; every code and key must exist, 0 < score <= 1
    if v_map is not null and jsonb_typeof(v_map) <> 'null' then
        if jsonb_typeof(v_map) <> 'object' then
            raise exception 'category_fields must be an object' using errcode = '22023';
        end if;
        for v_code, v_entry in select k, v from jsonb_each(v_map) x(k, v) loop
            if not exists (select 1 from public.evidence_categories e where e.code = v_code) then
                raise exception 'category_fields: unknown evidence category %', v_code using errcode = '22023';
            end if;
            if jsonb_typeof(v_entry) <> 'object' then
                raise exception 'category_fields.%: must be an object of field key → score', v_code using errcode = '22023';
            end if;
            for v_key, v_score in select k, v from jsonb_each(v_entry) x(k, v) loop
                if not exists (select 1 from jsonb_array_elements(coalesce(p_config->'sections', '[]')) s,
                                             jsonb_array_elements(coalesce(s->'fields', '[]')) f
                                where f->>'key' = v_key) then
                    raise exception 'category_fields.%: unknown field %', v_code, v_key using errcode = '22023';
                end if;
                v_bad := jsonb_typeof(v_score) <> 'number';
                if not v_bad then
                    v_bad := (v_score::text)::numeric <= 0 or (v_score::text)::numeric > 1;
                end if;
                if v_bad then
                    raise exception 'category_fields.%.%: score must be a number in (0, 1]', v_code, v_key using errcode = '22023';
                end if;
            end loop;
        end loop;
    end if;

    select coalesce(max(t.version), 0) + 1 into v_version from public.case_templates t
     where t.insurer_id = v_insurer and t.claim_type = v_claim and t.variant = v_variant;
    v_formats := case when jsonb_typeof(p_config->'output_formats') = 'array'
                           and jsonb_array_length(p_config->'output_formats') > 0
                      then array(select jsonb_array_elements_text(p_config->'output_formats'))
                      else '{pdf,docx}'::text[] end;

    insert into public.case_templates (insurer_id, claim_type, variant, name, version, is_active,
                                       requires_approval, output_formats, default_output_format,
                                       docx_template_path, intake_rules, report_email, report_layout,
                                       source_file, config_sha256, created_by)
    values (v_insurer, v_claim, v_variant, p_config->>'name', v_version, false,
            coalesce((p_config->>'requires_approval')::boolean, true), v_formats,
            coalesce(p_config->>'default_output_format', v_formats[1]),
            p_config->>'docx_template_path', coalesce(p_config->'intake_rules', '{}'),
            coalesce(p_config->'report_email', '{}'),
            case when jsonb_typeof(p_config->'report_layout') = 'object' then p_config->'report_layout' end,
            p_source_file, v_sha, (select auth.uid()))
    returning id into v_tid;

    for v_sec, v_sec_ord in select e, o::int from jsonb_array_elements(coalesce(p_config->'sections', '[]')) with ordinality x(e, o) loop
        insert into public.case_template_sections (template_id, key, title, position, guidance)
        values (v_tid, v_sec->>'key', v_sec->>'title', v_sec_ord, v_sec->>'guidance')
        returning id into v_sec_id;

        for v_code, v_cat_ord in select c, o::int from jsonb_array_elements_text(coalesce(v_sec->'categories', '[]')) with ordinality x(c, o) loop
            select e.id into v_cat from public.evidence_categories e where e.code = v_code;
            insert into public.case_template_section_categories (section_id, category_id, position)
            values (v_sec_id, v_cat, v_cat_ord);
        end loop;

        for v_fld, v_fld_ord in select e, o::int from jsonb_array_elements(coalesce(v_sec->'fields', '[]')) with ordinality x(e, o) loop
            insert into public.case_template_fields (template_id, section_id, key, label, field_type, source,
                                                     is_required, options, extract, help_text, position)
            values (v_tid, v_sec_id, v_fld->>'key', v_fld->>'label',
                    coalesce((v_fld->>'type')::public.template_field_type, 'text'),
                    coalesce((v_fld->>'source')::public.template_field_source, 'office'),
                    coalesce((v_fld->>'required')::boolean, false),
                    coalesce(v_fld->'options', '[]'), coalesce(v_fld->'extract', '{}'),
                    v_fld->>'help', v_fld_ord);
        end loop;
    end loop;

    -- category → field map (validated above)
    if jsonb_typeof(v_map) = 'object' then
        insert into public.case_template_category_fields (template_id, category_id, field_id, score)
        select v_tid, ec.id, f.id, (m.score::text)::real
          from jsonb_each(v_map) c(code, fields)
          cross join lateral jsonb_each(c.fields) m(key, score)
          join public.evidence_categories ec on ec.code = c.code
          join public.case_template_fields f on f.template_id = v_tid and f.key = m.key;
    end if;

    -- field checklists linked by name (in-use checklists of this insurer or all insurers)
    insert into public.case_template_checklists (template_id, checklist_template_id, is_default)
    select v_tid, ct.id, coalesce((c->>'default')::boolean, false)
      from jsonb_array_elements(coalesce(p_config->'checklists', '[]')) c
      join lateral (select t.id from public.checklist_templates t
                     where lower(t.name) = lower(c->>'name') and t.is_active
                       and (t.insurer_id = v_insurer or t.insurer_id is null)
                     order by (t.insurer_id is not null) desc limit 1) ct on true;

    if p_activate then
        update public.case_templates t set is_active = false
         where t.insurer_id = v_insurer and t.claim_type = v_claim and t.variant = v_variant and t.is_active;
        update public.case_templates t set is_active = true where t.id = v_tid;
    end if;
    return query select v_tid, v_version, true;
end $$;

comment on function public.load_case_template(jsonb, text, boolean) is
    'Loads one template version from config JSON (incl. report_layout, D51, and category_fields, gap 26); identical config is a no-op';

-- ---------------------------------------------------------------------
-- 4. Derive map matches for one evidence row
-- ---------------------------------------------------------------------
-- Idempotent: upserts the current set, deletes 'category_map' rows that no longer follow from the active labels.
-- Returns the number of map rows the evidence has afterwards.
create or replace function private.derive_category_field_matches(p_evidence_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_tpl uuid; v_has_model boolean; v_n int;
begin
    select c.template_id into v_tpl
      from public.evidence e join public.cases c on c.id = e.case_id where e.id = p_evidence_id;
    v_has_model := exists (select 1 from public.evidence_field_matches m
                            where m.evidence_id = p_evidence_id and m.model <> 'category_map');

    with src as (
        select distinct on (m.field_id) m.field_id, m.category_id,
               least(1, greatest(0, m.score * coalesce(l.confidence, 1)))::real as score
          from public.evidence_labels l
          join public.case_template_category_fields m on m.template_id = v_tpl and m.category_id = l.category_id
         where v_tpl is not null and l.evidence_id = p_evidence_id and l.is_active
           and (l.source not in ('llm', 'model') or not v_has_model)
         order by m.field_id, m.score * coalesce(l.confidence, 1) desc, m.category_id),
    stale as (
        delete from public.evidence_field_matches m
         where m.evidence_id = p_evidence_id and m.model = 'category_map'
           and not exists (select 1 from src where src.field_id = m.field_id)
        returning 1)
    insert into public.evidence_field_matches (evidence_id, field_id, score, model, pipeline_version, category_id)
    select p_evidence_id, src.field_id, src.score, 'category_map', 'map-v1', src.category_id from src
    on conflict (evidence_id, field_id, pipeline_version) do update
       set score = excluded.score, category_id = excluded.category_id
     where public.evidence_field_matches.model = 'category_map'
       and (public.evidence_field_matches.score, public.evidence_field_matches.category_id)
           is distinct from (excluded.score, excluded.category_id);
    select count(*) into v_n from public.evidence_field_matches m
     where m.evidence_id = p_evidence_id and m.model = 'category_map';
    return v_n;
end $$;
comment on function private.derive_category_field_matches(uuid) is
    'Recomputes the template-map field matches (model category_map) of one evidence row from its active labels';

-- ---------------------------------------------------------------------
-- 5. Triggers (never fail the label / match write)
-- ---------------------------------------------------------------------
create or replace function private.evidence_labels_category_map_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'UPDATE' and old.is_active is not distinct from new.is_active then
        return null;
    end if;
    begin
        perform private.derive_category_field_matches(new.evidence_id);
    exception when others then
        raise warning 'category map matches of evidence % failed: %', new.evidence_id, sqlerrm;
    end;
    return null;
end $$;
create trigger trg_evidence_labels_category_map after insert or update of is_active on public.evidence_labels
    for each row execute function private.evidence_labels_category_map_trg();

-- A model-produced match supersedes the map fallback built from that file's LLM labels
create or replace function private.field_matches_model_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    begin
        perform private.derive_category_field_matches(new.evidence_id);
    exception when others then
        raise warning 'category map matches of evidence % failed: %', new.evidence_id, sqlerrm;
    end;
    return null;
end $$;
create trigger trg_field_matches_model after insert on public.evidence_field_matches
    for each row when (new.model <> 'category_map')
    execute function private.field_matches_model_trg();

-- ---------------------------------------------------------------------
-- 6. Backfill (service role)
-- ---------------------------------------------------------------------
-- Evidence on a case whose template has a map, with an active label the map covers that counts (see derive),
-- and no map rows yet. Returns the number of files that got matches. Call repeatedly until it returns 0.
create or replace function public.backfill_category_field_matches(p_limit int default 1000) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_files int := 0;
begin
    for r in select e.id from public.evidence e
              join public.cases c on c.id = e.case_id
             where c.template_id is not null
               and not exists (select 1 from public.evidence_field_matches m
                                where m.evidence_id = e.id and m.model = 'category_map')
               and exists (select 1 from public.evidence_labels l
                             join public.case_template_category_fields cf
                               on cf.template_id = c.template_id and cf.category_id = l.category_id
                            where l.evidence_id = e.id and l.is_active
                              and (l.source not in ('llm', 'model')
                                   or not exists (select 1 from public.evidence_field_matches m
                                                   where m.evidence_id = e.id and m.model <> 'category_map')))
             order by e.server_received_at, e.id
             limit greatest(coalesce(p_limit, 1000), 1) loop
        if private.derive_category_field_matches(r.id) > 0 then v_files := v_files + 1; end if;
    end loop;
    return v_files;
end $$;

revoke all on function private.derive_category_field_matches(uuid), private.evidence_labels_category_map_trg(),
    private.field_matches_model_trg() from public, anon, authenticated;
revoke all on function public.backfill_category_field_matches(int) from public, anon, authenticated;
grant execute on function public.backfill_category_field_matches(int) to service_role;
