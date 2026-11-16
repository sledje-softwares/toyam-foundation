-- =====================================================================
-- Report versions and shrunk image copies (build plan 7.7, D51; closes reports gaps G1 / G2)
--
--   A. case_templates.report_layout   structured copy of the insurer's report layout (format and
--                                     loader defined elsewhere; only "is an object" is checked here).
--   B. evidence_derivatives           shrunk JPEG copies of image evidence (384 px for labelling,
--                                     1600 px for reports), made only by the field app and recorded
--                                     through record_device_derivative(). Not evidence (rule 2 does
--                                     not cover them) but set once. No server-side shrinking: insurer
--                                     attachments and photos without a copy are used as the original.
--                                     Staff read on cases they manage; field users nothing.
--   C. prepare_report_version(case)   everything the generator (edge function report-generate,
--                                     staff JWT) needs: header facts, layout, sections + values,
--                                     values_token, default photo selection, annexure files.
--   D. create_report_version(...)     records a generated version: files already uploaded to the
--                                     `reports` bucket at {case_id}/{report_id}/report.{pdf|docx},
--                                     photos as report_annexures, a snapshot of the field values,
--                                     audit REPORT_GENERATED, staff-only thread event.
--   E. Generated versions are records: API roles cannot insert / change / delete them (or their
--      files / annexures) directly.
--   F. Storage `reports`: office may write {case_id}/{report_id}/report.{pdf|docx} on their own
--      cases; nobody overwrites those objects through the API (no update; no delete as before).
--
-- Errcodes: 42501 not allowed · P0002 not found · 22023 bad input · 55000 case not in a state that
-- allows it · RV409 values changed since prepare_report_version (regenerate) · 23505 report id
-- already used by another case.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Report layout on the template version
-- ---------------------------------------------------------------------
alter table public.case_templates
    add column report_layout jsonb check (report_layout is null or jsonb_typeof(report_layout) = 'object');
comment on column public.case_templates.report_layout is
    'D51: structured copy of the insurer''s report layout used by the generator (format defined by the template loader)';

-- ---------------------------------------------------------------------
-- B. Shrunk image copies (made by the field app only; no server-side shrinking)
-- ---------------------------------------------------------------------
-- Content-addressed: the key carries the hash of the copy itself, so a re-upload with other bytes can
-- never overwrite a recorded copy.
create or replace function private.derivative_path(p_case_id uuid, p_original_sha256 text, p_width int, p_copy_sha256 text) returns text
language sql immutable set search_path = '' as $$
    select 'derived/' || p_case_id::text || '/' || p_original_sha256 || '/w' || p_width::text || '-' || p_copy_sha256 || '.jpg';
$$;
revoke all on function private.derivative_path(uuid, text, int, text) from public, anon;
grant execute on function private.derivative_path(uuid, text, int, text) to authenticated, service_role;

create table public.evidence_derivatives (
    evidence_id  uuid        not null references public.evidence(id),
    width        int         not null check (width in (384, 1600)),
    storage_path text        not null,
    sha256       text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes   bigint      check (size_bytes > 0),
    pixel_width  int         check (pixel_width > 0),
    pixel_height int         check (pixel_height > 0),
    created_at   timestamptz not null default now(),
    primary key (evidence_id, width)
);
comment on table public.evidence_derivatives is
    'D51: shrunk JPEG copies (384 labelling, 1600 reports) the field app made of its own photos, stored at '
    'derived/{case_id}/{original_sha256}/w{width}-{copy_sha256}.jpg. Not evidence; set once (no update / delete). '
    'Files without a copy (insurer attachments, a phone that failed to make one) are used as the original.';

-- Path scheme and image-only for every writer; rows are set once. Security definer: reads the evidence
-- whatever the caller.
create or replace function private.evidence_derivatives_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ev public.evidence;
begin
    if tg_op <> 'INSERT' then
        raise exception 'A shrunk copy is recorded once and cannot be changed or deleted' using errcode = '42501';
    end if;
    new.created_at := now();
    select * into v_ev from public.evidence e where e.id = new.evidence_id;
    if v_ev.evidence_type is distinct from 'photo' or v_ev.sha256 is null then
        raise exception 'Only images have shrunk copies' using errcode = '22023';
    end if;
    if new.storage_path <> private.derivative_path(v_ev.case_id, v_ev.sha256, new.width, new.sha256) then
        raise exception 'The shrunk copy must be stored at %', private.derivative_path(v_ev.case_id, v_ev.sha256, new.width, new.sha256)
            using errcode = '22023';
    end if;
    return new;
