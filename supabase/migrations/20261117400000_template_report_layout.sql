-- =====================================================================
-- Template report layouts (build plan 7.7, D51)
--
-- load_case_template() now stores the config's `report_layout` object in
-- public.case_templates.report_layout (column added by 20261117000000_report_versions).
-- The template loader (services/intake/scripts/load-templates.ts) reads the layout file named
-- by `report_layout:` in the template YAML, embeds its asset files, validates it with
-- supabase/functions/_shared/report/validate.ts and sends it inside the template JSON, so the
-- layout is covered by config_sha256: a layout change is a new template version and cases keep
-- the version (and layout) they started with (rule 8). Format: docs/13-report-layouts.md.
-- Only change from the previous definition: the report_layout check and column.
-- =====================================================================

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

-- create or replace keeps the existing grants (admin / service role, revised_flow migration).
comment on function public.load_case_template(jsonb, text, boolean) is
    'Loads one template version from config JSON (incl. report_layout, D51); identical config is a no-op';
