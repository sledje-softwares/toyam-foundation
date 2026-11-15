-- =====================================================================
-- 8.2 Send on the insurer's thread · 8.3 size handling · 8.4 portal pack   (D50)
--
--   report_sends                      outbox: one row per request to email a report (queued → sending →
--                                     sent | failed | unknown). The mail itself is sent by the edge function
--                                     `report-send` (Gmail SMTP); the row is the record of what was asked,
--                                     the Message-ID used and how big files were handled.
--   report_send_target(case)          staff: who to reply to (latest insurer mail on the case) and the
--                                     reply headers; defaults for To / CC.
--   request_report_send(...)          staff: validates and queues a send of the latest report version.
--   retry_report_send(id)             staff: failed → queued (same row, attempts counted).
--   resolve_report_send(id, sent)     staff: an `unknown` outcome (connection lost after DATA) is settled by
--                                     looking in the shared Sent folder: sent → recorded, not sent → failed.
--   request_portal_pack(case)         staff: validates a portal pack download and audits it.
--   claim_report_send(id, msgid)      service: lease a queued send (one sender at a time).
--   complete_report_send(...)         service: record the submission (channel email) atomically.
--   fail_report_send(id, err, amb)    service: failed, or unknown when the outcome is not certain.
--
-- A send is never repeated automatically: a lost connection after the message body was handed over
-- is `unknown`, and a person checks the Sent folder (no duplicate mail to an insurer).
-- =====================================================================

insert into public.app_settings (key, value, description) values
    ('send_attach_max_mb', '18',  'Largest total size (MB, before email encoding) attached to one report email; above it annexures go as a secure link (8.3)'),
    ('send_link_days',     '7',   'Days a secure download link in a report email stays valid (R2 allows at most 7)'),
    ('send_pack_max_mb',   '100', 'Largest annexure pack (MB) built in one request; larger sets need the pipeline worker'),
    ('send_lease_minutes', '10',  'A send claimed longer ago than this and not finished is marked unknown, never retried by itself')
on conflict (key) do nothing;

create table public.report_sends (
    id              uuid primary key default gen_random_uuid(),
    case_id         uuid        not null references public.cases(id) on delete cascade,
    report_id       uuid        not null references public.reports(id),
    requested_by    uuid        not null default auth.uid() references public.profiles(id),
    requested_at    timestamptz not null default now(),
    status          text        not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'unknown')),
    formats         text[]      not null check (cardinality(formats) >= 1 and formats <@ array['pdf', 'docx']),
    to_addresses    citext[]    not null check (cardinality(to_addresses) >= 1),
    cc_addresses    citext[]    not null default '{}',
    subject         text        not null check (char_length(subject) between 1 and 300),
    body            text        not null check (char_length(body) between 1 and 5000),
    attachment_name text        not null check (char_length(attachment_name) between 1 and 100),
    -- reply headers, taken from the insurer's mail by the database (never from the browser)
    in_reply_to     text,
    references_ids  text[]      not null default '{}',
    gmail_thread_id text,
    source_email_id uuid references public.emails(id),
    -- sender bookkeeping
    message_id      text,                         -- our Message-ID, fixed at the first claim and kept on retries
    attempts        int         not null default 0 check (attempts >= 0),
    claimed_at      timestamptz,
    sent_at         timestamptz,
    delivery        text check (delivery in ('attached', 'link')),
    link_expires_at timestamptz,
    pack_path       text,                         -- R2 key of the annexure pack when delivery = 'link'
    error           text,
    submission_id   uuid references public.submissions(id)
);
create index ix_report_sends_case on public.report_sends (case_id, requested_at desc);
-- one open request per report: nothing can be queued twice or while a send is unresolved
create unique index ux_report_sends_open on public.report_sends (report_id) where status in ('queued', 'sending', 'unknown');
comment on column public.report_sends.status is
    'queued → sending → sent | failed (nothing left the building, may be retried) | unknown (outcome not certain; staff settle it)';

alter table public.report_sends enable row level security;
create policy p_rsends_staff_r on public.report_sends for select to authenticated
    using (public.is_staff() and private.can_manage_case(case_id));
revoke all on public.report_sends from anon, authenticated;
grant select on public.report_sends to authenticated;

create trigger trg_report_sends_audit after insert or update on public.report_sends
    for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- Reply target
-- ---------------------------------------------------------------------
create or replace function public.report_send_target(p_case_id uuid)
returns table (email_id uuid, to_addresses text[], cc_addresses text[], original_subject text,
               in_reply_to text, references_ids text[], gmail_thread_id text)
language plpgsql stable security definer set search_path = '' as $$
declare
    v_e public.emails;
    v_int_addr text[];
    v_int_dom  text[];