end $$;
revoke all on function private.evidence_derivatives_guard() from public, anon, authenticated;
create trigger trg_evidence_derivatives_guard before insert or update or delete on public.evidence_derivatives
    for each row execute function private.evidence_derivatives_guard();

alter table public.evidence_derivatives enable row level security;
create policy p_derivatives_staff_r on public.evidence_derivatives for select to authenticated
    using (public.is_staff() and private.can_manage_evidence(evidence_id));
revoke all on public.evidence_derivatives from anon, authenticated;
grant select on public.evidence_derivatives to authenticated;

-- One rule for recording a copy and for presigning its upload (evidence-upload, device_derivative_target):
-- the operator still sees the case, or is inside the D43 late window of a task they held there.
create or replace function private.field_derivative_access(p_case_id uuid, p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select private.field_can_see_case(p_case_id)
           or exists (select 1 from public.task_holds h join public.tasks t on t.id = h.task_id
                       where t.case_id = p_case_id and h.profile_id = p_uid
                         and (h.held_until is null
                              or now() <= h.held_until + make_interval(hours => private.setting_int('late_upload_grace_hours', 72))));
$$;
revoke all on function private.field_derivative_access(uuid, uuid) from public, anon, authenticated;

-- Field app: records a shrunk copy (384 or 1600) it made of its own photo and uploaded next to the
-- original. The photo (case_id, sha256) must exist, be captured by the caller, be an image and not
-- withdrawn. D43: allowed while the operator can still see the case (assignee of a task on it, any
-- status) or within the late-upload window of a task they held there (held_until + late_upload_grace_hours);
-- a deactivated operator's phone does not record copies (the report then uses the original).
-- Idempotent: a copy already recorded for (photo, width) is returned unchanged with recorded = false.
-- Returns {evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height, recorded}.
create or replace function public.record_device_derivative(
    p_case_id uuid, p_original_sha256 text, p_width int, p_storage_path text, p_sha256 text,
    p_size_bytes bigint, p_pixel_width int, p_pixel_height int)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid uuid := (select auth.uid());
    v_ev  public.evidence;
    v_row public.evidence_derivatives;
    v_new boolean := false;
begin
    if not public.is_field() then
        raise exception 'Only field operators record copies made on their phone' using errcode = '42501';
    end if;
    if p_width is null or p_width not in (384, 1600) then
        raise exception 'Width must be 384 or 1600' using errcode = '22023';
    end if;
    if p_original_sha256 is null or p_original_sha256 !~ '^[0-9a-f]{64}$'
       or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception 'SHA-256 values must be 64 lower-case hex characters' using errcode = '22023';
    end if;
    if p_storage_path is null or p_storage_path <> private.derivative_path(p_case_id, p_original_sha256, p_width, p_sha256) then
        raise exception 'The shrunk copy must be stored at %', private.derivative_path(p_case_id, p_original_sha256, p_width, p_sha256)
            using errcode = '22023';
    end if;
    if p_size_bytes <= 0 or p_pixel_width <= 0 or p_pixel_height <= 0 then
        raise exception 'Size and pixel dimensions must be positive' using errcode = '22023';
    end if;
    select * into v_ev from public.evidence e where e.case_id = p_case_id and e.sha256 = p_original_sha256;
    if not found or v_ev.captured_by is distinct from v_uid then
        raise exception 'Photo not found among your uploads on this case' using errcode = 'P0002';
    end if;
    if v_ev.evidence_type <> 'photo' then
        raise exception 'Only images have shrunk copies' using errcode = '22023';
    end if;
    if v_ev.withdrawn_at is not null then
        raise exception 'This photo was withdrawn' using errcode = '55000';
    end if;
    if not private.field_derivative_access(p_case_id, v_uid) then
        raise exception 'You no longer work on this case' using errcode = '42501';
    end if;

    insert into public.evidence_derivatives (evidence_id, width, storage_path, sha256, size_bytes, pixel_width, pixel_height)
    values (v_ev.id, p_width, p_storage_path, p_sha256, p_size_bytes, p_pixel_width, p_pixel_height)
    on conflict (evidence_id, width) do nothing
    returning * into v_row;
    v_new := found;
    if not v_new then
        select * into v_row from public.evidence_derivatives d where d.evidence_id = v_ev.id and d.width = p_width;
    end if;
    return jsonb_build_object('evidence_id', v_row.evidence_id, 'width', v_row.width, 'storage_path', v_row.storage_path,
                              'sha256', v_row.sha256, 'size_bytes', v_row.size_bytes, 'pixel_width', v_row.pixel_width,
                              'pixel_height', v_row.pixel_height, 'recorded', v_new);
end $$;
revoke all on function public.record_device_derivative(uuid, text, int, text, text, bigint, int, int) from public, anon;
grant execute on function public.record_device_derivative(uuid, text, int, text, text, bigint, int, int) to authenticated;

-- ---------------------------------------------------------------------
-- C. Report versions: snapshot columns, values token, prepare
-- ---------------------------------------------------------------------
alter table public.reports
    add column field_values jsonb check (field_values is null or jsonb_typeof(field_values) = 'object'),
    add column values_token text;
comment on column public.reports.field_values is
    'G2: field values the version was generated from: {"<field key>": {"value", "source", "updated_at"}}';
comment on column public.reports.values_token is 'values_token of prepare_report_version() the version was generated from';

-- Changes whenever any case_field_values row of the case changes (value, source or time) or the template does.
create or replace function private.report_values_token(p_case_id uuid) returns text
language sql stable security definer set search_path = '' as $$
    select 'v1:' || md5(coalesce(c.template_id::text, '-') || '#' || coalesce((
        select string_agg(v.field_id::text || ':' || coalesce(md5(v.value), '-') || ':' || v.source::text || ':'
                          || to_char(v.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'), ',' order by v.field_id)
          from public.case_field_values v where v.case_id = c.id), ''))
      from public.cases c where c.id = p_case_id;
$$;
revoke all on function private.report_values_token(uuid) from public, anon, authenticated;

-- Shared refusal for prepare / create: same rules as save_case_field_values (D44, D45, D46).
create or replace function private.report_generation_case(p_case_id uuid, p_lock boolean) returns public.cases
language plpgsql security definer set search_path = '' as $$
declare v_case public.cases;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can generate reports' using errcode = '42501';
    end if;
    if p_lock then
        select * into v_case from public.cases c where c.id = p_case_id for update;
    else
        select * into v_case from public.cases c where c.id = p_case_id;
    end if;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can generate this report' using errcode = '42501';
    end if;
    if not private.report_editable_status(v_case.status) then
        raise exception '%', case v_case.status
            when 'orchestrator_review' then 'The report is waiting for approval or approved, so no new version can be made'
            when 'submitted' then private.submitted_case_message()
            when 'closed' then 'The case is closed'
            else 'The case is cancelled' end
            using errcode = '55000';
    end if;
    if v_case.template_id is null then
        raise exception 'This case has no template' using errcode = '22023';
    end if;
    return v_case;
end $$;
revoke all on function private.report_generation_case(uuid, boolean) from public, anon, authenticated;

-- First section (by position) whose categories contain one of the file's active labels; within it the
-- matching category with the lowest position. One row per file of the case that is not withdrawn,
-- not marked not relevant and not a note.
create or replace function private.report_file_placement(p_case_id uuid, p_template_id uuid)
returns table (evidence_id uuid, section_key text, section_position int, category_position int,
               category_code text, category_name text, label_description text)
language sql stable security definer set search_path = '' as $$
    select distinct on (e.id) e.id, s.key, s.position, sc.position, cat.code, cat.name, nullif(btrim(l.description), '')
      from public.evidence e
      join public.evidence_labels l on l.evidence_id = e.id and l.is_active
      join public.case_template_section_categories sc on sc.category_id = l.category_id
      join public.case_template_sections s on s.id = sc.section_id and s.template_id = p_template_id
      join public.evidence_categories cat on cat.id = l.category_id
     where e.case_id = p_case_id and e.withdrawn_at is null and e.relevance <> 'not_relevant' and e.evidence_type <> 'note'
     order by e.id, s.position, sc.position, (l.description is null), l.created_at desc;
$$;
revoke all on function private.report_file_placement(uuid, uuid) from public, anon, authenticated;

create or replace function private.report_file_json(e public.evidence) returns jsonb
language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'evidence_type', e.evidence_type, 'mime_type', e.mime_type, 'original_filename', e.original_filename,
        'capture_source', e.capture_source, 'storage_backend', e.storage_backend, 'storage_path', e.storage_path,
        'sha256', e.sha256, 'size_bytes', e.size_bytes, 'server_received_at', e.server_received_at,
        'device_captured_at', e.device_captured_at, 'latitude', e.latitude, 'longitude', e.longitude,
        'relevance', e.relevance,
        'labels', coalesce((select jsonb_agg(c.code order by c.code) from public.evidence_labels l
                             join public.evidence_categories c on c.id = l.category_id
                            where l.evidence_id = e.id and l.is_active), '[]'::jsonb),
        'derivatives', coalesce((select jsonb_agg(jsonb_build_object(
                                    'width', d.width, 'storage_path', d.storage_path, 'sha256', d.sha256, 'size_bytes', d.size_bytes,
                                    'pixel_width', d.pixel_width, 'pixel_height', d.pixel_height) order by d.width)
                                   from public.evidence_derivatives d where d.evidence_id = e.id), '[]'::jsonb));
$$;
revoke all on function private.report_file_json(public.evidence) from public, anon, authenticated;

-- Everything the generator needs (shape documented in docs/06 and docs/12-office-pages/reports.md).
create or replace function public.prepare_report_version(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    v_case   public.cases := private.report_generation_case(p_case_id, false);
    v_tpl    public.case_templates;
    v_ins    public.insurers;
    v_latest public.reports;
    v_result jsonb;
begin
    select * into v_tpl from public.case_templates t where t.id = v_case.template_id;
    select * into v_ins from public.insurers i where i.id = v_case.insurer_id;
    select * into v_latest from public.reports r where r.case_id = p_case_id order by r.version desc limit 1;

    v_result := jsonb_build_object(
        'prepared_at', now(),
        'prepared_by', jsonb_build_object('id', (select auth.uid()),
                                          'name', (select p.full_name from public.profiles p where p.id = (select auth.uid()))),
        'case', jsonb_build_object(
            'id', v_case.id, 'case_ref', v_case.case_ref, 'status', v_case.status, 'claim_type', v_case.claim_type,
            'insurer_claim_no', v_case.insurer_claim_no, 'policy_no', v_case.policy_no,
            'claim_amount', v_case.claim_amount, 'incident_date', v_case.incident_date,
            'received_at', v_case.received_at, 'due_at', v_case.due_at, 'created_at', v_case.created_at,
            'insurer', jsonb_build_object('id', v_ins.id, 'code', v_ins.code, 'name', v_ins.name),
            'office_owner', case when v_case.office_owner_id is not null then jsonb_build_object(
                'id', v_case.office_owner_id,
                'name', (select p.full_name from public.profiles p where p.id = v_case.office_owner_id)) end,
            'orchestrator', case when v_case.orchestrator_id is not null then jsonb_build_object(
                'id', v_case.orchestrator_id,
                'name', (select p.full_name from public.profiles p where p.id = v_case.orchestrator_id)) end),
        'template', jsonb_build_object(
            'id', v_tpl.id,
            'key', coalesce(substring(v_tpl.source_file from '([^/]+)\.ya?ml$'),
                            lower(v_ins.code) || '-' || v_tpl.claim_type::text || '-' || v_tpl.variant),
            'name', v_tpl.name, 'version', v_tpl.version, 'variant', v_tpl.variant, 'claim_type', v_tpl.claim_type,
            'requires_approval', v_tpl.requires_approval, 'output_formats', to_jsonb(v_tpl.output_formats),
            'default_output_format', v_tpl.default_output_format, 'docx_template_path', v_tpl.docx_template_path),
        'report_layout', v_tpl.report_layout,
        'values_token', private.report_values_token(p_case_id),
        'next_version', coalesce(v_latest.version, 0) + 1,
        'latest_version', case when v_latest.id is not null then jsonb_build_object(
            'report_id', v_latest.id, 'version', v_latest.version, 'origin', v_latest.origin,
            'created_at', v_latest.created_at, 'values_token', v_latest.values_token) end,
        'sections', coalesce((
            select jsonb_agg(jsonb_build_object(
                'key', s.key, 'title', s.title, 'position', s.position, 'guidance', s.guidance,
                'categories', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name, 'position', sc.position)
                                                         order by sc.position, c.code)
                                          from public.case_template_section_categories sc
                                          join public.evidence_categories c on c.id = sc.category_id
                                         where sc.section_id = s.id), '[]'::jsonb),
                'fields', coalesce((select jsonb_agg(jsonb_build_object(
                                        'key', f.key, 'label', f.label, 'type', f.field_type, 'required', f.is_required,
                                        'options', f.options, 'help_text', f.help_text, 'position', f.position,
                                        'field_source', f.source,
                                        'value', v.value, 'source', v.source, 'updated_at', v.updated_at)
                                        order by f.position)
                                      from public.case_template_fields f
                                      left join public.case_field_values v on v.case_id = p_case_id and v.field_id = f.id
                                     where f.section_id = s.id), '[]'::jsonb))
                order by s.position)
              from public.case_template_sections s where s.template_id = v_tpl.id), '[]'::jsonb),
        'photos', coalesce((
            select jsonb_agg(x.j order by x.section_position, x.pos)
              from (select p.section_position,
                           row_number() over (partition by p.section_key
                                              order by p.category_position, e.server_received_at, e.id) as pos,
                           jsonb_build_object(
                               'evidence_id', e.id, 'section_key', p.section_key,
                               'position', row_number() over (partition by p.section_key
                                                              order by p.category_position, e.server_received_at, e.id),
                               'caption', coalesce(p.label_description, p.category_name),
                               'category_code', p.category_code, 'category_name', p.category_name,
                               'label_description', p.label_description) || private.report_file_json(e) as j
                      from private.report_file_placement(p_case_id, v_tpl.id) p
                      join public.evidence e on e.id = p.evidence_id
                     where e.evidence_type = 'photo') x), '[]'::jsonb),
        'unplaced_photos', coalesce((
            select jsonb_agg(jsonb_build_object('evidence_id', e.id) || private.report_file_json(e)
                             order by e.server_received_at, e.id)
              from public.evidence e
             where e.case_id = p_case_id and e.evidence_type = 'photo' and e.withdrawn_at is null
               and e.relevance <> 'not_relevant'
               and not exists (select 1 from private.report_file_placement(p_case_id, v_tpl.id) p where p.evidence_id = e.id)), '[]'::jsonb),
        'annexure_files', coalesce((
            select jsonb_agg(jsonb_build_object('evidence_id', e.id, 'section_key', p.section_key,
                                                'category_code', p.category_code, 'category_name', p.category_name)
                             || private.report_file_json(e)
                             order by p.section_position nulls last, p.category_position nulls last, e.server_received_at, e.id)
              from public.evidence e
              left join private.report_file_placement(p_case_id, v_tpl.id) p on p.evidence_id = e.id
             where e.case_id = p_case_id and e.evidence_type in ('document', 'audio', 'video')
               and e.withdrawn_at is null and e.relevance <> 'not_relevant'), '[]'::jsonb));
    return v_result;
