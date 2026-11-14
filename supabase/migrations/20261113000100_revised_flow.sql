-- =====================================================================
-- Revised workflow (docs/03, docs/09-11; decisions D14-D25), part 2 of 2
--
--   A. app_settings                    tunable numbers (withdraw window, escalation)
--   B. Staff availability              profiles.availability / max_open_cases
--   C. Evidence categories             one taxonomy for checklist, labels, report sections
--   D. Case templates                  insurer x claim type x variant: intake fields,
--                                      report sections, relevant categories, output options
--   E. Case data                       cases.template_id, case_field_values, case_assignments
--   F. Automatic office assignment     rules + auto-assign on insert + reassign by orchestrator
--   G. Case thread                     chat-style messages, read pointers, withdraw,
--                                      evidence posted into the thread (camera/gallery/share)
--   H. Processing pipeline             OCR, labels, field suggestions, job queue
--   I. Field tasks                     create_field_task(), thread events, case status automation
--   J. Reports                         generated files (PDF/Word), annexures, approval, submission guard
--   K. Notifications                   in-app notifications, device tokens, escalation job
--   L. Field app read models           field_case_list(), v_case_checklist, v_evidence_processing
--   M. Row-level security, grants, audit
--
-- Rules kept: evidence rows immutable and never deleted (withdraw hides, D19);
-- server time is trusted; field users see only cases on which they hold a task.
-- Changed: gallery / shared files are accepted without any mark or flag (D18).
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. app_settings
-- ---------------------------------------------------------------------
create table public.app_settings (
    key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
    value       jsonb       not null,
    description text,
    updated_at  timestamptz not null default now()
);
insert into public.app_settings (key, value, description) values
    ('withdraw_window_minutes',       '10', 'How long a sender can withdraw a thread message'),
    ('escalate_unassigned_minutes',   '30', 'Notify orchestrators when a case stays unassigned this long'),
    ('escalate_no_field_task_hours',  '24', 'Notify orchestrators when an assigned case has no field task after this long');