begin
    if not public.is_staff() or not private.can_manage_case(p_case_id) then
        raise exception 'Not allowed' using errcode = '42501';
    end if;
    select coalesce(array(select jsonb_array_elements_text(s.value)), '{}') into v_int_addr
      from public.app_settings s where s.key = 'internal_email_addresses';
    select coalesce(array(select jsonb_array_elements_text(s.value)), '{}') into v_int_dom
      from public.app_settings s where s.key = 'internal_email_domains';
    -- latest mail from the insurer on this case (not the firm's own)
    select e.* into v_e from public.emails e
     where e.case_id = p_case_id and e.status = 'processed' and coalesce(e.is_internal, false) = false
       and lower(e.from_address::text) <> all (coalesce(v_int_addr, '{}'))
       and split_part(lower(e.from_address::text), '@', 2) <> all (coalesce(v_int_dom, '{}'))
     order by e.received_at desc, e.id desc limit 1;
    if v_e.id is null then
        return;
    end if;
    email_id := v_e.id;
    to_addresses := array[v_e.from_address::text];
    cc_addresses := coalesce((select array_agg(distinct lower(a) order by lower(a)) from unnest(coalesce(v_e.to_addresses::text[], '{}') || coalesce(v_e.cc_addresses::text[], '{}')) a
                               where lower(a) <> lower(v_e.from_address::text)), '{}');
    original_subject := v_e.subject;
    in_reply_to := v_e.gmail_message_id;
    references_ids := coalesce(v_e.references_ids, '{}') || case when v_e.gmail_message_id is not null
                                                                  and not (v_e.gmail_message_id = any (coalesce(v_e.references_ids, '{}')))
                                                                 then array[v_e.gmail_message_id] else '{}' end;
    gmail_thread_id := v_e.gmail_thread_id;
    return next;
end $$;
revoke all on function public.report_send_target(uuid) from public, anon;
grant execute on function public.report_send_target(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Shared checks for sending and for the portal pack
-- ---------------------------------------------------------------------
create or replace function private.report_ready_to_send(p_case_id uuid, p_formats text[]) returns public.reports
language plpgsql security definer set search_path = '' as $$
declare
    v_case public.cases;
    v_tpl  public.case_templates;
    o_report public.reports;
    f      text;
begin
    select * into v_case from public.cases c where c.id = p_case_id;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if v_case.status not in ('assigned', 'office_review', 'orchestrator_review') then
        raise exception '%', case v_case.status
            when 'submitted' then 'The report has already been sent. Reopen the case to send it again'
            when 'field_in_progress' then 'Field work is still open'
            when 'closed' then 'The case is closed'
            when 'cancelled' then 'The case is cancelled'
            else 'The case is not ready to be sent' end
            using errcode = '55000';
    end if;
    select r.* into o_report from public.reports r where r.case_id = p_case_id order by r.version desc limit 1;
    if o_report.id is null then
        raise exception 'Generate a report version first' using errcode = '55000';
    end if;
    select t.* into v_tpl from public.case_templates t where t.id = v_case.template_id;
    if v_tpl.id is not null then
        if v_tpl.requires_approval and not exists (
            select 1 from public.report_approvals a where a.report_id = o_report.id and a.decision = 'approved') then
            raise exception 'This report needs approval before it is sent' using errcode = '42501';
        end if;
        if not (p_formats <@ v_tpl.output_formats) then
            raise exception 'Format not allowed for this insurer template' using errcode = '23514';
        end if;
    end if;
    foreach f in array p_formats loop
        if not exists (select 1 from public.report_files rf where rf.report_id = o_report.id and rf.format = f) then
            raise exception 'The % file of this report version has not been generated', upper(f) using errcode = '55000';
        end if;
    end loop;
    return o_report;
end $$;
revoke all on function private.report_ready_to_send(uuid, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Staff: queue a send
-- ---------------------------------------------------------------------
create or replace function private.clean_addresses(p_list text[]) returns public.citext[]
language plpgsql immutable set search_path = '' as $$
declare a text; r public.citext[] := '{}';
begin
    foreach a in array coalesce(p_list, '{}') loop
        a := lower(btrim(a));
        if a = '' then continue; end if;
        if a !~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(a) > 254 then
            raise exception 'Not a valid email address: %', left(a, 60) using errcode = '22023';
        end if;
        if not (a::public.citext = any (r)) then r := r || a::public.citext; end if;
    end loop;
    return r;
end $$;

create or replace function public.request_report_send(p_case_id uuid, p_formats text[], p_to text[], p_cc text[],
                                                       p_subject text, p_body text, p_attachment_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_report public.reports;
    v_t      record;
    v_to     public.citext[];
    v_cc     public.citext[];
    v_name   text := regexp_replace(btrim(coalesce(p_attachment_name, '')), '[\\/:*?"<>|\r\n]+', '_', 'g');
    v_id     uuid;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can send reports' using errcode = '42501';
    end if;
    perform 1 from public.cases c where c.id = p_case_id for update;
    if not found then
        raise exception 'Case not found' using errcode = 'P0002';
    end if;
    if not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can send the report' using errcode = '42501';
    end if;
    if p_formats is null or cardinality(p_formats) = 0 or cardinality(p_formats) <> (select count(distinct f) from unnest(p_formats) f) then
        raise exception 'Choose the formats to send' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(p_subject, ''))) not between 1 and 300 or char_length(btrim(coalesce(p_body, ''))) not between 1 and 5000
       or char_length(v_name) not between 1 and 100 then
        raise exception 'Subject (1–300), message (1–5000) and file name (1–100 characters) are required' using errcode = '22023';
    end if;
    select * into v_t from public.report_send_target(p_case_id);
    if v_t.email_id is null then
        raise exception 'There is no insurer email on this case to reply to. Record the delivery by hand instead' using errcode = '55000';
    end if;
    v_to := private.clean_addresses(coalesce(p_to, v_t.to_addresses));
    v_cc := private.clean_addresses(coalesce(p_cc, v_t.cc_addresses));
    v_cc := coalesce((select array_agg(a) from unnest(v_cc) a where a <> all (v_to)), '{}');
    if cardinality(v_to) = 0 or cardinality(v_to) + cardinality(v_cc) > 30 then
        raise exception 'Add at least one recipient, and at most 30 in all' using errcode = '22023';
    end if;
    v_report := private.report_ready_to_send(p_case_id, p_formats);
    if exists (select 1 from public.report_sends s where s.report_id = v_report.id and s.status in ('queued', 'sending', 'unknown')) then
        raise exception 'This report is already being sent or waits for a decision on an earlier attempt' using errcode = '55000';
    end if;
    insert into public.report_sends (case_id, report_id, formats, to_addresses, cc_addresses, subject, body, attachment_name,
                                     in_reply_to, references_ids, gmail_thread_id, source_email_id)
    values (p_case_id, v_report.id, p_formats, v_to, v_cc, btrim(p_subject), btrim(p_body), v_name,
            v_t.in_reply_to, v_t.references_ids, v_t.gmail_thread_id, v_t.email_id)
    returning id into v_id;
    return v_id;
end $$;
revoke all on function public.request_report_send(uuid, text[], text[], text[], text, text, text) from public, anon;
grant execute on function public.request_report_send(uuid, text[], text[], text[], text, text, text) to authenticated;

create or replace function public.retry_report_send(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can send reports' using errcode = '42501';
    end if;
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found or not private.can_manage_case(v.case_id) then
        raise exception 'Send not found' using errcode = 'P0002';
    end if;
    if v.status <> 'failed' then
        raise exception 'Only a send that failed can be retried' using errcode = '55000';
    end if;
    perform private.report_ready_to_send(v.case_id, v.formats);
    if (select r.id from public.reports r where r.case_id = v.case_id order by r.version desc limit 1) <> v.report_id then
        raise exception 'A newer report version exists. Start a new send' using errcode = '55000';
    end if;
    update public.report_sends set status = 'queued', error = null where id = p_id;
end $$;
revoke all on function public.retry_report_send(uuid) from public, anon;
grant execute on function public.retry_report_send(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Recording the result (shared by the sender and a staff decision on an unknown outcome)
-- ---------------------------------------------------------------------
create or replace function private.finish_report_send(p_id uuid, p_sent_at timestamptz, p_delivery text,
                                                      p_link_expires timestamptz, p_pack_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v   public.report_sends;
    v_s uuid;
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if v.status = 'sent' then
        return v.submission_id;
    end if;
    insert into public.submissions (case_id, report_id, channel, submitted_at, submitted_by, formats, to_addresses, cc_addresses,
                                    sent_message_id, gmail_thread_id, notes)
    values (v.case_id, v.report_id, 'email', least(coalesce(p_sent_at, now()), now()), v.requested_by, v.formats,
            v.to_addresses, v.cc_addresses, v.message_id, v.gmail_thread_id,
            case when p_delivery = 'link' then 'Annexures sent as a secure link' else null end)
    returning id into v_s;
    update public.report_sends
       set status = 'sent', sent_at = least(coalesce(p_sent_at, now()), now()), delivery = p_delivery,
           link_expires_at = p_link_expires, pack_path = p_pack_path, error = null, submission_id = v_s
     where id = p_id;
    return v_s;
end $$;
revoke all on function private.finish_report_send(uuid, timestamptz, text, timestamptz, text) from public, anon, authenticated;

create or replace function public.resolve_report_send(p_id uuid, p_was_sent boolean, p_sent_at timestamptz default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can settle a send' using errcode = '42501';
    end if;
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found or not private.can_manage_case(v.case_id) then
        raise exception 'Send not found' using errcode = 'P0002';
    end if;
    if v.status <> 'unknown' then
        raise exception 'Only a send with an unknown outcome can be settled' using errcode = '55000';
    end if;
    if p_was_sent then
        perform private.finish_report_send(p_id, p_sent_at, v.delivery, v.link_expires_at, v.pack_path);
    else
        update public.report_sends set status = 'failed', error = 'Checked in the Sent folder: the mail was not sent' where id = p_id;
    end if;
end $$;
revoke all on function public.resolve_report_send(uuid, boolean, timestamptz) from public, anon;
grant execute on function public.resolve_report_send(uuid, boolean, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- Service: claim / complete / fail
-- ---------------------------------------------------------------------
create or replace function public.claim_report_send(p_id uuid, p_message_id text)
returns table (id uuid, case_id uuid, report_id uuid, formats text[], to_addresses text[], cc_addresses text[], subject text,
               body text, attachment_name text, in_reply_to text, references_ids text[], message_id text, case_ref text)
language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found then
        return;
    end if;
    -- a claim that was never finished: the outcome is not certain, so it is never sent again by itself
    if v.status = 'sending' and v.claimed_at < now() - make_interval(mins => private.setting_int('send_lease_minutes', 10)) then
        update public.report_sends set status = 'unknown', error = 'The sender stopped before it could report the outcome' where report_sends.id = p_id;
        perform private.notify(v.requested_by, 'report_send_unknown', v.case_id, 'Check the Sent folder: report email outcome unknown',
                               null, 'send_unknown:' || p_id);
        return;
    end if;
    if v.status <> 'queued' then
        return;
    end if;
    if p_message_id is null or p_message_id !~ '^<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+>$' then
        raise exception 'Invalid Message-ID' using errcode = '22023';
    end if;
    update public.report_sends
       set status = 'sending', attempts = attempts + 1, claimed_at = now(), message_id = coalesce(report_sends.message_id, p_message_id)
     where report_sends.id = p_id;
    return query
        select s.id, s.case_id, s.report_id, s.formats, s.to_addresses::text[], s.cc_addresses::text[], s.subject, s.body,
               s.attachment_name, s.in_reply_to, s.references_ids, s.message_id, c.case_ref
          from public.report_sends s join public.cases c on c.id = s.case_id where s.id = p_id;
end $$;
revoke all on function public.claim_report_send(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_report_send(uuid, text) to service_role;

create or replace function public.complete_report_send(p_id uuid, p_delivery text, p_link_expires timestamptz, p_pack_path text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found or v.status not in ('sending', 'unknown', 'sent') then
        raise exception 'Send is not in progress' using errcode = '55000';
    end if;
    if p_delivery not in ('attached', 'link') then
        raise exception 'Invalid delivery' using errcode = '22023';
    end if;
    return private.finish_report_send(p_id, now(), p_delivery, p_link_expires, p_pack_path);
end $$;
revoke all on function public.complete_report_send(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_report_send(uuid, text, timestamptz, text) to service_role;

create or replace function public.fail_report_send(p_id uuid, p_error text, p_ambiguous boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found or v.status <> 'sending' then
        return;
    end if;
    update public.report_sends
       set status = case when p_ambiguous then 'unknown' else 'failed' end, error = left(coalesce(p_error, 'Unknown error'), 500)
     where id = p_id;
    perform private.notify(v.requested_by, case when p_ambiguous then 'report_send_unknown' else 'report_send_failed' end, v.case_id,
                           case when p_ambiguous then 'Check the Sent folder: report email outcome unknown'
                                else 'The report email was not sent' end,
                           left(coalesce(p_error, ''), 300), 'send_failed:' || p_id || ':' || v.attempts);
end $$;
revoke all on function public.fail_report_send(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fail_report_send(uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------
-- Portal pack: checked and audited like a send, nothing is recorded as sent
-- ---------------------------------------------------------------------
create or replace function public.request_portal_pack(p_case_id uuid, p_formats text[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_report public.reports;
begin
    if not public.is_staff() or not private.can_manage_case(p_case_id) then
        raise exception 'Only the case owner, an orchestrator or an admin can build the portal pack' using errcode = '42501';
    end if;
    if p_formats is null or cardinality(p_formats) = 0 then
        raise exception 'Choose the formats for the pack' using errcode = '22023';
    end if;
    v_report := private.report_ready_to_send(p_case_id, p_formats);
    insert into public.audit_log (actor_id, action, table_name, record_id, new_data)
    values ((select auth.uid()), 'PORTAL_PACK', 'reports', v_report.id, jsonb_build_object('case_id', p_case_id, 'formats', p_formats));
    return v_report.id;
end $$;
revoke all on function public.request_portal_pack(uuid, text[]) from public, anon;
grant execute on function public.request_portal_pack(uuid, text[]) to authenticated;