end $$;
revoke all on function public.prepare_report_version(uuid) from public, anon;
grant execute on function public.prepare_report_version(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- D. Recording a generated version
-- ---------------------------------------------------------------------
-- p_files:  [{"format": "pdf"|"docx", "storage_path": "{case_id}/{report_id}/report.{format}",
--             "sha256": "<64 hex>", "size_bytes": n}]   1–2 entries, formats the template allows,
--           each object already uploaded to the `reports` bucket.
-- p_photos: [{"evidence_id", "section_key", "position", "caption"?}]  0–500 entries; images or documents
--           of the case, not withdrawn, not marked not relevant; section_key a section of the template;
--           position ≥ 1, unique per section.
-- returns   {"report_id", "version", "created"}   (created = false when p_report_id was recorded before)
create or replace function public.create_report_version(
    p_case_id uuid, p_report_id uuid, p_values_token text, p_files jsonb, p_photos jsonb, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_uid      uuid := (select auth.uid());
    v_case     public.cases;
    v_tpl      public.case_templates;
    v_existing public.reports;
    v_version  int;
    v_file     jsonb;
    v_photo    jsonb;
    v_formats  text[] := '{}';
    v_path     text;
    v_main     text;
    v_notes    text := nullif(btrim(coalesce(p_notes, '')), '');
    v_snapshot jsonb;
    v_name     text;
    v_ev       public.evidence;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can generate reports' using errcode = '42501';
    end if;
    if p_report_id is null then
        raise exception 'A report id is required' using errcode = '22023';
    end if;
    -- a retry after a lost response: the version is already recorded
    select * into v_existing from public.reports r where r.id = p_report_id;
    if found then
        if v_existing.case_id <> p_case_id or v_existing.origin <> 'generated' or not private.can_manage_case(v_existing.case_id) then
            raise exception 'This report id is already used' using errcode = '23505';
        end if;
        return jsonb_build_object('report_id', v_existing.id, 'version', v_existing.version, 'created', false);
    end if;

    v_case := private.report_generation_case(p_case_id, true);
    select * into v_tpl from public.case_templates t where t.id = v_case.template_id;

    if p_values_token is null or p_values_token is distinct from private.report_values_token(p_case_id) then
        raise exception 'The report values changed since this version was prepared. Generate it again'
            using errcode = 'RV409';
    end if;
    if char_length(v_notes) > 2000 then
        raise exception 'Keep the notes under 2000 characters' using errcode = '22023';
    end if;

    -- files
    if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) not between 1 and 2 then
        raise exception 'One or two report files (pdf, docx) are required' using errcode = '22023';
    end if;
    for v_file in select * from jsonb_array_elements(p_files) loop
        if jsonb_typeof(v_file) <> 'object' or coalesce(v_file->>'format', '') not in ('pdf', 'docx') then
            raise exception 'Each file needs a format pdf or docx' using errcode = '22023';
        end if;
        if (v_file->>'format') = any (v_formats) then
            raise exception 'Each format can be given once' using errcode = '22023';
        end if;
        if not ((v_file->>'format') = any (v_tpl.output_formats)) then
            raise exception 'Format % is not used by this insurer template', upper(v_file->>'format') using errcode = '22023';
        end if;
        v_path := p_case_id::text || '/' || p_report_id::text || '/report.' || (v_file->>'format');
        if (v_file->>'storage_path') is distinct from v_path then
            raise exception 'The % file must be stored at %', upper(v_file->>'format'), v_path using errcode = '22023';
        end if;
        if coalesce(v_file->>'sha256', '') !~ '^[0-9a-f]{64}$' then
            raise exception 'Each file needs a SHA-256 of 64 lower-case hex characters' using errcode = '22023';
        end if;
        if jsonb_typeof(v_file->'size_bytes') is distinct from 'number' or (v_file->>'size_bytes')::numeric <= 0
           or (v_file->>'size_bytes')::numeric <> trunc((v_file->>'size_bytes')::numeric) then
            raise exception 'Each file needs its size in bytes' using errcode = '22023';
        end if;
        if not exists (select 1 from storage.objects o where o.bucket_id = 'reports' and o.name = v_path
                          and (o.metadata->>'size' is null or (o.metadata->>'size')::bigint = (v_file->>'size_bytes')::bigint)) then
            raise exception 'The % file has not been uploaded (or its size differs)', upper(v_file->>'format') using errcode = '22023';
        end if;
        v_formats := v_formats || (v_file->>'format');
    end loop;
    v_main := p_case_id::text || '/' || p_report_id::text || '/report.' || case when 'pdf' = any (v_formats) then 'pdf' else 'docx' end;

    -- photos
    if p_photos is null then
        p_photos := '[]'::jsonb;
    end if;
    if jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) > 500 then
        raise exception 'Photos must be a list of at most 500 entries' using errcode = '22023';
    end if;
    for v_photo in select * from jsonb_array_elements(p_photos) loop
        if jsonb_typeof(v_photo) <> 'object' or coalesce(v_photo->>'evidence_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            raise exception 'Each photo needs an evidence_id' using errcode = '22023';
        end if;
        select * into v_ev from public.evidence e where e.id = (v_photo->>'evidence_id')::uuid and e.case_id = p_case_id;
        if not found or v_ev.evidence_type not in ('photo', 'document') then
            raise exception 'Photo % is not a file of this case', v_photo->>'evidence_id' using errcode = '22023';
        end if;
        if v_ev.withdrawn_at is not null or v_ev.relevance = 'not_relevant' then
            raise exception 'Photo % was withdrawn or marked not relevant', v_photo->>'evidence_id' using errcode = '22023';
        end if;
        if not exists (select 1 from public.case_template_sections s
                        where s.template_id = v_tpl.id and s.key = v_photo->>'section_key') then
            raise exception 'Unknown section for photo %', v_photo->>'evidence_id' using errcode = '22023';
        end if;
        if jsonb_typeof(v_photo->'position') is distinct from 'number' or (v_photo->>'position')::numeric < 1
           or (v_photo->>'position')::numeric <> trunc((v_photo->>'position')::numeric) or (v_photo->>'position')::numeric > 10000 then
            raise exception 'Each photo needs a position of 1 or more' using errcode = '22023';
        end if;
        if jsonb_typeof(v_photo->'caption') not in ('string', 'null') or char_length(v_photo->>'caption') > 500 then
            raise exception 'A caption is text of at most 500 characters' using errcode = '22023';
        end if;
    end loop;
    if (select count(*) from jsonb_array_elements(p_photos)) <> (select count(distinct x->>'evidence_id') from jsonb_array_elements(p_photos) x) then
        raise exception 'A photo can appear once in a report' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_array_elements(p_photos))
       <> (select count(distinct (x->>'section_key', (x->>'position')::int)) from jsonb_array_elements(p_photos) x) then
        raise exception 'Photo positions must be unique within a section' using errcode = '22023';
    end if;

    -- snapshot (G2)
    select coalesce(jsonb_object_agg(f.key, jsonb_build_object('value', v.value, 'source', v.source, 'updated_at', v.updated_at)), '{}'::jsonb)
      into v_snapshot
      from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
     where v.case_id = p_case_id;

    select coalesce(max(r.version), 0) + 1 into v_version from public.reports r where r.case_id = p_case_id;
    insert into public.reports (id, case_id, version, status, storage_path, uploaded_by, notes, origin, template_id,
                                template_version, field_values, values_token)
    values (p_report_id, p_case_id, v_version, 'draft', v_main, v_uid, v_notes, 'generated', v_tpl.id, v_tpl.version,
            v_snapshot, p_values_token);

    insert into public.report_files (report_id, format, storage_path, sha256, size_bytes)
    select p_report_id, f->>'format', f->>'storage_path', f->>'sha256', (f->>'size_bytes')::bigint
      from jsonb_array_elements(p_files) f;

    -- report_annexures_validate (unchanged) checks case, withdrawn and relevance again
    insert into public.report_annexures (report_id, evidence_id, section_key, position, caption)
    select p_report_id, (x->>'evidence_id')::uuid, x->>'section_key', (x->>'position')::int,
           nullif(btrim(coalesce(x->>'caption', '')), '')
      from jsonb_array_elements(p_photos) x;

    insert into public.audit_log (actor_id, action, table_name, record_id, new_data)
    values (v_uid, 'REPORT_GENERATED', 'reports', p_report_id,
            jsonb_build_object('case_id', p_case_id, 'version', v_version, 'formats', to_jsonb(v_formats),
                               'photos', jsonb_array_length(p_photos), 'values_token', p_values_token,
                               'template_id', v_tpl.id, 'template_version', v_tpl.version));

    select p.full_name into v_name from public.profiles p where p.id = v_uid;
    perform private.post_system_message(p_case_id,
        'Report version ' || v_version || ' generated by ' || coalesce(v_name, 'staff')
        || ' (' || upper(array_to_string(v_formats, ', ')) || ')', null, 'system', null, 'staff');

    return jsonb_build_object('report_id', p_report_id, 'version', v_version, 'created', true);