create or replace function private.setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = '' as $$
    select coalesce((select (s.value #>> '{}')::int from public.app_settings s where s.key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------
-- B. Staff availability (used by automatic assignment)
-- ---------------------------------------------------------------------
create type public.staff_availability as enum ('available', 'on_leave', 'unavailable');

alter table public.profiles
    add column availability       public.staff_availability not null default 'available',
    add column availability_until timestamptz,
    add column max_open_cases     int check (max_open_cases between 1 and 500);

-- Self, orchestrator or admin may change availability (profiles writes are admin-only otherwise)
create or replace function public.set_availability(p_user_id uuid, p_availability public.staff_availability,
                                                   p_until timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not (p_user_id = (select auth.uid()) and private.current_user_role() is not null)
       and coalesce(private.current_user_role() not in ('admin', 'orchestrator'), true) then
        raise exception 'Only the user, an orchestrator or an admin can change availability' using errcode = '42501';
    end if;
    update public.profiles
       set availability = p_availability,
           availability_until = case when p_availability = 'available' then null else p_until end
     where id = p_user_id;
    if not found then
        raise exception 'User not found' using errcode = 'P0002';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- C. Evidence categories
-- ---------------------------------------------------------------------
create table public.evidence_categories (
    id                    uuid primary key default gen_random_uuid(),
    code                  text        not null unique check (code ~ '^[a-z][a-z0-9_]{1,48}$'),
    name                  text        not null check (char_length(btrim(name)) between 2 and 100),
    description           text,
    default_evidence_type public.evidence_type not null default 'photo',
    filename_patterns     text[]      not null default '{}',   -- case-insensitive regexes on file names
    text_patterns         text[]      not null default '{}',   -- case-insensitive regexes on OCR text
    is_active             boolean     not null default true,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);
create trigger trg_evidence_categories_updated before update on public.evidence_categories
    for each row execute function public.set_updated_at();

alter table public.checklist_template_items add column category_id uuid references public.evidence_categories(id);
alter table public.task_checklist_items     add column category_id uuid references public.evidence_categories(id);

-- Copy the category with the checklist
create or replace function public.apply_checklist_template(p_task_id uuid, p_template_id uuid)
returns int language sql set search_path = '' as $$
    with ins as (
        insert into public.task_checklist_items
            (task_id, source_template_item_id, position, description,
             required_evidence_type, is_mandatory, camera_only, category_id)
        select p_task_id, i.id, i.position, i.description,
               i.required_evidence_type, i.is_mandatory, i.camera_only, i.category_id
        from public.checklist_template_items i
        where i.template_id = p_template_id
        order by i.position
        returning 1
    )
    select count(*)::int from ins;
$$;

-- Checklist editor save: same contract as 20261112000000 plus optional item "category_id"
create or replace function public.save_checklist_template(
    p_template_id uuid, p_expected_version int, p_name text, p_claim_type public.claim_type,
    p_insurer_id uuid, p_items jsonb)
returns table (id uuid, version int)
language plpgsql security invoker set search_path = '' as $$
declare
    v_id uuid := p_template_id;
    v_version int;
    v_n int;
    v_item jsonb;
    v_ord int;
    v_item_id uuid;
    v_cat uuid;
begin
    if not public.is_admin() then
        raise exception 'Only an active admin can save checklists' using errcode = '42501';
    end if;
    if p_name is null or char_length(btrim(p_name)) not between 2 and 100 then
        raise exception 'Checklist name must be 2-100 characters' using errcode = '22023';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' then
        raise exception 'Items must be a JSON array' using errcode = '22023';
    end if;
    v_n := jsonb_array_length(p_items);
    if v_n not between 1 and 50 then
        raise exception 'A checklist needs 1 to 50 items' using errcode = '22023';
    end if;

    if v_id is null then
        insert into public.checklist_templates (name, claim_type, insurer_id, is_active)
        values (btrim(p_name), p_claim_type, p_insurer_id, false)
        returning checklist_templates.id, checklist_templates.version into v_id, v_version;
    else
        select t.version into v_version from public.checklist_templates t where t.id = v_id for update;
        if not found then
            raise exception 'Checklist not found' using errcode = 'P0002';
        end if;
        if v_version is distinct from p_expected_version then
            raise exception 'This checklist was changed by someone else (version % now, expected %)',
                v_version, p_expected_version using errcode = '40001';
        end if;
        update public.checklist_templates t
           set name = btrim(p_name), claim_type = p_claim_type, insurer_id = p_insurer_id,
               version = t.version + 1
         where t.id = v_id
        returning t.version into v_version;

        delete from public.checklist_template_items i
         where i.template_id = v_id
           and i.id not in (select (e->>'id')::uuid from jsonb_array_elements(p_items) e
                             where e->>'id' is not null);
        update public.checklist_template_items i set position = i.position + 100000
         where i.template_id = v_id;
    end if;

    for v_item, v_ord in select e, o::int from jsonb_array_elements(p_items) with ordinality as x(e, o) loop
        v_item_id := nullif(v_item->>'id', '')::uuid;
        v_cat     := nullif(v_item->>'category_id', '')::uuid;
        if v_item_id is not null then
            update public.checklist_template_items i
               set position = v_ord,
                   description = btrim(v_item->>'description'),
                   required_evidence_type = coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                   is_mandatory = coalesce((v_item->>'is_mandatory')::boolean, true),
                   camera_only = coalesce((v_item->>'camera_only')::boolean, false),
                   category_id = v_cat
             where i.id = v_item_id and i.template_id = v_id;
            if not found then
                raise exception 'Item % does not belong to this checklist', v_item_id using errcode = '22023';
            end if;
        else
            insert into public.checklist_template_items
                (template_id, position, description, required_evidence_type, is_mandatory, camera_only, category_id)
            values (v_id, v_ord, btrim(v_item->>'description'),
                    coalesce((v_item->>'required_evidence_type')::public.evidence_type, 'photo'),
                    coalesce((v_item->>'is_mandatory')::boolean, true),
                    coalesce((v_item->>'camera_only')::boolean, false),
                    v_cat);
        end if;
    end loop;

    return query select v_id, v_version;
end $$;

-- ---------------------------------------------------------------------
-- D. Case templates (insurer x claim type x variant)
-- ---------------------------------------------------------------------
create type public.template_field_type   as enum ('text', 'long_text', 'number', 'currency', 'date', 'datetime',
                                                  'choice', 'multi_choice', 'boolean');
create type public.template_field_source as enum ('intake', 'office');

create table public.case_templates (
    id                    uuid primary key default gen_random_uuid(),
    insurer_id            uuid        not null references public.insurers(id),
    claim_type            public.claim_type not null,
    variant               text        not null default 'general' check (variant ~ '^[a-z][a-z0-9_]{1,30}$'),
    name                  text        not null check (char_length(btrim(name)) between 2 and 120),
    version               int         not null default 1,
    is_active             boolean     not null default false,
    requires_approval     boolean     not null default true,
    output_formats        text[]      not null default '{pdf,docx}'
                          check (cardinality(output_formats) >= 1 and output_formats <@ array['pdf','docx']),
    default_output_format text        not null default 'pdf',
    docx_template_path    text,                                -- report-templates bucket
    intake_rules          jsonb       not null default '{}',   -- subject/body patterns, label aliases
    report_email          jsonb       not null default '{}',   -- to / cc / subject pattern
    source_file           text,                                -- config file it was loaded from
    config_sha256         text check (config_sha256 is null or config_sha256 ~ '^[0-9a-f]{64}$'),
    created_by            uuid        references public.profiles(id),
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (insurer_id, claim_type, variant, version),
    check (default_output_format = any (output_formats))
);
create unique index uq_case_template_active on public.case_templates (insurer_id, claim_type, variant) where is_active;
create trigger trg_case_templates_updated before update on public.case_templates
    for each row execute function public.set_updated_at();

create table public.case_template_sections (
    id          uuid primary key default gen_random_uuid(),
    template_id uuid not null references public.case_templates(id) on delete cascade,
    key         text not null check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
    title       text not null,
    position    int  not null,
    guidance    text,
    unique (template_id, key),
    unique (template_id, position),
    unique (id, template_id)
);

create table public.case_template_fields (
    id          uuid primary key default gen_random_uuid(),
    template_id uuid not null,
    section_id  uuid not null,
    key         text not null check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
    label       text not null,
    field_type  public.template_field_type   not null default 'text',
    source      public.template_field_source not null default 'office',
    is_required boolean not null default false,
    options     jsonb   not null default '[]' check (jsonb_typeof(options) = 'array'),
    extract     jsonb   not null default '{}' check (jsonb_typeof(extract) = 'object'),  -- label aliases / regex / filters
    help_text   text,
    position    int     not null,
    foreign key (section_id, template_id) references public.case_template_sections(id, template_id) on delete cascade,
    unique (template_id, key),
    unique (section_id, position)
);

create table public.case_template_section_categories (
    section_id  uuid not null references public.case_template_sections(id) on delete cascade,
    category_id uuid not null references public.evidence_categories(id),
    position    int  not null default 1,
    primary key (section_id, category_id)
);

create table public.case_template_checklists (
    template_id           uuid    not null references public.case_templates(id) on delete cascade,
    checklist_template_id uuid    not null references public.checklist_templates(id),
    is_default            boolean not null default false,
    primary key (template_id, checklist_template_id)
);

-- Upsert evidence categories from config: [{code, name, description, default_evidence_type,
-- filename_patterns[], text_patterns[], is_active}]
create or replace function public.load_evidence_categories(p_categories jsonb) returns int
language plpgsql security invoker set search_path = '' as $$
declare v jsonb; v_n int := 0;
begin
    if not (public.is_admin() or private.is_archive_writer()) then
        raise exception 'Only an admin can load categories' using errcode = '42501';
    end if;
    if jsonb_typeof(p_categories) <> 'array' then
        raise exception 'Categories must be a JSON array' using errcode = '22023';
    end if;
    for v in select * from jsonb_array_elements(p_categories) loop
        insert into public.evidence_categories (code, name, description, default_evidence_type,
                                                filename_patterns, text_patterns, is_active)
        values (v->>'code', v->>'name', v->>'description',
                coalesce((v->>'default_evidence_type')::public.evidence_type, 'photo'),
                coalesce(array(select jsonb_array_elements_text(v->'filename_patterns')), '{}'),
                coalesce(array(select jsonb_array_elements_text(v->'text_patterns')), '{}'),
                coalesce((v->>'is_active')::boolean, true))
        on conflict (code) do update
           set name = excluded.name, description = excluded.description,
               default_evidence_type = excluded.default_evidence_type,
               filename_patterns = excluded.filename_patterns, text_patterns = excluded.text_patterns,
               is_active = excluded.is_active;
        v_n := v_n + 1;
    end loop;
    return v_n;
end $$;

-- Load one template from config (JSON form of config/templates/*.yaml). Creates a new version
-- unless the identical config is already loaded; cases keep the version they started with.
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
                                       docx_template_path, intake_rules, report_email,
                                       source_file, config_sha256, created_by)
    values (v_insurer, v_claim, v_variant, p_config->>'name', v_version, false,
            coalesce((p_config->>'requires_approval')::boolean, true), v_formats,
            coalesce(p_config->>'default_output_format', v_formats[1]),
            p_config->>'docx_template_path', coalesce(p_config->'intake_rules', '{}'),
            coalesce(p_config->'report_email', '{}'), p_source_file, v_sha, (select auth.uid()))
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

-- ---------------------------------------------------------------------
-- E. Case data
-- ---------------------------------------------------------------------
alter table public.cases
    add column template_id        uuid references public.case_templates(id),
    add column assignment_method  text check (assignment_method in ('auto', 'manual')),
    add column office_assigned_at timestamptz;

create type public.field_value_source as enum ('email_parser', 'llm', 'office', 'suggestion');

create table public.case_field_values (
    id                 uuid primary key default gen_random_uuid(),
    case_id            uuid not null references public.cases(id) on delete cascade,
    field_id           uuid not null references public.case_template_fields(id),
    value              text,
    source             public.field_value_source not null default 'office',
    source_evidence_id uuid references public.evidence(id),
    source_ref         jsonb,                                  -- {ocr_id, page_no, block_index}
    confidence         real check (confidence between 0 and 1),
    updated_by         uuid references public.profiles(id),
    updated_at         timestamptz not null default now(),
    unique (case_id, field_id)
);

create or replace function private.case_field_values_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if not exists (select 1 from public.cases c join public.case_template_fields f on f.template_id = c.template_id
                    where c.id = new.case_id and f.id = new.field_id) then
        raise exception 'Field does not belong to the case template' using errcode = '23514';
    end if;
    if new.source_evidence_id is not null and not exists (
        select 1 from public.evidence e where e.id = new.source_evidence_id and e.case_id = new.case_id) then
        raise exception 'Source evidence does not belong to the case' using errcode = '23514';
    end if;
    new.updated_by := coalesce((select auth.uid()), new.updated_by);
    new.updated_at := now();
    return new;
end $$;
create trigger trg_case_field_values_validate before insert or update on public.case_field_values
    for each row execute function private.case_field_values_validate();

create table public.case_assignments (
    id          bigint generated always as identity primary key,
    case_id     uuid        not null references public.cases(id) on delete cascade,
    assignee_id uuid        not null references public.profiles(id),
    method      text        not null check (method in ('auto', 'manual')),
    assigned_by uuid        references public.profiles(id),
    reason      text,
    assigned_at timestamptz not null default now()
);
create index ix_case_assignments_case     on public.case_assignments (case_id, assigned_at);
create index ix_case_assignments_assignee on public.case_assignments (assignee_id, assigned_at);

-- ---------------------------------------------------------------------
-- G1. Case thread tables (needed by F for system messages)
-- ---------------------------------------------------------------------
create type public.message_kind as enum ('text', 'media', 'voice', 'system', 'request');

create table public.case_messages (
    id                uuid primary key default gen_random_uuid(),
    case_id           uuid not null references public.cases(id),
    sender_id         uuid references public.profiles(id),
    kind              public.message_kind not null,
    body              text check (char_length(body) <= 4000),
    task_id           uuid references public.tasks(id),
    reply_to_id       uuid references public.case_messages(id),
    client_message_id uuid unique,                             -- offline idempotency key from the app
    created_at        timestamptz not null default now(),
    withdrawn_at      timestamptz,
    withdrawn_by      uuid references public.profiles(id),
    check (kind = 'system' or sender_id is not null)
);
create index ix_case_messages_case on public.case_messages (case_id, created_at);

create table public.case_thread_reads (
    case_id      uuid        not null references public.cases(id) on delete cascade,
    user_id      uuid        not null references public.profiles(id) on delete cascade,
    last_read_at timestamptz not null default now(),
    primary key (case_id, user_id)
);

create or replace function private.post_system_message(p_case_id uuid, p_body text, p_task_id uuid default null,
                                                       p_kind public.message_kind default 'system',
                                                       p_sender uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    perform set_config('app.system_message', 'on', true);
    insert into public.case_messages (case_id, sender_id, kind, body, task_id)
    values (p_case_id, case when p_kind = 'system' then null else p_sender end,
            case when p_kind <> 'system' and p_sender is null then 'system' else p_kind end,
            p_body, p_task_id)
    returning id into v_id;
    perform set_config('app.system_message', 'off', true);
    return v_id;
end $$;

-- ---------------------------------------------------------------------
-- K1. Notifications (needed by F)
-- ---------------------------------------------------------------------
create table public.notifications (
    id         bigint generated always as identity primary key,
    user_id    uuid        not null references public.profiles(id) on delete cascade,
    kind       text        not null,
    case_id    uuid        references public.cases(id) on delete cascade,
    title      text        not null,
    body       text,
    dedupe_key text,
    created_at timestamptz not null default now(),
    read_at    timestamptz
);
create index ix_notifications_user on public.notifications (user_id, created_at desc);
create unique index uq_notifications_open_dedupe on public.notifications (user_id, dedupe_key)
    where dedupe_key is not null and read_at is null;

create table public.device_tokens (
    token      text primary key,
    user_id    uuid        not null default auth.uid() references public.profiles(id) on delete cascade,
    platform   text        not null default 'android' check (platform in ('android', 'ios', 'web')),
    updated_at timestamptz not null default now()
);

create or replace function private.notify(p_user uuid, p_kind text, p_case uuid, p_title text,
                                          p_body text default null, p_dedupe text default null) returns void
language sql security definer set search_path = '' as $$
    insert into public.notifications (user_id, kind, case_id, title, body, dedupe_key)
    values (p_user, p_kind, p_case, p_title, p_body, p_dedupe)
    on conflict (user_id, dedupe_key) where dedupe_key is not null and read_at is null do nothing;
$$;

create or replace function private.notify_orchestrators(p_kind text, p_case uuid, p_title text,
                                                        p_body text default null, p_dedupe text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_n int := 0;
begin
    for r in select p.id from public.profiles p where p.is_active and p.role = 'orchestrator' loop
        perform private.notify(r.id, p_kind, p_case, p_title, p_body, p_dedupe);
        v_n := v_n + 1;
    end loop;
    if v_n = 0 then   -- no orchestrator configured: admins get it
        for r in select p.id from public.profiles p where p.is_active and p.role = 'admin' loop
            perform private.notify(r.id, p_kind, p_case, p_title, p_body, p_dedupe);
            v_n := v_n + 1;
        end loop;
    end if;
    return v_n;
end $$;

-- ---------------------------------------------------------------------
-- F. Automatic office assignment
-- ---------------------------------------------------------------------
create type public.assignment_strategy as enum ('least_loaded', 'round_robin');

create table public.assignment_rules (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(btrim(name)) between 2 and 100),
    insurer_id  uuid references public.insurers(id),           -- null = any insurer
    claim_type  public.claim_type,                             -- null = any claim type
    strategy    public.assignment_strategy not null default 'least_loaded',
    priority    int  not null default 100,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create trigger trg_assignment_rules_updated before update on public.assignment_rules
    for each row execute function public.set_updated_at();

create table public.assignment_rule_members (
    rule_id    uuid not null references public.assignment_rules(id) on delete cascade,
    profile_id uuid not null references public.profiles(id) on delete cascade,
    primary key (rule_id, profile_id)
);

-- Eligible: active staff, available (or leave already ended), under their case cap
create or replace function private.is_assignable(p_profile uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from public.profiles p
         where p.id = p_profile and p.is_active and p.role in ('office', 'orchestrator', 'admin')
           and (p.availability = 'available'
                or (p.availability_until is not null and p.availability_until <= now()))
           and (p.max_open_cases is null or p.max_open_cases > (
                select count(*) from public.cases c
                 where c.office_owner_id = p.id and c.status not in ('submitted', 'closed', 'cancelled'))));
$$;

create or replace function private.pick_office_assignee(p_case_id uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
    v_case public.cases;
    r record;
    v_pick uuid;
begin
    select * into v_case from public.cases where id = p_case_id;
    for r in select ar.id, ar.strategy from public.assignment_rules ar
              where ar.is_active
                and (ar.insurer_id is null or ar.insurer_id = v_case.insurer_id)
                and (ar.claim_type is null or ar.claim_type = v_case.claim_type)
              order by (ar.insurer_id is not null) desc, (ar.claim_type is not null) desc, ar.priority, ar.name
    loop
        select m.profile_id into v_pick
          from public.assignment_rule_members m
          left join lateral (select count(*) as open_cases from public.cases c
                              where c.office_owner_id = m.profile_id
                                and c.status not in ('submitted', 'closed', 'cancelled')) l on true
          left join lateral (select max(a.assigned_at) as last_at from public.case_assignments a
                              where a.assignee_id = m.profile_id) h on true
         where m.rule_id = r.id and private.is_assignable(m.profile_id)
         order by case when r.strategy = 'least_loaded' then l.open_cases end nulls last,
                  h.last_at nulls first, m.profile_id
         limit 1;
        if v_pick is not null then
            return v_pick;
        end if;
    end loop;
    -- fallback pool: every assignable office user, least loaded
    select p.id into v_pick
      from public.profiles p
      left join lateral (select count(*) as open_cases from public.cases c
                          where c.office_owner_id = p.id and c.status not in ('submitted', 'closed', 'cancelled')) l on true
      left join lateral (select max(a.assigned_at) as last_at from public.case_assignments a
                          where a.assignee_id = p.id) h on true
     where p.role = 'office' and private.is_assignable(p.id)
     order by l.open_cases, h.last_at nulls first, p.id
     limit 1;
    return v_pick;
end $$;

create or replace function private.assign_case(p_case_id uuid, p_assignee uuid, p_method text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
    perform set_config('app.assigning', p_case_id::text, true);
    update public.cases c
       set office_owner_id = p_assignee,
           assignment_method = p_method,
           office_assigned_at = now(),
           status = case when c.status in ('received', 'intake_confirmed') then 'assigned'::public.case_status else c.status end
     where c.id = p_case_id;
    perform set_config('app.assigning', '', true);
    insert into public.case_assignments (case_id, assignee_id, method, assigned_by, reason)
    values (p_case_id, p_assignee, p_method, (select auth.uid()), p_reason);
    select full_name into v_name from public.profiles where id = p_assignee;
    perform private.post_system_message(p_case_id,
        case when p_method = 'auto' then 'Case assigned automatically to ' else 'Case reassigned to ' end
        || coalesce(v_name, 'staff') || coalesce(' — ' || nullif(p_reason, 'Automatic assignment'), ''));
    perform private.notify(p_assignee, 'case_assigned', p_case_id, 'New case assigned to you', p_reason,
                           'case_assigned:' || p_case_id);
end $$;

create or replace function private.auto_assign_case(p_case_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_pick uuid; v_ref text;
begin
    v_pick := private.pick_office_assignee(p_case_id);
    if v_pick is null then
        select case_ref into v_ref from public.cases where id = p_case_id;
        perform private.notify_orchestrators('case_unassigned', p_case_id,
            'No one available to take case ' || coalesce(v_ref, ''),
            'Assign it manually or update availability / assignment rules.', 'unassigned:' || p_case_id);
        return null;
    end if;
    perform private.assign_case(p_case_id, v_pick, 'auto', 'Automatic assignment');
    return v_pick;
end $$;

create or replace function private.cases_after_insert_assign() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if new.office_owner_id is null then
        if new.status in ('received', 'intake_confirmed') then
            perform private.auto_assign_case(new.id);
        end if;
    else
        insert into public.case_assignments (case_id, assignee_id, method, assigned_by, reason)
        values (new.id, new.office_owner_id, 'manual', (select auth.uid()), 'Assigned at creation');
    end if;
    return null;
end $$;
create trigger trg_cases_after_insert_assign after insert on public.cases
    for each row execute function private.cases_after_insert_assign();

-- Office owner changes only through assign_case (history + notifications) or by system jobs
-- security invoker on purpose: is_archive_writer() must see the real current_user
create or replace function private.cases_owner_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if (new.office_owner_id, new.assignment_method, new.office_assigned_at)
       is distinct from (old.office_owner_id, old.assignment_method, old.office_assigned_at)
       and coalesce(current_setting('app.assigning', true), '') <> new.id::text
       and not private.is_archive_writer() then
        raise exception 'Use reassign_case() to change the assigned office employee' using errcode = '42501';
    end if;
    return new;
end $$;
create trigger trg_cases_owner_guard before update on public.cases
    for each row execute function private.cases_owner_guard();

create or replace function public.reassign_case(p_case_id uuid, p_assignee_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
        raise exception 'Only an orchestrator or admin can reassign cases' using errcode = '42501';
    end if;
    if p_reason is null or char_length(btrim(p_reason)) < 3 then
        raise exception 'A reason is required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.is_active
                     and p.role in ('office', 'orchestrator', 'admin')) then
        raise exception 'Assignee must be an active office, orchestrator or admin user' using errcode = '22023';
    end if;
    if not exists (select 1 from public.cases c where c.id = p_case_id) then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    perform private.assign_case(p_case_id, p_assignee_id, 'manual', btrim(p_reason));
end $$;

create or replace function public.retry_auto_assign(p_case_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
    if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
        raise exception 'Only an orchestrator or admin can run assignment' using errcode = '42501';
    end if;
    return private.auto_assign_case(p_case_id);
end $$;

-- ---------------------------------------------------------------------
-- G2. Evidence posted into the thread
-- ---------------------------------------------------------------------
create type public.evidence_relevance as enum ('unreviewed', 'relevant', 'not_relevant');

alter table public.evidence
    add column message_id          uuid references public.case_messages(id),
    add column email_attachment_id uuid references public.email_attachments(id),
    add column original_filename   text,
    add column exif                jsonb not null default '{}',
    add column withdrawn_at        timestamptz,
    add column withdrawn_by        uuid references public.profiles(id),
    add column relevance           public.evidence_relevance not null default 'unreviewed',
    add column relevance_by        uuid references public.profiles(id),
    add column relevance_at        timestamptz;
alter table public.evidence alter column captured_by drop not null;
alter table public.evidence
    add constraint evidence_captured_by_required check (captured_by is not null or capture_source = 'email_attachment'),
    add constraint evidence_email_attachment_link check (capture_source <> 'email_attachment' or email_attachment_id is not null);
create index ix_evidence_message on public.evidence (message_id);

-- Immutability: core fields frozen; withdraw (set once, via withdraw_message), relevance (staff),
-- flag (staff), archive fields (archive job, set once)
create or replace function public.evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
    c_mutable constant text[] := array['is_flagged','flag_reason','checklist_item_id',
        'archived_at','archive_location','archive_sha256_verified','cloud_purged_at',
        'withdrawn_at','withdrawn_by','relevance','relevance_by','relevance_at'];
begin
    if tg_op = 'DELETE' then
        raise exception 'Evidence records cannot be deleted' using errcode = '42501';
    end if;
    if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable) then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    if new.checklist_item_id is distinct from old.checklist_item_id and new.checklist_item_id is not null then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    if (new.archived_at, new.archive_location, new.archive_sha256_verified, new.cloud_purged_at)
       is distinct from
       (old.archived_at, old.archive_location, old.archive_sha256_verified, old.cloud_purged_at) then
        if not private.is_archive_writer() then
            raise exception 'Evidence archive fields are written by the archive job only' using errcode = '42501';
        end if;
        if (old.archived_at             is not null and new.archived_at             is distinct from old.archived_at)
        or (old.archive_location        is not null and new.archive_location        is distinct from old.archive_location)
        or (old.archive_sha256_verified is not null and new.archive_sha256_verified is distinct from old.archive_sha256_verified)
        or (old.cloud_purged_at         is not null and new.cloud_purged_at         is distinct from old.cloud_purged_at) then
            raise exception 'Evidence archive fields can be set only once' using errcode = '42501';
        end if;
    end if;
    if (new.withdrawn_at, new.withdrawn_by) is distinct from (old.withdrawn_at, old.withdrawn_by) then
        if old.withdrawn_at is not null then
            raise exception 'Evidence can be withdrawn only once' using errcode = '42501';
        end if;
        if coalesce(current_setting('app.withdrawing', true), '') <> 'on' and not private.is_archive_writer() then
            raise exception 'Use withdraw_message() to withdraw evidence' using errcode = '42501';
        end if;
    end if;
    if (new.relevance, new.relevance_by, new.relevance_at) is distinct from (old.relevance, old.relevance_by, old.relevance_at) then
        if not (public.is_staff() or private.is_archive_writer()) then
            raise exception 'Only office staff can mark relevance' using errcode = '42501';
        end if;
        new.relevance_by := (select auth.uid());
        new.relevance_at := now();
    end if;
    return new;
end $$;

-- Gallery / shared files are accepted without a mark (D18): only server time is set here
create or replace function public.evidence_autoflag() returns trigger
language plpgsql set search_path = '' as $$
begin
    new.server_received_at := now();
    new.created_at         := now();
    new.withdrawn_at       := null;
    new.withdrawn_by       := null;
    new.relevance          := 'unreviewed';
    new.relevance_by       := null;
    new.relevance_at       := null;
    return new;
end $$;

create or replace function public.evidence_validate() returns trigger
language plpgsql set search_path = '' as $$
declare v_task_case uuid; v_item_task uuid; v_msg record;
begin
    if new.task_id is not null then
        select t.case_id into v_task_case from public.tasks t where t.id = new.task_id;
        if v_task_case is distinct from new.case_id then
            raise exception 'Evidence task does not belong to the case' using errcode = '23514';
        end if;
    end if;
    if new.checklist_item_id is not null then
        select c.task_id into v_item_task from public.task_checklist_items c where c.id = new.checklist_item_id;
        if new.task_id is null or v_item_task is distinct from new.task_id then
            raise exception 'Evidence checklist item does not belong to the task' using errcode = '23514';
        end if;
    end if;
    if new.message_id is not null then
        select m.case_id, m.sender_id into v_msg from public.case_messages m where m.id = new.message_id;
        if v_msg.case_id is distinct from new.case_id or v_msg.sender_id is distinct from new.captured_by then
            raise exception 'Evidence message must be in the same case and sent by the uploader' using errcode = '23514';
        end if;
    end if;
    -- Storage path conventions (R2): task evidence and case-level staff files
    if new.storage_path is not null and new.storage_backend = 'r2' then
        if new.task_id is not null and new.capture_source in ('camera', 'gallery', 'share', 'web_upload')
           and new.storage_path !~ ('^cases/' || new.case_id::text || '/tasks/' || new.task_id::text
                                    || '/' || new.sha256 || '\.[a-z0-9]{1,8}$') then
            raise exception 'Evidence storage_path must be cases/{case_id}/tasks/{task_id}/{sha256}.{ext}'
                using errcode = '23514';
        end if;
        if new.task_id is null and new.capture_source in ('camera', 'gallery', 'share', 'web_upload')
           and new.storage_path !~ ('^cases/' || new.case_id::text || '/files/' || new.sha256 || '\.[a-z0-9]{1,8}$') then
            raise exception 'Case-level evidence storage_path must be cases/{case_id}/files/{sha256}.{ext}'
                using errcode = '23514';
        end if;
    end if;
    return new;
end $$;

-- Staff upload of a case-level file (not tied to a field task), for the R2 presigner
create or replace function public.can_upload_case_file(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(public.is_staff() and exists (select 1 from public.cases c where c.id = p_case_id), false);
$$;

-- Thread guards
-- security invoker on purpose: is_archive_writer() must see the real current_user
create or replace function private.case_messages_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Messages cannot be deleted; withdraw instead' using errcode = '42501';
    elsif tg_op = 'INSERT' then
        if new.kind = 'system' and coalesce(current_setting('app.system_message', true), '') <> 'on'
           and not private.is_archive_writer() then
            raise exception 'System messages are written by the system only' using errcode = '42501';
        end if;
        if new.task_id is not null and not exists (select 1 from public.tasks t where t.id = new.task_id and t.case_id = new.case_id) then
            raise exception 'Message task does not belong to the case' using errcode = '23514';
        end if;
        if new.reply_to_id is not null and not exists (select 1 from public.case_messages m where m.id = new.reply_to_id and m.case_id = new.case_id) then
            raise exception 'Reply must be in the same case' using errcode = '23514';
        end if;
        new.created_at   := now();
        new.withdrawn_at := null;
        new.withdrawn_by := null;
    else
        if (to_jsonb(new) - array['withdrawn_at','withdrawn_by','body'])
           is distinct from (to_jsonb(old) - array['withdrawn_at','withdrawn_by','body'])
           or old.withdrawn_at is not null
           or (coalesce(current_setting('app.withdrawing', true), '') <> 'on' and not private.is_archive_writer()) then
            raise exception 'Messages cannot be edited' using errcode = '42501';
        end if;
    end if;
    return coalesce(new, old);
end $$;
create trigger trg_case_messages_guard before insert or update or delete on public.case_messages
    for each row execute function private.case_messages_guard();

-- Field user may post while they hold a non-cancelled task and the case is open
create or replace function private.field_can_post(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.tasks t join public.cases c on c.id = t.case_id
                    where t.case_id = p_case_id and t.assignee_id = (select auth.uid())
                      and t.status <> 'cancelled' and c.status not in ('closed', 'cancelled'));
$$;

-- ---------------------------------------------------------------------
-- H. Processing pipeline
-- ---------------------------------------------------------------------
create type public.label_source      as enum ('operator', 'filename_rule', 'text_rule', 'model', 'llm', 'human');
create type public.suggestion_status as enum ('pending', 'accepted', 'rejected');
create type public.processing_stage  as enum ('text_extract', 'ocr', 'label', 'field_suggest');  -- order = run order
create type public.job_status        as enum ('queued', 'running', 'done', 'failed', 'skipped');

create table public.evidence_ocr (
    id              uuid primary key default gen_random_uuid(),
    evidence_id     uuid not null references public.evidence(id),
    page_no         int  not null default 1 check (page_no >= 1),
    engine          text not null,                             -- e.g. mlkit_device, pdf_text_layer, paddleocr
    engine_version  text,
    lang            text,
    text            text not null,
    blocks          jsonb not null default '[]' check (jsonb_typeof(blocks) = 'array'),  -- [{text, bbox:[x,y,w,h], conf}]
    mean_confidence real check (mean_confidence between 0 and 1),
    is_current      boolean not null default true,
    created_by      uuid default auth.uid() references public.profiles(id),
    created_at      timestamptz not null default now()
);
create unique index uq_evidence_ocr_current on public.evidence_ocr (evidence_id, page_no) where is_current;

create or replace function private.evidence_ocr_supersede() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if new.is_current then
        update public.evidence_ocr o set is_current = false
         where o.evidence_id = new.evidence_id and o.page_no = new.page_no and o.is_current;
    end if;
    new.created_at := now();
    return new;
end $$;
create trigger trg_evidence_ocr_supersede before insert on public.evidence_ocr
    for each row execute function private.evidence_ocr_supersede();

create table public.evidence_labels (
    id               uuid primary key default gen_random_uuid(),
    evidence_id      uuid not null references public.evidence(id),
    category_id      uuid not null references public.evidence_categories(id),
    confidence       real check (confidence between 0 and 1),
    source           public.label_source not null,
    pipeline_version text,
    is_active        boolean not null default true,
    created_by       uuid default auth.uid() references public.profiles(id),
    created_at       timestamptz not null default now()
);
create index ix_evidence_labels_active on public.evidence_labels (evidence_id) where is_active;
create unique index uq_evidence_labels_active on public.evidence_labels (evidence_id, category_id, source) where is_active;

create or replace function private.evidence_labels_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        new.created_at := now();
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
create trigger trg_evidence_labels_guard before insert or update on public.evidence_labels
    for each row execute function private.evidence_labels_guard();

-- Office correction: replaces the active labels with human labels (old rows kept as training data)
create or replace function public.set_evidence_labels(p_evidence_id uuid, p_category_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
    if not public.is_staff() then
        raise exception 'Only office staff can correct labels' using errcode = '42501';
    end if;
    if not exists (select 1 from public.evidence e where e.id = p_evidence_id) then
        raise exception 'Evidence not found' using errcode = 'P0002';
    end if;
    update public.evidence_labels l set is_active = false where l.evidence_id = p_evidence_id and l.is_active;
    insert into public.evidence_labels (evidence_id, category_id, confidence, source, created_by)
    select p_evidence_id, c, 1, 'human', (select auth.uid()) from unnest(coalesce(p_category_ids, '{}')) c;
end $$;

create table public.field_suggestions (
    id          uuid primary key default gen_random_uuid(),
    evidence_id uuid not null references public.evidence(id),
    ocr_id      uuid references public.evidence_ocr(id),
    field_id    uuid not null references public.case_template_fields(id),
    value       text not null,
    confidence  real check (confidence between 0 and 1),
    block_index int,
    source      public.label_source not null default 'text_rule',
    status      public.suggestion_status not null default 'pending',
    decided_by  uuid references public.profiles(id),
    decided_at  timestamptz,
    created_at  timestamptz not null default now()
);
create index ix_field_suggestions_evidence on public.field_suggestions (evidence_id);

create table public.processing_jobs (
    id               bigint generated always as identity primary key,
    evidence_id      uuid not null references public.evidence(id),
    stage            public.processing_stage not null,
    status           public.job_status not null default 'queued',
    attempts         int  not null default 0,
    max_attempts     int  not null default 5,
    pipeline_version text not null default 'v1',
    run_after        timestamptz not null default now(),
    locked_at        timestamptz,
    locked_by        text,
    last_error       text,
    started_at       timestamptz,
    finished_at      timestamptz,
    created_at       timestamptz not null default now(),
    unique (evidence_id, stage, pipeline_version)
);
create index ix_processing_jobs_queue on public.processing_jobs (run_after) where status = 'queued';

create or replace function private.enqueue_evidence_processing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_stages public.processing_stage[];
begin
    v_stages := case new.evidence_type
        when 'photo'    then array['ocr', 'label', 'field_suggest']::public.processing_stage[]
        when 'document' then array['text_extract', 'ocr', 'label', 'field_suggest']::public.processing_stage[]
        when 'audio'    then array['label']::public.processing_stage[]
        when 'video'    then array['label']::public.processing_stage[]
        else '{}'::public.processing_stage[] end;
    insert into public.processing_jobs (evidence_id, stage)
    select new.id, s from unnest(v_stages) s;
    return null;
end $$;
create trigger trg_evidence_enqueue after insert on public.evidence
    for each row execute function private.enqueue_evidence_processing();

-- Worker API (service role only). A stage is claimable once earlier stages of the same
-- evidence and pipeline version are no longer queued or running.
create or replace function public.claim_processing_jobs(p_stages public.processing_stage[], p_limit int, p_worker text)
returns setof public.processing_jobs
language sql security definer set search_path = '' as $$
    with c as (
        select j.id from public.processing_jobs j
         where j.status = 'queued' and j.run_after <= now() and j.stage = any (p_stages)
           and not exists (select 1 from public.processing_jobs p
                            where p.evidence_id = j.evidence_id and p.pipeline_version = j.pipeline_version
                              and p.stage < j.stage and p.status in ('queued', 'running'))
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

create or replace function public.complete_processing_job(p_job_id bigint, p_status public.job_status,
                                                          p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.processing_jobs;
begin
    select * into v from public.processing_jobs where id = p_job_id for update;
    if not found or v.status <> 'running' then
        raise exception 'Job % is not running', p_job_id using errcode = '22023';
    end if;
    if p_status = 'failed' and v.attempts < v.max_attempts then
        update public.processing_jobs
           set status = 'queued', last_error = p_error, locked_at = null, locked_by = null,
               run_after = now() + make_interval(mins => power(2, v.attempts)::int)
         where id = p_job_id;
    elsif p_status in ('done', 'failed', 'skipped') then
        update public.processing_jobs
           set status = p_status, last_error = p_error, finished_at = now(), locked_at = null
         where id = p_job_id;
    else
        raise exception 'Final status must be done, failed or skipped' using errcode = '22023';
    end if;
end $$;

-- Re-run stages with a new pipeline version (e.g. after improving the labeller)
create or replace function public.enqueue_reprocessing(p_evidence_ids uuid[], p_stages public.processing_stage[],
                                                       p_pipeline_version text) returns int
language sql security definer set search_path = '' as $$
    with ins as (
        insert into public.processing_jobs (evidence_id, stage, pipeline_version)
        select e, s, p_pipeline_version from unnest(p_evidence_ids) e, unnest(p_stages) s
        on conflict (evidence_id, stage, pipeline_version) do nothing
        returning 1)
    select count(*)::int from ins;
$$;

-- ---------------------------------------------------------------------
-- G3. Posting to and withdrawing from the thread
-- ---------------------------------------------------------------------
-- p_items: [{evidence_type, capture_source, storage_path, sha256, mime_type, size_bytes,
--            original_filename, device_captured_at, latitude, longitude, gps_accuracy_m,
--            device_info{}, exif{}, checklist_item_id, category_code, ocr:{engine, engine_version,
--            lang, text, blocks[], mean_confidence, page_no}}]
-- Runs as the caller: RLS decides what may be written. Idempotent on p_client_message_id.
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

    if p_kind in ('media', 'voice') and public.is_field() and v_task is null then
        select t.id into v_task from public.tasks t
         where t.case_id = p_case_id and t.assignee_id = v_uid and t.status in ('pending', 'in_progress')
         order by t.created_at desc limit 1;
        if v_task is null then
            raise exception 'You have no open task on this case' using errcode = '42501';
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

create or replace function public.withdraw_message(p_message_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.case_messages;
begin
    select * into v from public.case_messages m where m.id = p_message_id for update;
    if not found or v.sender_id is distinct from (select auth.uid()) or private.current_user_role() is null then
        raise exception 'Only the sender can withdraw a message' using errcode = '42501';
    end if;
    if v.withdrawn_at is not null then
        return;
    end if;
    if v.created_at < now() - make_interval(mins => private.setting_int('withdraw_window_minutes', 10)) then
        raise exception 'The withdraw window has passed' using errcode = '42501';
    end if;
    perform set_config('app.withdrawing', 'on', true);
    update public.case_messages set withdrawn_at = now(), withdrawn_by = v.sender_id, body = null where id = v.id;
    update public.evidence set withdrawn_at = now(), withdrawn_by = v.sender_id where message_id = v.id;
    perform set_config('app.withdrawing', 'off', true);
end $$;

create or replace function public.mark_thread_read(p_case_id uuid) returns void
language sql security invoker set search_path = '' as $$
    insert into public.case_thread_reads (case_id, user_id, last_read_at)
    values (p_case_id, (select auth.uid()), now())
    on conflict (case_id, user_id) do update set last_read_at = excluded.last_read_at;
$$;

-- Read state of a thread for ticks: last time office staff / field users read it
create or replace function public.case_thread_state(p_case_id uuid)
returns table (staff_last_read_at timestamptz, field_last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
    select max(r.last_read_at) filter (where p.role in ('admin', 'orchestrator', 'office')),
           max(r.last_read_at) filter (where p.role = 'field')
      from public.case_thread_reads r join public.profiles p on p.id = r.user_id
     where r.case_id = p_case_id
       and (public.is_staff() or (public.is_field() and private.field_can_see_case(p_case_id)));
$$;

-- ---------------------------------------------------------------------
-- I. Field tasks and case status automation
-- ---------------------------------------------------------------------
create or replace function public.create_field_task(
    p_case_id uuid, p_assignee_id uuid, p_title text, p_instructions text default null,
    p_checklist_template_id uuid default null, p_kind public.task_kind default 'initial',
    p_due_at timestamptz default null, p_location_text text default null, p_parent_task_id uuid default null)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_task uuid;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can assign field work' using errcode = '42501';
    end if;
    if not exists (select 1 from public.profiles p where p.id = p_assignee_id and p.is_active and p.role = 'field') then
        raise exception 'Assignee must be an active field operator' using errcode = '22023';
    end if;
    if p_title is null or char_length(btrim(p_title)) < 3 then
        raise exception 'A task title is required' using errcode = '22023';
    end if;
    insert into public.tasks (case_id, kind, parent_task_id, title, instructions, assignee_id, due_at,
                              location_text, created_by)
    values (p_case_id, p_kind, p_parent_task_id, btrim(p_title), p_instructions, p_assignee_id, p_due_at,
            p_location_text, (select auth.uid()))
    returning id into v_task;
    if p_checklist_template_id is not null then
        perform public.apply_checklist_template(v_task, p_checklist_template_id);
    end if;
    return v_task;
end $$;

create or replace function private.tasks_after_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_case public.cases; v_name text; v_open int;
begin
    select * into v_case from public.cases where id = new.case_id;
    select full_name into v_name from public.profiles where id = new.assignee_id;
    if tg_op = 'INSERT' then
        perform private.post_system_message(new.case_id,
            case when new.kind = 're_investigation' then coalesce(new.instructions, new.title)
                 else 'Field work assigned to ' || coalesce(v_name, 'operator') || ': ' || new.title end,
            new.id,
            case when new.kind = 're_investigation' then 'request'::public.message_kind else 'system'::public.message_kind end,
            (select auth.uid()));
        if new.assignee_id is not null then
            perform private.notify(new.assignee_id,
                case when new.kind = 're_investigation' then 'field_request' else 'task_assigned' end,
                new.case_id, coalesce(v_case.case_ref, '') || ': ' || new.title, new.instructions, 'task:' || new.id);
        end if;
        if new.status in ('pending', 'in_progress')
           and v_case.status in ('received', 'intake_confirmed', 'assigned', 'office_review', 'orchestrator_review') then
            update public.cases set status = 'field_in_progress' where id = new.case_id;
        end if;
    elsif new.status is distinct from old.status and new.status in ('completed', 'cancelled') then
        if new.status = 'completed' then
            perform private.post_system_message(new.case_id,
                coalesce(v_name, 'Operator') || ' marked field work complete: ' || new.title, new.id);
            if v_case.office_owner_id is not null then
                perform private.notify(v_case.office_owner_id, 'task_completed', new.case_id,
                    coalesce(v_case.case_ref, '') || ': field work complete', new.title, 'task_done:' || new.id);
            end if;
        end if;
        select count(*) into v_open from public.tasks t
         where t.case_id = new.case_id and t.status in ('pending', 'in_progress');
        if v_open = 0 and v_case.status = 'field_in_progress' then
            update public.cases set status = 'office_review' where id = new.case_id;
        end if;
    end if;
    return null;
end $$;
create trigger trg_tasks_after_change after insert or update of status on public.tasks
    for each row execute function private.tasks_after_change();

-- ---------------------------------------------------------------------
-- J. Reports: generated files, annexures, approval, submission
-- ---------------------------------------------------------------------
alter table public.reports
    add column origin           text not null default 'uploaded' check (origin in ('uploaded', 'generated')),
    add column template_id      uuid references public.case_templates(id),
    add column template_version int;

create table public.report_files (
    report_id    uuid not null references public.reports(id) on delete cascade,
    format       text not null check (format in ('pdf', 'docx')),
    storage_path text not null,
    sha256       text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes   bigint,
    created_at   timestamptz not null default now(),
    primary key (report_id, format)
);

create table public.report_annexures (
    report_id   uuid not null references public.reports(id) on delete cascade,
    evidence_id uuid not null references public.evidence(id),
    section_key text,
    position    int  not null,
    caption     text,
    primary key (report_id, evidence_id)
);

create or replace function private.report_annexures_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if not exists (select 1 from public.reports r join public.evidence e on e.case_id = r.case_id
                    where r.id = new.report_id and e.id = new.evidence_id
                      and e.withdrawn_at is null and e.relevance <> 'not_relevant') then
        raise exception 'Annexure must be non-withdrawn, relevant evidence of the same case' using errcode = '23514';
    end if;
    return new;
end $$;
create trigger trg_report_annexures_validate before insert or update on public.report_annexures
    for each row execute function private.report_annexures_validate();

create type public.approval_decision as enum ('pending', 'approved', 'changes_requested');

create table public.report_approvals (
    id           uuid primary key default gen_random_uuid(),
    case_id      uuid not null references public.cases(id) on delete cascade,
    report_id    uuid not null unique references public.reports(id) on delete cascade,
    requested_by uuid not null default auth.uid() references public.profiles(id),
    requested_at timestamptz not null default now(),
    decision     public.approval_decision not null default 'pending',
    decided_by   uuid references public.profiles(id),
    decided_at   timestamptz,
    comments     text
);

create or replace function private.report_approvals_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'INSERT' then
        if not exists (select 1 from public.reports r where r.id = new.report_id and r.case_id = new.case_id) then
            raise exception 'Report does not belong to the case' using errcode = '23514';
        end if;
        new.requested_by := coalesce((select auth.uid()), new.requested_by);
        new.requested_at := now();
        new.decision := 'pending'; new.decided_by := null; new.decided_at := null;
        update public.cases set status = 'orchestrator_review'
         where id = new.case_id and status in ('office_review', 'field_in_progress', 'assigned');
        perform private.notify_orchestrators('approval_requested', new.case_id, 'Report waiting for approval',
                                             null, 'approval:' || new.id);
        return new;
    end if;
    if (new.case_id, new.report_id, new.requested_by, new.requested_at)
       is distinct from (old.case_id, old.report_id, old.requested_by, old.requested_at) then
        raise exception 'Approval request fields cannot change' using errcode = '42501';
    end if;
    if new.decision is distinct from old.decision then
        if coalesce(private.current_user_role() not in ('orchestrator', 'admin'), true) then
            raise exception 'Only an orchestrator or admin can decide' using errcode = '42501';
        end if;
        if old.decision <> 'pending' or new.decision = 'pending' then
            raise exception 'An approval is decided once' using errcode = '42501';
        end if;
        new.decided_by := (select auth.uid());
        new.decided_at := now();
        if new.decision = 'changes_requested' then
            update public.cases set status = 'office_review' where id = new.case_id and status = 'orchestrator_review';
            perform private.notify(old.requested_by, 'changes_requested', new.case_id, 'Changes requested on report',
                                   new.comments, 'changes:' || new.id);
        end if;
    end if;
    return new;
end $$;
create trigger trg_report_approvals_guard before insert or update on public.report_approvals
    for each row execute function private.report_approvals_guard();

alter table public.submissions
    add column formats         text[]   not null default '{}' check (formats <@ array['pdf','docx']),
    add column to_addresses    citext[] not null default '{}',
    add column cc_addresses    citext[] not null default '{}',
    add column sent_message_id text,
    add column gmail_thread_id text;

create or replace function private.submissions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tpl public.case_templates;
begin
    if not exists (select 1 from public.reports r where r.id = new.report_id and r.case_id = new.case_id) then
        raise exception 'Report does not belong to the case' using errcode = '23514';
    end if;
    select t.* into v_tpl from public.cases c join public.case_templates t on t.id = c.template_id where c.id = new.case_id;
    if v_tpl.id is not null then
        if v_tpl.requires_approval and not exists (
            select 1 from public.report_approvals a where a.report_id = new.report_id and a.decision = 'approved') then
            raise exception 'This report needs approval before it is sent' using errcode = '42501';
        end if;
        if not (new.formats <@ v_tpl.output_formats) then
            raise exception 'Format not allowed for this insurer template' using errcode = '23514';
        end if;
    end if;
    return new;
end $$;
create trigger trg_submissions_guard before insert on public.submissions
    for each row execute function private.submissions_guard();

create or replace function private.submissions_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    update public.cases set status = 'submitted'
     where id = new.case_id and status not in ('submitted', 'closed', 'cancelled');
    perform private.post_system_message(new.case_id, 'Report sent to the insurer (' || new.channel || ')');
    return null;
end $$;
create trigger trg_submissions_after_insert after insert on public.submissions
    for each row execute function private.submissions_after_insert();

-- ---------------------------------------------------------------------
-- K2. Notifications: read-only except read_at; escalation job
-- ---------------------------------------------------------------------
create or replace function private.notifications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
        raise exception 'Only read_at can change' using errcode = '42501';
    end if;
    return new;
end $$;
create trigger trg_notifications_guard before update on public.notifications
    for each row execute function private.notifications_guard();

-- Run every 10-15 minutes (pg_cron or the intake Worker cron), service role only
create or replace function public.escalate_unattended_cases() returns int
language plpgsql security definer set search_path = '' as $$
declare r record; v_n int := 0;
begin
    for r in select c.id, c.case_ref from public.cases c
              where c.status in ('received', 'intake_confirmed') and c.office_owner_id is null
                and c.created_at < now() - make_interval(mins => private.setting_int('escalate_unassigned_minutes', 30))
    loop
        v_n := v_n + private.notify_orchestrators('case_unassigned', r.id, 'Case ' || r.case_ref || ' is still unassigned',
                                                  null, 'unassigned:' || r.id);
    end loop;
    for r in select c.id, c.case_ref from public.cases c
              where c.status = 'assigned' and c.office_assigned_at
                    < now() - make_interval(hours => private.setting_int('escalate_no_field_task_hours', 24))
                and not exists (select 1 from public.tasks t where t.case_id = c.id)
    loop
        v_n := v_n + private.notify_orchestrators('no_field_task', r.id, 'Case ' || r.case_ref || ' has no field work assigned',
                                                  null, 'no_field_task:' || r.id);
    end loop;
    return v_n;
end $$;

-- ---------------------------------------------------------------------
-- L. Read models for the field app and the report workspace
-- ---------------------------------------------------------------------
create or replace view public.v_evidence_processing with (security_invoker = true) as
select e.id as evidence_id, e.case_id,
       case when count(j.id) = 0 then 'none'
            when bool_or(j.status = 'running') then 'processing'
            when bool_or(j.status = 'queued') then 'pending'
            when bool_or(j.status = 'failed') then 'failed'
            else 'done' end as state
  from public.evidence e
  left join public.processing_jobs j on j.evidence_id = e.id
 group by e.id, e.case_id;

-- Checklist progress per task item: done when ticked, linked directly, or matched by an active label
create or replace view public.v_case_checklist with (security_invoker = true) as
select i.id as checklist_item_id, t.case_id, i.task_id, i.position, i.description, i.category_id,
       i.is_mandatory, i.status,
       (select count(*) from public.evidence e
         where e.case_id = t.case_id and e.withdrawn_at is null and e.relevance <> 'not_relevant'
           and (e.checklist_item_id = i.id
                or (i.category_id is not null and exists (
                        select 1 from public.evidence_labels l
                         where l.evidence_id = e.id and l.is_active and l.category_id = i.category_id)))) as evidence_count
  from public.task_checklist_items i
  join public.tasks t on t.id = i.task_id;

-- Field app home: "Open" and "Completed" lists with last message and unread count
create or replace function public.field_case_list()
returns table (case_id uuid, case_ref text, insurer_name text, claim_type public.claim_type, title text,
               list text, last_message_at timestamptz, last_message_preview text, unread_count int)
language sql stable security invoker set search_path = '' as $$
    select c.id, c.case_ref, i.name, c.claim_type,
           coalesce((select v.value from public.case_field_values v
                       join public.case_template_fields f on f.id = v.field_id
                      where v.case_id = c.id and f.key = 'insured_name' limit 1),
                    c.insurer_claim_no),
           case when exists (select 1 from public.tasks t where t.case_id = c.id and t.assignee_id = (select auth.uid())
                               and t.status in ('pending', 'in_progress')) then 'open' else 'completed' end,
           lm.created_at,
           case when lm.withdrawn_at is not null then 'Message withdrawn'
                when lm.kind in ('media', 'voice') then coalesce(lm.body, 'Attachment')
                else left(lm.body, 120) end,
           (select count(*)::int from public.case_messages m
             where m.case_id = c.id and m.sender_id is distinct from (select auth.uid())
               and m.created_at > coalesce((select r.last_read_at from public.case_thread_reads r
                                             where r.case_id = c.id and r.user_id = (select auth.uid())), '-infinity'))
      from public.cases c
      join public.insurers i on i.id = c.insurer_id
      left join lateral (select m.* from public.case_messages m where m.case_id = c.id
                          order by m.created_at desc limit 1) lm on true
     where public.is_field()
       and exists (select 1 from public.tasks t where t.case_id = c.id and t.assignee_id = (select auth.uid()))
     order by lm.created_at desc nulls last;
$$;

-- ---------------------------------------------------------------------
-- M. Row-level security, grants, audit
-- ---------------------------------------------------------------------
create or replace function private.is_intake_field(p_field_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.case_template_fields f where f.id = p_field_id and f.source = 'intake');
$$;

alter table public.app_settings                     enable row level security;
alter table public.evidence_categories              enable row level security;
alter table public.case_templates                   enable row level security;
alter table public.case_template_sections           enable row level security;
alter table public.case_template_fields             enable row level security;
alter table public.case_template_section_categories enable row level security;
alter table public.case_template_checklists         enable row level security;
alter table public.case_field_values                enable row level security;
alter table public.case_assignments                 enable row level security;
alter table public.assignment_rules                 enable row level security;
alter table public.assignment_rule_members          enable row level security;
alter table public.case_messages                    enable row level security;
alter table public.case_thread_reads                enable row level security;
alter table public.notifications                    enable row level security;
alter table public.device_tokens                    enable row level security;
alter table public.evidence_ocr                     enable row level security;
alter table public.evidence_labels                  enable row level security;
alter table public.field_suggestions                enable row level security;
alter table public.processing_jobs                  enable row level security;
alter table public.report_files                     enable row level security;
alter table public.report_annexures                 enable row level security;
alter table public.report_approvals                 enable row level security;

-- settings and configuration: staff read, admin write
create policy p_settings_read  on public.app_settings for select to authenticated using (public.is_staff());
create policy p_settings_admin on public.app_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy p_categories_read  on public.evidence_categories for select to authenticated using (public.is_staff() or public.is_field());
create policy p_categories_admin on public.evidence_categories for all    to authenticated using (public.is_admin()) with check (public.is_admin());

create policy p_ctpl_read   on public.case_templates for select to authenticated using (public.is_staff());
create policy p_ctpl_admin  on public.case_templates for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy p_ctps_read   on public.case_template_sections for select to authenticated using (public.is_staff());
create policy p_ctps_admin  on public.case_template_sections for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy p_ctpf_read   on public.case_template_fields for select to authenticated using (public.is_staff());
create policy p_ctpf_admin  on public.case_template_fields for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy p_ctsc_read   on public.case_template_section_categories for select to authenticated using (public.is_staff());
create policy p_ctsc_admin  on public.case_template_section_categories for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy p_ctcl_read   on public.case_template_checklists for select to authenticated using (public.is_staff());
create policy p_ctcl_admin  on public.case_template_checklists for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- case data
create policy p_cfv_staff on public.case_field_values for all to authenticated
    using (public.is_staff()) with check (public.is_staff());
create policy p_cfv_field on public.case_field_values for select to authenticated
    using (public.is_field() and private.field_can_see_case(case_id) and private.is_intake_field(field_id));

create policy p_assignments_read on public.case_assignments for select to authenticated using (public.is_staff());

create policy p_rules_read  on public.assignment_rules for select to authenticated using (public.is_staff());
create policy p_rules_write on public.assignment_rules for all to authenticated
    using (private.current_user_role() in ('admin', 'orchestrator'))
    with check (private.current_user_role() in ('admin', 'orchestrator'));
create policy p_rule_members_read  on public.assignment_rule_members for select to authenticated using (public.is_staff());
create policy p_rule_members_write on public.assignment_rule_members for all to authenticated
    using (private.current_user_role() in ('admin', 'orchestrator'))
    with check (private.current_user_role() in ('admin', 'orchestrator'));

-- thread
create policy p_msg_staff_r on public.case_messages for select to authenticated using (public.is_staff());
create policy p_msg_staff_w on public.case_messages for insert to authenticated
    with check (public.is_staff() and sender_id = (select auth.uid()) and kind in ('text', 'media', 'voice'));
create policy p_msg_field_r on public.case_messages for select to authenticated
    using (public.is_field() and private.field_can_see_case(case_id));
create policy p_msg_field_w on public.case_messages for insert to authenticated
    with check (public.is_field() and sender_id = (select auth.uid()) and kind in ('text', 'media', 'voice')
                and private.field_can_post(case_id));

create policy p_reads_own on public.case_thread_reads for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid())
                and (public.is_staff() or (public.is_field() and private.field_can_see_case(case_id))));

-- evidence: field users read their own items and items posted to threads they can see
drop policy p_evidence_field_r on public.evidence;
create policy p_evidence_field_r on public.evidence for select to authenticated
    using (public.is_field() and (captured_by = (select auth.uid())
           or (message_id is not null and withdrawn_at is null and private.field_can_see_case(case_id))));
drop policy p_evidence_field_w on public.evidence;
create policy p_evidence_field_w on public.evidence for insert to authenticated with check (
    public.is_field()
    and captured_by = (select auth.uid())
    and capture_source in ('camera', 'gallery', 'share')
    and exists (select 1 from public.tasks t
                where t.id = task_id and t.case_id = evidence.case_id
                  and t.assignee_id = (select auth.uid())
                  and t.status in ('pending', 'in_progress'))
);

-- processing outputs
create policy p_ocr_staff   on public.evidence_ocr for select to authenticated using (public.is_staff());
create policy p_ocr_field_w on public.evidence_ocr for insert to authenticated with check (
    public.is_field() and exists (select 1 from public.evidence e
                                   where e.id = evidence_id and e.captured_by = (select auth.uid())));
create policy p_labels_read on public.evidence_labels for select to authenticated
    using (public.is_staff() or (public.is_field() and exists (select 1 from public.evidence e where e.id = evidence_id)));
create policy p_labels_field_w on public.evidence_labels for insert to authenticated with check (
    public.is_field() and source = 'operator'
    and exists (select 1 from public.evidence e where e.id = evidence_id and e.captured_by = (select auth.uid())));
create policy p_labels_staff_w on public.evidence_labels for insert to authenticated
    with check (public.is_staff() and source in ('human', 'operator'));
create policy p_suggest_staff on public.field_suggestions for select to authenticated using (public.is_staff());
create policy p_suggest_staff_u on public.field_suggestions for update to authenticated
    using (public.is_staff()) with check (public.is_staff());
create policy p_jobs_read on public.processing_jobs for select to authenticated
    using ((public.is_staff() or public.is_field()) and exists (select 1 from public.evidence e where e.id = evidence_id));

-- reports
create policy p_rfiles_staff  on public.report_files     for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy p_rannex_staff  on public.report_annexures for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy p_approvals_r   on public.report_approvals for select to authenticated using (public.is_staff());
create policy p_approvals_i   on public.report_approvals for insert to authenticated
    with check (public.is_staff() and requested_by = (select auth.uid()));
create policy p_approvals_u   on public.report_approvals for update to authenticated
    using (private.current_user_role() in ('orchestrator', 'admin'))
    with check (private.current_user_role() in ('orchestrator', 'admin'));

-- notifications and devices: own rows only
create policy p_notif_own_r on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy p_notif_own_u on public.notifications for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy p_tokens_own on public.device_tokens for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and private.current_user_role() is not null);

-- field_suggestion decisions are stamped by the server
create or replace function private.field_suggestions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if (to_jsonb(new) - array['status','decided_by','decided_at'])
       is distinct from (to_jsonb(old) - array['status','decided_by','decided_at']) then
        raise exception 'Only the decision can change' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
        new.decided_by := (select auth.uid());
        new.decided_at := now();
    end if;
    return new;
end $$;
create trigger trg_field_suggestions_guard before update on public.field_suggestions
    for each row execute function private.field_suggestions_guard();

-- anon gets nothing; worker / job functions are service-role only
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_user_role(), private.field_can_see_case(uuid), private.is_archive_writer(),
                          private.field_can_post(uuid), private.is_intake_field(uuid), private.setting_int(text, int)
    to authenticated, service_role;

revoke execute on function
    public.set_availability(uuid, public.staff_availability, timestamptz),
    public.load_evidence_categories(jsonb), public.load_case_template(jsonb, text, boolean),
    public.reassign_case(uuid, uuid, text), public.retry_auto_assign(uuid),
    public.can_upload_case_file(uuid), public.set_evidence_labels(uuid, uuid[]),
    public.post_thread_message(uuid, uuid, public.message_kind, text, uuid, uuid, jsonb),
    public.withdraw_message(uuid), public.mark_thread_read(uuid), public.case_thread_state(uuid),
    public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid),
    public.field_case_list(),
    public.claim_processing_jobs(public.processing_stage[], int, text),
    public.complete_processing_job(bigint, public.job_status, text),
    public.enqueue_reprocessing(uuid[], public.processing_stage[], text),
    public.escalate_unattended_cases()
from public, anon;
grant execute on function
    public.set_availability(uuid, public.staff_availability, timestamptz),
    public.load_evidence_categories(jsonb), public.load_case_template(jsonb, text, boolean),
    public.reassign_case(uuid, uuid, text), public.retry_auto_assign(uuid),
    public.can_upload_case_file(uuid), public.set_evidence_labels(uuid, uuid[]),
    public.post_thread_message(uuid, uuid, public.message_kind, text, uuid, uuid, jsonb),
    public.withdraw_message(uuid), public.mark_thread_read(uuid), public.case_thread_state(uuid),
    public.create_field_task(uuid, uuid, text, text, uuid, public.task_kind, timestamptz, text, uuid),
    public.field_case_list()
to authenticated, service_role;
revoke execute on function
    public.claim_processing_jobs(public.processing_stage[], int, text),
    public.complete_processing_job(bigint, public.job_status, text),
    public.enqueue_reprocessing(uuid[], public.processing_stage[], text),
    public.escalate_unattended_cases()
from authenticated;
grant execute on function
    public.claim_processing_jobs(public.processing_stage[], int, text),
    public.complete_processing_job(bigint, public.job_status, text),
    public.enqueue_reprocessing(uuid[], public.processing_stage[], text),
    public.escalate_unattended_cases()
to service_role;

-- audit trail (tables with a uuid id)
create trigger trg_case_templates_audit     after insert or update or delete on public.case_templates     for each row execute function private.audit_row();
create trigger trg_case_field_values_audit  after insert or update or delete on public.case_field_values  for each row execute function private.audit_row();
create trigger trg_case_messages_audit      after insert or update or delete on public.case_messages      for each row execute function private.audit_row();
create trigger trg_evidence_labels_audit    after insert or update or delete on public.evidence_labels    for each row execute function private.audit_row();
create trigger trg_report_approvals_audit   after insert or update or delete on public.report_approvals   for each row execute function private.audit_row();
create trigger trg_assignment_rules_audit   after insert or update or delete on public.assignment_rules   for each row execute function private.audit_row();
create trigger trg_evidence_categories_audit after insert or update or delete on public.evidence_categories for each row execute function private.audit_row();
