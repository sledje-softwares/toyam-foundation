-- =====================================================================
-- Claims Investigation Platform — Phase 1 Database Schema
-- Target: PostgreSQL 15+ (Supabase). Uses auth.users and auth.uid().
-- Scope: email intake, case & task management, field evidence capture,
--        report upload, submission tracking, audit trail.
-- =====================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email/domain

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
create type user_role            as enum ('admin', 'orchestrator', 'office', 'field');
create type claim_type           as enum ('health', 'motor', 'death', 'personal_accident', 'property', 'other');
create type case_status          as enum ('received', 'intake_confirmed', 'assigned', 'field_in_progress',
                                          'office_review', 'orchestrator_review', 'submitted', 'closed', 'cancelled');
create type task_kind            as enum ('initial', 're_investigation', 'office', 'other');
create type task_status          as enum ('pending', 'in_progress', 'completed', 'cancelled');
create type checklist_status     as enum ('pending', 'captured', 'not_available', 'waived');
create type evidence_type        as enum ('photo', 'document', 'audio', 'video', 'note');
create type capture_source       as enum ('camera', 'gallery', 'web_upload', 'email_attachment');
create type email_classification as enum ('unclassified', 'new_case', 'reminder', 'additional_docs', 'query', 'other');
create type email_status         as enum ('pending', 'processing', 'processed', 'failed', 'ignored');
create type extraction_status    as enum ('pending_review', 'confirmed', 'rejected');
create type party_role           as enum ('insured', 'patient', 'claimant', 'nominee', 'driver', 'witness', 'other');
create type entity_type          as enum ('hospital', 'garage', 'doctor', 'agent', 'police_station', 'other');
create type submission_channel   as enum ('email', 'portal', 'other');
create type report_status        as enum ('draft', 'final');