end $$;
revoke all on function public.create_report_version(uuid, uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.create_report_version(uuid, uuid, text, jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------
-- E. Generated versions are records for API roles
-- ---------------------------------------------------------------------
-- security invoker on purpose: current_user is the real caller; create_report_version (owner) passes.
create or replace function private.generated_reports_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return coalesce(new, old);
    end if;
    if tg_table_name = 'reports' then
        if tg_op = 'INSERT' and (new.origin = 'generated' or new.field_values is not null or new.values_token is not null) then
            raise exception 'Generated report versions are recorded by the generator only' using errcode = '42501';
        end if;
        if tg_op in ('UPDATE', 'DELETE') and old.origin = 'generated' then
            raise exception 'A generated report version cannot be changed or deleted' using errcode = '42501';
        end if;
        if tg_op = 'UPDATE' and (new.origin, new.field_values, new.values_token)
                                is distinct from (old.origin, old.field_values, old.values_token) then
            raise exception 'A report version cannot become a generated one' using errcode = '42501';
        end if;
        return coalesce(new, old);
    end if;
    -- report_files / report_annexures
    if exists (select 1 from public.reports r
                where r.origin = 'generated'
                  and r.id in (case when tg_op <> 'INSERT' then old.report_id end,
                               case when tg_op <> 'DELETE' then new.report_id end)) then
        raise exception 'Files and photos of a generated report version cannot be changed' using errcode = '42501';
    end if;
    return coalesce(new, old);
end $$;
revoke all on function private.generated_reports_guard() from public, anon;
create trigger trg_reports_generated_guard before insert or update or delete on public.reports
    for each row execute function private.generated_reports_guard();
create trigger trg_report_files_generated_guard before insert or update or delete on public.report_files
    for each row execute function private.generated_reports_guard();
create trigger trg_report_annexures_generated_guard before insert or update or delete on public.report_annexures
    for each row execute function private.generated_reports_guard();

-- ---------------------------------------------------------------------
-- F. Storage: generated report files at {case_id}/{report_id}/report.{pdf|docx}
-- ---------------------------------------------------------------------
create or replace function private.generated_report_object_case(p_name text) returns uuid
language sql immutable set search_path = '' as $$
    select case when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/report\.(pdf|docx)$'
                then split_part(p_name, '/', 1)::uuid end;
$$;
revoke all on function private.generated_report_object_case(text) from public, anon;
grant execute on function private.generated_report_object_case(text) to authenticated, service_role;

-- 20261115500000 body plus the generated-file scheme for office users on their own cases.
create or replace function private.can_access_report_object(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case private.current_user_role()
    when 'admin' then true
    when 'orchestrator' then true
    when 'office' then
         (split_part(p_name, '/', 1) = 'cases'
          and split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and split_part(p_name, '/', 3) <> ''
          and private.can_manage_case(split_part(p_name, '/', 2)::uuid))
      or coalesce(private.can_manage_case(private.generated_report_object_case(p_name)), false)
      or exists (select 1 from public.reports r where r.storage_path = p_name and private.can_manage_case(r.case_id))
      or exists (select 1 from public.report_files f join public.reports r on r.id = f.report_id
                  where f.storage_path = p_name and private.can_manage_case(r.case_id))
    else false end
$$;

-- Generated files are never overwritten through the API (an upsert is an update); no delete policy as before.
drop policy reports_staff_update on storage.objects;
create policy reports_staff_update on storage.objects for update to authenticated
    using (bucket_id = 'reports' and private.can_access_report_object(name)
           and private.generated_report_object_case(name) is null)
    with check (bucket_id = 'reports' and private.can_access_report_object(name)
                and private.generated_report_object_case(name) is null);