-- ---------------------------------------------------------------------
-- 2. USERS
-- ---------------------------------------------------------------------
create table profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    full_name   text        not null,
    phone       text,
    role        user_role   not null,
    region      text,                               -- operating area for field staff
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. MASTER DATA
-- ---------------------------------------------------------------------
create table insurers (
    id                   uuid primary key default gen_random_uuid(),
    name                 text        not null unique,
    code                 text        not null unique,          -- short code used in case refs, e.g. 'HDFC'
    sender_domains       citext[]    not null default '{}',    -- used to identify incoming emails
    reply_to_email       citext,                               -- where reports are sent back
    tat_days             int         not null default 15 check (tat_days > 0),
    submission_channel   submission_channel not null default 'email',
    portal_url           text,
    report_template_path text,                                 -- storage path of the insurer's Word template
    extraction_hints     jsonb       not null default '{}',    -- per-insurer prompt hints / field aliases
    is_active            boolean     not null default true,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

-- Checklist templates: by claim type, optionally overridden per insurer
create table checklist_templates (
    id          uuid primary key default gen_random_uuid(),
    name        text        not null,
    claim_type  claim_type  not null,
    insurer_id  uuid        references insurers(id),           -- null = applies to all insurers
    is_active   boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index uq_active_template
    on checklist_templates (claim_type, coalesce(insurer_id, '00000000-0000-0000-0000-000000000000'::uuid))
    where is_active;

create table checklist_template_items (
    id                     uuid primary key default gen_random_uuid(),
    template_id            uuid          not null references checklist_templates(id) on delete cascade,
    position               int           not null,
    description            text          not null,
    required_evidence_type evidence_type not null default 'photo',
    is_mandatory           boolean       not null default true,
    camera_only            boolean       not null default false,  -- gallery uploads not accepted
    unique (template_id, position)
);

-- Hospitals, garages, doctors, agents etc. Captured now; used for fraud patterns in Phase 3
create table entities (
    id              uuid primary key default gen_random_uuid(),
    entity_type     entity_type not null,
    name            text        not null,
    city            text,
    state           text,
    address         text,
    registration_no text,
    phone           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create unique index uq_entity on entities (entity_type, lower(name), lower(coalesce(city, '')));

-- ---------------------------------------------------------------------
-- 4. CASES
-- ---------------------------------------------------------------------
create sequence case_ref_seq;

create table cases (
    id                uuid primary key default gen_random_uuid(),
    case_ref          text        not null unique,             -- e.g. INV-2026-000123 (auto)
    insurer_id        uuid        not null references insurers(id),
    insurer_claim_no  text        not null,
    policy_no         text,
    claim_type        claim_type  not null,
    claim_amount      numeric(14,2) check (claim_amount >= 0),
    suspicion_summary text,                                    -- doubt raised by the insurer
    incident_date     date,
    received_at       timestamptz not null default now(),      -- when the insurer sent the case
    due_at            timestamptz,                             -- defaults from insurer TAT
    status            case_status not null default 'received',
    orchestrator_id   uuid        references profiles(id),
    office_owner_id   uuid        references profiles(id),
    closed_at         timestamptz,
    created_by        uuid        references profiles(id),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (insurer_id, insurer_claim_no)                      -- duplicate prevention
);
create index ix_cases_status on cases (status);
create index ix_cases_due    on cases (due_at) where status not in ('submitted', 'closed', 'cancelled');
create index ix_cases_policy on cases (policy_no);

create table parties (
    id         uuid primary key default gen_random_uuid(),
    case_id    uuid        not null references cases(id) on delete cascade,
    role       party_role  not null,
    name       text        not null,
    phone      text,
    address    text,
    age        int check (age between 0 and 130),
    notes      text,
    created_at timestamptz not null default now()
);
create index ix_parties_case on parties (case_id);
create index ix_parties_name on parties (lower(name));

create table case_entities (
    case_id   uuid not null references cases(id) on delete cascade,
    entity_id uuid not null references entities(id),
    relation  text not null default 'involved',                -- e.g. 'treating_hospital', 'repair_garage'
    primary key (case_id, entity_id, relation)
);
create index ix_case_entities_entity on case_entities (entity_id);

create table case_status_history (
    id          bigint generated always as identity primary key,
    case_id     uuid        not null references cases(id) on delete cascade,
    from_status case_status,
    to_status   case_status not null,
    changed_by  uuid        references profiles(id),
    changed_at  timestamptz not null default now(),
    note        text
);
create index ix_status_hist_case on case_status_history (case_id, changed_at);

-- ---------------------------------------------------------------------
-- 5. EMAIL INTAKE
-- ---------------------------------------------------------------------
create table emails (
    id               uuid primary key default gen_random_uuid(),
    gmail_message_id text         not null unique,             -- idempotency key
    gmail_thread_id  text,
    from_address     citext       not null,
    to_addresses     citext[]     not null default '{}',
    subject          text,
    body_text        text,
    received_at      timestamptz  not null,
    raw_storage_path text,                                     -- full .eml kept for record
    classification   email_classification not null default 'unclassified',
    status           email_status not null default 'pending',
    insurer_id       uuid         references insurers(id),
    case_id          uuid         references cases(id),
    processed_at     timestamptz,
    error            text,
    created_at       timestamptz  not null default now()
);
create index ix_emails_status on emails (status);
create index ix_emails_case   on emails (case_id);
create index ix_emails_thread on emails (gmail_thread_id);

create table email_attachments (
    id           uuid primary key default gen_random_uuid(),
    email_id     uuid   not null references emails(id) on delete cascade,
    filename     text   not null,
    mime_type    text,
    size_bytes   bigint,
    storage_path text   not null,
    sha256       text   not null,
    ocr_text     text,
    created_at   timestamptz not null default now()
);
create index ix_attach_email on email_attachments (email_id);

create table intake_extractions (
    id               uuid primary key default gen_random_uuid(),
    email_id         uuid              not null references emails(id) on delete cascade,
    case_id          uuid              references cases(id),   -- set on confirmation
    model            text              not null,
    extracted        jsonb             not null,               -- field -> value
    field_confidence jsonb             not null default '{}',  -- field -> 0..1
    status           extraction_status not null default 'pending_review',
    reviewed_by      uuid              references profiles(id),
    reviewed_at      timestamptz,
    created_at       timestamptz       not null default now()
);
create index ix_extraction_pending on intake_extractions (created_at) where status = 'pending_review';

-- ---------------------------------------------------------------------
-- 6. TASKS & CHECKLISTS
-- ---------------------------------------------------------------------
create table tasks (
    id             uuid primary key default gen_random_uuid(),
    case_id        uuid        not null references cases(id) on delete cascade,
    kind           task_kind   not null default 'initial',
    parent_task_id uuid        references tasks(id),           -- re-investigation links to earlier task
    title          text        not null,
    instructions   text,
    reason         text,                                       -- why this task was raised
    assignee_id    uuid        references profiles(id),
    due_at         timestamptz,
    status         task_status not null default 'pending',
    location_text  text,
    location_lat   double precision,
    location_lng   double precision,
    created_by     uuid        references profiles(id),
    started_at     timestamptz,
    completed_at   timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create index ix_tasks_case     on tasks (case_id);
create index ix_tasks_assignee on tasks (assignee_id, status);

create table task_checklist_items (
    id                      uuid primary key default gen_random_uuid(),
    task_id                 uuid             not null references tasks(id) on delete cascade,
    source_template_item_id uuid             references checklist_template_items(id),
    position                int              not null,
    description             text             not null,
    required_evidence_type  evidence_type    not null default 'photo',
    is_mandatory            boolean          not null default true,
    camera_only             boolean          not null default false,
    status                  checklist_status not null default 'pending',
    note                    text,                              -- e.g. reason if not available
    completed_at            timestamptz,
    updated_at              timestamptz      not null default now()
);
create index ix_checklist_task on task_checklist_items (task_id);

-- ---------------------------------------------------------------------
-- 7. EVIDENCE (integrity-critical; core fields are immutable)
-- ---------------------------------------------------------------------
create table evidence (
    id                 uuid primary key default gen_random_uuid(),
    case_id            uuid           not null references cases(id) on delete restrict,
    task_id            uuid           references tasks(id) on delete restrict,
    checklist_item_id  uuid           references task_checklist_items(id) on delete set null,
    evidence_type      evidence_type  not null,
    capture_source     capture_source not null,
    storage_path       text,                                   -- null only for evidence_type = 'note'
    mime_type          text,
    size_bytes         bigint,
    sha256             text,                                   -- computed on device, re-verified on upload
    note_text          text,
    captured_by        uuid           not null references profiles(id),
    device_captured_at timestamptz,                            -- phone clock
    server_received_at timestamptz    not null default now(),  -- trusted clock
    latitude           double precision,
    longitude          double precision,
    gps_accuracy_m     real,
    device_info        jsonb          not null default '{}',
    is_flagged         boolean        not null default false,  -- e.g. gallery upload, GPS mismatch
    flag_reason        text,
    created_at         timestamptz    not null default now(),
    check (evidence_type = 'note' or (storage_path is not null and sha256 is not null)),
    check (evidence_type <> 'note' or note_text is not null)
);
create index ix_evidence_case      on evidence (case_id);
create index ix_evidence_checklist on evidence (checklist_item_id);
create unique index uq_evidence_hash on evidence (case_id, sha256) where sha256 is not null;  -- no duplicate uploads

-- ---------------------------------------------------------------------
-- 8. REPORTS & SUBMISSIONS
-- ---------------------------------------------------------------------
create table reports (
    id           uuid primary key default gen_random_uuid(),
    case_id      uuid          not null references cases(id) on delete cascade,
    version      int           not null,
    status       report_status not null default 'draft',
    storage_path text          not null,
    uploaded_by  uuid          not null references profiles(id),
    notes        text,
    created_at   timestamptz   not null default now(),
    unique (case_id, version)
);

create table submissions (
    id                uuid primary key default gen_random_uuid(),
    case_id           uuid               not null references cases(id) on delete cascade,
    report_id         uuid               not null references reports(id),
    channel           submission_channel not null,
    submitted_at      timestamptz        not null default now(),
    submitted_by      uuid               not null references profiles(id),
    insurer_reference text,                                    -- portal ref no. / email message id
    acknowledged_at   timestamptz,
    notes             text
);
create index ix_submissions_case on submissions (case_id);

-- ---------------------------------------------------------------------
-- 9. AUDIT LOG
-- ---------------------------------------------------------------------
create table audit_log (
    id         bigint generated always as identity primary key,
    actor_id   uuid,
    action     text        not null,                           -- INSERT / UPDATE / DELETE
    table_name text        not null,
    record_id  uuid,
    old_data   jsonb,
    new_data   jsonb,
    at         timestamptz not null default now()
);
create index ix_audit_record on audit_log (table_name, record_id);

-- =====================================================================
-- 10. FUNCTIONS & TRIGGERS
-- =====================================================================

-- updated_at maintenance
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end $$;

do $$
declare t text;
begin
    foreach t in array array['profiles','insurers','checklist_templates','entities','cases','tasks','task_checklist_items']
    loop
        execute format('create trigger trg_%s_updated before update on %I
                        for each row execute function set_updated_at()', t, t);
    end loop;
end $$;

-- Case reference + default due date from insurer TAT
create or replace function cases_before_insert() returns trigger language plpgsql as $$
declare v_tat int;
begin
    if new.case_ref is null then
        new.case_ref := 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('case_ref_seq')::text, 6, '0');
    end if;
    if new.due_at is null then
        select tat_days into v_tat from insurers where id = new.insurer_id;
        new.due_at := new.received_at + make_interval(days => coalesce(v_tat, 15));
    end if;
    return new;
end $$;
create trigger trg_cases_before_insert before insert on cases
    for each row execute function cases_before_insert();

-- Status history (feeds turnaround-per-stage reporting)
create or replace function cases_status_history() returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        insert into case_status_history (case_id, from_status, to_status, changed_by)
        values (new.id, null, new.status, auth.uid());
    elsif new.status is distinct from old.status then
        insert into case_status_history (case_id, from_status, to_status, changed_by)
        values (new.id, old.status, new.status, auth.uid());
        if new.status = 'closed' and new.closed_at is null then
            new.closed_at := now();
        end if;
    end if;
    return new;
end $$;
create trigger trg_cases_status_ins after insert on cases
    for each row execute function cases_status_history();
create trigger trg_cases_status_upd before update of status on cases
    for each row execute function cases_status_history();

-- Copy checklist template into a new task: call after creating a task
create or replace function apply_checklist_template(p_task_id uuid, p_template_id uuid)
returns int language sql as $$
    with ins as (
        insert into task_checklist_items
            (task_id, source_template_item_id, position, description,
             required_evidence_type, is_mandatory, camera_only)
        select p_task_id, i.id, i.position, i.description,
               i.required_evidence_type, i.is_mandatory, i.camera_only
        from checklist_template_items i
        where i.template_id = p_template_id
        order by i.position
        returning 1
    )
    select count(*)::int from ins;
$$;

-- Evidence immutability: only flag fields may change after insert
create or replace function evidence_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Evidence records cannot be deleted';
    end if;
    if (new.case_id, new.task_id, new.evidence_type, new.capture_source, new.storage_path,
        new.sha256, new.captured_by, new.device_captured_at, new.server_received_at,
        new.latitude, new.longitude, new.note_text)
       is distinct from
       (old.case_id, old.task_id, old.evidence_type, old.capture_source, old.storage_path,
        old.sha256, old.captured_by, old.device_captured_at, old.server_received_at,
        old.latitude, old.longitude, old.note_text) then
        raise exception 'Evidence core fields are immutable';
    end if;
    return new;
end $$;
create trigger trg_evidence_guard before update or delete on evidence
    for each row execute function evidence_guard();

-- Auto-flag gallery uploads for camera-only checklist items
create or replace function evidence_autoflag() returns trigger language plpgsql as $$
begin
    if new.capture_source = 'gallery' and exists (
        select 1 from task_checklist_items c where c.id = new.checklist_item_id and c.camera_only
    ) then
        new.is_flagged  := true;
        new.flag_reason := coalesce(new.flag_reason, 'Gallery upload on camera-only item');
    end if;
    new.server_received_at := now();    -- never trust client-supplied server time
    return new;
end $$;
create trigger trg_evidence_autoflag before insert on evidence
    for each row execute function evidence_autoflag();

-- Generic audit trigger
create or replace function audit_row() returns trigger language plpgsql security definer
set search_path = public as $$
begin
    insert into audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (auth.uid(), tg_op, tg_table_name,
            coalesce(new.id, old.id),
            case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
            case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
    return coalesce(new, old);
end $$;

do $$
declare t text;
begin
    foreach t in array array['cases','parties','tasks','task_checklist_items','evidence',
                             'reports','submissions','insurers','intake_extractions','profiles']
    loop
        execute format('create trigger trg_%s_audit after insert or update or delete on %I
                        for each row execute function audit_row()', t, t);
    end loop;
end $$;

-- =====================================================================
-- 11. ROW-LEVEL SECURITY
-- =====================================================================

-- Role helpers (security definer avoids recursive RLS on profiles)
create or replace function current_user_role() returns user_role
language sql stable security definer set search_path = public as $$
    select role from profiles where id = auth.uid() and is_active;
$$;

create or replace function is_staff() returns boolean
language sql stable as $$
    select coalesce(current_user_role() in ('admin','orchestrator','office'), false);
$$;

create or replace function is_admin() returns boolean
language sql stable as $$
    select coalesce(current_user_role() = 'admin', false);
$$;

-- Field user may access a case only while they hold a task on it
create or replace function field_can_see_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from tasks t where t.case_id = p_case_id and t.assignee_id = auth.uid());
$$;

alter table profiles                 enable row level security;
alter table insurers                 enable row level security;
alter table checklist_templates      enable row level security;
alter table checklist_template_items enable row level security;
alter table entities                 enable row level security;
alter table cases                    enable row level security;
alter table parties                  enable row level security;
alter table case_entities            enable row level security;
alter table case_status_history      enable row level security;
alter table emails                   enable row level security;
alter table email_attachments        enable row level security;
alter table intake_extractions       enable row level security;
alter table tasks                    enable row level security;
alter table task_checklist_items     enable row level security;
alter table evidence                 enable row level security;
alter table reports                  enable row level security;
alter table submissions              enable row level security;
alter table audit_log                enable row level security;

-- Profiles: everyone reads own; staff read all; admin manages
create policy p_profiles_self  on profiles for select using (id = auth.uid() or is_staff());
create policy p_profiles_admin on profiles for all    using (is_admin()) with check (is_admin());

-- Master data: staff read; admin writes; field reads insurers only for case display
create policy p_insurers_read  on insurers for select using (is_staff() or current_user_role() = 'field');
create policy p_insurers_admin on insurers for all    using (is_admin()) with check (is_admin());
create policy p_tpl_read       on checklist_templates      for select using (is_staff());
create policy p_tpl_admin      on checklist_templates      for all    using (is_admin()) with check (is_admin());
create policy p_tpli_read      on checklist_template_items for select using (is_staff());
create policy p_tpli_admin     on checklist_template_items for all    using (is_admin()) with check (is_admin());
create policy p_entities_staff on entities for all using (is_staff()) with check (is_staff());

-- Staff: full operational access
create policy p_cases_staff      on cases               for all    using (is_staff()) with check (is_staff());
create policy p_parties_staff    on parties             for all    using (is_staff()) with check (is_staff());
create policy p_case_ent_staff   on case_entities       for all    using (is_staff()) with check (is_staff());
create policy p_hist_staff       on case_status_history for select using (is_staff());
create policy p_emails_staff     on emails              for all    using (is_staff()) with check (is_staff());
create policy p_attach_staff     on email_attachments   for all    using (is_staff()) with check (is_staff());
create policy p_extract_staff    on intake_extractions  for all    using (is_staff()) with check (is_staff());
create policy p_tasks_staff      on tasks               for all    using (is_staff()) with check (is_staff());
create policy p_checklist_staff  on task_checklist_items for all   using (is_staff()) with check (is_staff());
create policy p_reports_staff    on reports             for all    using (is_staff()) with check (is_staff());
create policy p_subs_staff       on submissions         for all    using (is_staff()) with check (is_staff());
create policy p_evidence_staff_r on evidence            for select using (is_staff());
create policy p_evidence_staff_w on evidence            for insert with check (is_staff());
create policy p_evidence_staff_u on evidence            for update using (is_staff()) with check (is_staff()); -- flags only (trigger enforces)
create policy p_audit_admin      on audit_log           for select using (is_admin());

-- Field: only what is assigned to them; no emails, extractions, reports or submissions
create policy p_cases_field     on cases   for select using (current_user_role() = 'field' and field_can_see_case(id));
create policy p_parties_field   on parties for select using (current_user_role() = 'field' and field_can_see_case(case_id));
create policy p_tasks_field_r   on tasks   for select using (assignee_id = auth.uid());
create policy p_tasks_field_u   on tasks   for update using (assignee_id = auth.uid()) with check (assignee_id = auth.uid());
create policy p_check_field_r   on task_checklist_items for select
    using (exists (select 1 from tasks t where t.id = task_id and t.assignee_id = auth.uid()));
create policy p_check_field_u   on task_checklist_items for update
    using (exists (select 1 from tasks t where t.id = task_id and t.assignee_id = auth.uid()));
create policy p_evidence_field_r on evidence for select using (captured_by = auth.uid());
create policy p_evidence_field_w on evidence for insert with check (
    captured_by = auth.uid()
    and exists (select 1 from tasks t
                where t.id = task_id and t.case_id = evidence.case_id
                  and t.assignee_id = auth.uid() and t.status in ('pending','in_progress'))
);

-- Field users must not change task fields other than status/timestamps
create or replace function tasks_field_guard() returns trigger language plpgsql as $$
begin
    if current_user_role() = 'field' and
       (new.case_id, new.kind, new.title, new.instructions, new.assignee_id, new.due_at, new.parent_task_id)
       is distinct from
       (old.case_id, old.kind, old.title, old.instructions, old.assignee_id, old.due_at, old.parent_task_id) then
        raise exception 'Field users may only update task status';
    end if;
    return new;
end $$;
create trigger trg_tasks_field_guard before update on tasks
    for each row execute function tasks_field_guard();

-- =====================================================================
-- 12. DASHBOARD VIEW
-- =====================================================================
create or replace view v_case_dashboard with (security_invoker = true) as
select
    c.id,
    c.case_ref,
    i.name                                                   as insurer,
    c.claim_type,
    c.status,
    c.received_at,
    c.due_at,
    round(extract(epoch from (c.due_at - now())) / 86400.0, 1) as days_remaining,
    (c.due_at < now() and c.status not in ('submitted','closed','cancelled')) as is_overdue,
    o.full_name                                              as orchestrator,
    count(t.id) filter (where t.status in ('pending','in_progress'))  as open_tasks,
    count(t.id) filter (where t.kind = 're_investigation')            as reinvestigation_rounds,
    string_agg(distinct a.full_name, ', ')
        filter (where t.status in ('pending','in_progress'))          as active_assignees
from cases c
join insurers i      on i.id = c.insurer_id
left join profiles o on o.id = c.orchestrator_id
left join tasks t    on t.case_id = c.id
left join profiles a on a.id = t.assignee_id
group by c.id, i.name, o.full_name;
