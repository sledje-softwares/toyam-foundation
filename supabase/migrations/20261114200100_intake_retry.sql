-- =====================================================================
-- Queued intake retry (D39), part 2 of 2.
--
-- A failed email is never deleted. Staff queue it; the intake Worker's 10-minute cron
-- claims the queue and posts each email id to the `intake` edge function (which holds the
-- service-role key and the intake secret; the web app holds neither). The retried email
-- ends ingested (processed / ignored) or failed again with retry_attempts incremented.
-- Retries still waiting after 60 min, or failed again, alert orchestrators and admins
-- in-app once; the Worker also sends one alert email to the shared inbox.
--
--   request_intake_retry(email)      staff: failed → retry_requested (who / when, audited)
--   intake_retry(email)              kept for compatibility: same as request_intake_retry,
--                                    returns the raw path; deletes nothing any more
--   claim_intake_retries(limit)      service: lease queued retries (FOR UPDATE SKIP LOCKED)
--   intake_ingest(decision)          service: + decision.retry_email_id re-uses the queued row
--   intake_retry_failed(email, err)  service: queued retry failed → failed, attempts + 1
--   escalate_stuck_intake_retries()  service: in-app alerts once; returns emails to mail about
-- =====================================================================

alter table public.emails
    add column retry_requested_at timestamptz,
    add column retry_requested_by uuid references public.profiles(id),
    add column retry_attempts     int not null default 0 check (retry_attempts >= 0),
    add column retry_claimed_at   timestamptz,
    add column retry_alerted_at   timestamptz;
create index ix_emails_retry_queue on public.emails (retry_requested_at) where status = 'retry_requested';
comment on column public.emails.retry_attempts   is 'Completed queued retries (D39), incremented whatever the outcome';
comment on column public.emails.retry_claimed_at is 'Lease taken by claim_intake_retries(); a stale lease is claimed again';
comment on column public.emails.retry_alerted_at is 'Stuck / failed-again alert sent for the current retry request';

insert into public.app_settings (key, value, description) values
    ('intake_retry_alert_minutes', '60', 'Alert orchestrators and admins when a queued intake retry waits this long (D39)'),
    ('intake_retry_lease_minutes', '15', 'A claimed intake retry not finished within this time is claimed again')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Audit (emails carry no audit trigger: bodies are large; retry steps are logged explicitly)
-- ---------------------------------------------------------------------
create or replace function private.audit_email_retry(p_email uuid, p_action text, p_old jsonb, p_new jsonb) returns void
language sql security definer set search_path = '' as $$
    insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
    values (auth.uid(), p_action, 'emails', p_email, p_old, p_new);
$$;

-- ---------------------------------------------------------------------
-- Staff: queue a failed email
-- ---------------------------------------------------------------------
create or replace function public.request_intake_retry(p_email_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_row public.emails;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can retry intake' using errcode = '42501';
    end if;
    select * into v_row from public.emails e where e.id = p_email_id for update;
    if not found or v_row.status <> 'failed' or v_row.case_id is not null then
        raise exception 'Only failed emails can be retried' using errcode = '22023';
    end if;
    if v_row.raw_storage_path is null then
        raise exception 'The raw message was not stored; it cannot be retried' using errcode = '22023';
    end if;
    update public.emails
       set status = 'retry_requested', retry_requested_at = now(), retry_requested_by = (select auth.uid()),
           retry_claimed_at = null, retry_alerted_at = null
     where id = p_email_id;
    perform private.audit_email_retry(p_email_id, 'RETRY_REQUESTED',
        jsonb_build_object('status', v_row.status, 'error', v_row.error, 'retry_attempts', v_row.retry_attempts),
        jsonb_build_object('status', 'retry_requested'));
    return now();
end $$;

-- Compatibility (3.10 first cut): no longer deletes; queues like request_intake_retry
create or replace function public.intake_retry(p_email_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
    perform public.request_intake_retry(p_email_id);
    select e.raw_storage_path into v_path from public.emails e where e.id = p_email_id;
    return v_path;
end $$;

-- ---------------------------------------------------------------------
-- Service: claim, fail, escalate
-- ---------------------------------------------------------------------
create or replace function public.claim_intake_retries(p_limit int default 10)
returns table (id uuid, raw_storage_path text)
language sql security definer set search_path = '' as $$
    with c as (
        select e.id from public.emails e
         where e.status = 'retry_requested'
           and (e.retry_claimed_at is null
                or e.retry_claimed_at < now() - make_interval(mins => private.setting_int('intake_retry_lease_minutes', 15)))
         order by e.retry_requested_at, e.id
         limit greatest(1, least(coalesce(p_limit, 10), 100))
         for update skip locked)
    update public.emails e set retry_claimed_at = now()
      from c where e.id = c.id
    returning e.id, e.raw_storage_path;
$$;

create or replace function public.intake_retry_failed(p_email_id uuid, p_error text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_row public.emails;
begin
    select * into v_row from public.emails e where e.id = p_email_id and e.status = 'retry_requested' for update;
    if not found then
        return false;
    end if;
    update public.emails
       set status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'Retry failed'), 2000),
           retry_attempts = retry_attempts + 1, retry_claimed_at = null
     where id = p_email_id;
    perform private.audit_email_retry(p_email_id, 'RETRY_FAILED',
        jsonb_build_object('status', v_row.status, 'error', v_row.error, 'retry_attempts', v_row.retry_attempts),
        jsonb_build_object('status', 'failed', 'error', left(p_error, 2000), 'retry_attempts', v_row.retry_attempts + 1));
    return true;
end $$;

-- Run by the Worker's 10-minute cron. One in-app alert per active orchestrator and admin,
-- once per retry request (retry_alerted_at); the rows returned get one alert email.
create or replace function public.escalate_stuck_intake_retries()
returns table (email_id uuid, from_address text, subject text, received_at timestamptz,
               email_status public.email_status, retry_attempts int, retry_requested_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare r record;
begin
    for r in select e.id, e.from_address, e.subject, e.received_at, e.status, e.retry_attempts, e.retry_requested_at
               from public.emails e
              where e.retry_alerted_at is null
                and ((e.status = 'retry_requested'
                      and e.retry_requested_at <= now() - make_interval(mins => private.setting_int('intake_retry_alert_minutes', 60)))
                     or (e.status = 'failed' and e.retry_attempts > 0))
              order by e.retry_requested_at, e.id
              for update of e skip locked
    loop
        insert into public.notifications (user_id, kind, case_id, title, body, dedupe_key)
        select p.id, 'intake_retry_stuck', null,
               case when r.status = 'failed' then 'Intake retry failed again: ' else 'Intake retry not done after an hour: ' end
                   || coalesce(r.subject, '(no subject)'),
               'From ' || r.from_address || ' · attempts ' || r.retry_attempts || ' · /intake/failed',
               'intake_retry:' || r.id
          from public.profiles p
         where p.is_active and p.role in ('orchestrator', 'admin')
        on conflict (user_id, dedupe_key) where dedupe_key is not null and read_at is null do nothing;
        update public.emails set retry_alerted_at = now() where id = r.id;
        email_id := r.id; from_address := r.from_address; subject := r.subject; received_at := r.received_at;
        email_status := r.status; retry_attempts := r.retry_attempts; retry_requested_at := r.retry_requested_at;
        return next;
    end loop;
end $$;

-- ---------------------------------------------------------------------
-- Ingest: unchanged except the retry branch (decision.retry_email_id)
-- ---------------------------------------------------------------------
create or replace function public.intake_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_email     uuid;
    v_case      uuid;
    v_existing  uuid;
    v_created   boolean;
    v_action    text := coalesce(p->>'action', 'review');
    v_insurer   uuid := nullif(p->>'insurer_id', '')::uuid;
    v_template  uuid := nullif(p->>'template_id', '')::uuid;
    v_claim     text := nullif(btrim(coalesce(p->>'claim_no', '')), '');
    v_class     public.email_classification := coalesce(nullif(p->>'classification', ''), 'other')::public.email_classification;
    v_result    text;
    v_refs      text[] := coalesce(array(select jsonb_array_elements_text(p->'references')), '{}');
    v_missing   text[] := coalesce(array(select jsonb_array_elements_text(p->'missing_required')), '{}');
    v_values    jsonb := coalesce(p->'fields', '{}');
    v_owner     uuid;
    v_ref       text;
    a           jsonb;
    v_retry     uuid := nullif(p->>'retry_email_id', '')::uuid;   -- D39: queued retry of a failed row
    v_row       public.emails;
begin
    -- Access: EXECUTE is granted to service_role only (a definer cannot test current_user).
    if nullif(p->>'message_id', '') is null then
        raise exception 'message_id is required' using errcode = '22023';
    end if;

    -- 1. idempotency on Message-ID; a queued retry (D39) re-uses its own row, which never vanishes
    select e.id, e.case_id into v_email, v_case from public.emails e
     where e.gmail_message_id = p->>'message_id' and e.id is distinct from v_retry;
    if v_retry is not null then
        select * into v_row from public.emails e where e.id = v_retry for update;
        if not found or v_row.status <> 'retry_requested' then
            raise exception 'Email is not queued for retry' using errcode = '22023';
        end if;
        if v_email is not null then
            -- the same message was ingested meanwhile (delivered again): close the retried row, keep it
            update public.emails
               set status = 'ignored', error = 'Duplicate: the same message was received again',
                   retry_attempts = retry_attempts + 1, retry_claimed_at = null, processed_at = now()
             where id = v_retry;
            perform private.audit_email_retry(v_retry, 'RETRY_DUPLICATE',
                jsonb_build_object('status', v_row.status, 'retry_attempts', v_row.retry_attempts),
                jsonb_build_object('status', 'ignored', 'duplicate_of', v_email));
            return jsonb_build_object('email_id', v_email, 'case_id', v_case, 'result', 'duplicate', 'retry_email_id', v_retry);
        end if;
    elsif v_email is not null then
        return jsonb_build_object('email_id', v_email, 'case_id', v_case, 'result', 'duplicate');
    end if;

    if v_template is not null and not exists (select 1 from public.case_templates t where t.id = v_template and t.is_active) then
        v_template := null;
        if v_action = 'create_case' then v_action := 'review'; end if;
    end if;

    if v_retry is not null then
        update public.emails e
           set gmail_message_id = p->>'message_id', gmail_thread_id = coalesce(nullif(p->>'thread_id', ''), e.gmail_thread_id),
               in_reply_to = nullif(p->>'in_reply_to', ''), references_ids = v_refs,
               from_address = coalesce(nullif(p->>'from_address', ''), e.from_address), from_name = nullif(p->>'from_name', ''),
               to_addresses = coalesce(array(select jsonb_array_elements_text(p->'to'))::public.citext[], '{}'),
               cc_addresses = coalesce(array(select jsonb_array_elements_text(p->'cc'))::public.citext[], '{}'),
               subject = p->>'subject', body_text = left(p->>'body_text', 100000),
               received_at = coalesce((p->>'received_at')::timestamptz, e.received_at),
               raw_storage_path = coalesce(nullif(p->>'raw_storage_path', ''), e.raw_storage_path),
               raw_sha256 = coalesce(nullif(p->>'raw_sha256', ''), e.raw_sha256),
               classification = v_class, status = 'processing', insurer_id = v_insurer, template_id = v_template,
               is_internal = coalesce((p->>'is_internal')::boolean, false), parser_version = p->>'parser_version',
               parse_notes = coalesce(array(select jsonb_array_elements_text(p->'notes')), '{}'),
               error = null, retry_attempts = e.retry_attempts + 1, retry_claimed_at = null
         where e.id = v_retry
        returning e.id into v_email;
        perform private.audit_email_retry(v_email, 'RETRY_REPROCESSED',
            jsonb_build_object('status', v_row.status, 'error', v_row.error, 'retry_attempts', v_row.retry_attempts),
            jsonb_build_object('status', 'processing', 'message_id', p->>'message_id', 'retry_attempts', v_row.retry_attempts + 1));
    else
        insert into public.emails (gmail_message_id, gmail_thread_id, in_reply_to, references_ids, from_address, from_name,
                                   to_addresses, cc_addresses, subject, body_text, received_at, raw_storage_path, raw_sha256,
                                   classification, status, insurer_id, template_id, is_internal, parser_version, parse_notes)
        values (p->>'message_id', nullif(p->>'thread_id', ''), nullif(p->>'in_reply_to', ''), v_refs,
                coalesce(p->>'from_address', ''), nullif(p->>'from_name', ''),
                coalesce(array(select jsonb_array_elements_text(p->'to'))::public.citext[], '{}'),
                coalesce(array(select jsonb_array_elements_text(p->'cc'))::public.citext[], '{}'),
                p->>'subject', left(p->>'body_text', 100000),
                coalesce((p->>'received_at')::timestamptz, now()),
                nullif(p->>'raw_storage_path', ''), nullif(p->>'raw_sha256', ''),
                v_class, 'processing', v_insurer, v_template, coalesce((p->>'is_internal')::boolean, false),
                p->>'parser_version', coalesce(array(select jsonb_array_elements_text(p->'notes')), '{}'))
        returning id into v_email;
    end if;

    -- 2. attachments that were stored
    for a in select * from jsonb_array_elements(coalesce(p->'attachments', '[]')) loop
        if nullif(a->>'storage_path', '') is null or nullif(a->>'sha256', '') is null then
            continue;
        end if;
        insert into public.email_attachments (email_id, filename, mime_type, size_bytes, storage_path, sha256,
                                              content_id, is_inline, is_evidence)
        values (v_email, coalesce(nullif(a->>'filename', ''), 'attachment'), a->>'mime_type', (a->>'size_bytes')::bigint,
                a->>'storage_path', a->>'sha256', nullif(a->>'content_id', ''),
                coalesce((a->>'is_inline')::boolean, false), coalesce((a->>'evidence')::boolean, false));
    end loop;

    -- 3. related case: same Gmail thread or reply chain, then insurer + claim no.
    select e.case_id into v_existing
      from public.emails e
     where e.case_id is not null and e.id <> v_email
       and ((nullif(p->>'thread_id', '') is not null and e.gmail_thread_id = p->>'thread_id')
            or e.gmail_message_id = p->>'in_reply_to'
            or e.gmail_message_id = any (v_refs))
     order by e.received_at desc
     limit 1;
    if v_existing is null and v_insurer is not null and v_claim is not null then
        select c.id into v_existing from public.cases c where c.insurer_id = v_insurer and c.insurer_claim_no = v_claim;
    end if;

    if coalesce((p->>'is_internal')::boolean, false) then
        -- the firm's own mail: keep it on the case history, nothing else
        v_case := v_existing; v_class := 'other';
        v_result := case when v_existing is null then 'internal' else 'internal_linked' end;
    elsif v_action = 'unmatched' then
        update public.emails set status = 'ignored', classification = 'other', processed_at = now() where id = v_email;
        return jsonb_build_object('email_id', v_email, 'case_id', null, 'result', 'unmatched');
    elsif v_existing is not null then
        v_case := v_existing;
        if v_class = 'new_case' then v_class := 'other'; end if;     -- intimation re-sent for an existing claim
        perform private.add_email_evidence(v_email, v_case);
        select c.office_owner_id, c.case_ref into v_owner, v_ref from public.cases c where c.id = v_case;
        if v_owner is not null then
            perform private.notify(v_owner, 'insurer_email', v_case,
                coalesce(v_ref, '') || ': insurer email — ' || coalesce(p->>'subject', ''), null, 'email:' || v_email);
        end if;
        v_result := 'attached';
    elsif v_action = 'create_case' and v_template is not null and v_claim is not null and cardinality(v_missing) = 0 then
        select r.case_id, r.created into v_case, v_created
          from private.create_case_from_intake(v_email, v_template, v_claim, v_values,
                                                (p->>'received_at')::timestamptz, 'email_parser') r;
        insert into public.intake_extractions (email_id, case_id, model, extracted, field_confidence, status,
                                               template_id, missing_required, parser_action)
        values (v_email, v_case, coalesce(p->>'parser_version', 'rules'),
                coalesce((select jsonb_object_agg(k, v->>'value') from jsonb_each(v_values) x(k, v)), '{}'),
                coalesce((select jsonb_object_agg(k, (v->>'confidence')::real) from jsonb_each(v_values) x(k, v)), '{}'),
                'confirmed', v_template, v_missing, v_action);
        perform private.add_email_evidence(v_email, v_case);
        v_result := case when v_created then 'created' else 'attached' end;
    else
        -- review queue: unknown variant, missing fields, reply without a known case, AI fallback output
        insert into public.intake_extractions (email_id, model, extracted, field_confidence, status,
                                               template_id, missing_required, parser_action)
        values (v_email, coalesce(p->>'parser_version', 'rules'),
                coalesce((select jsonb_object_agg(k, v->>'value') from jsonb_each(v_values) x(k, v)), '{}'),
                coalesce((select jsonb_object_agg(k, (v->>'confidence')::real) from jsonb_each(v_values) x(k, v)), '{}'),
                'pending_review', v_template, v_missing, v_action);
        perform private.notify_orchestrators('intake_review', null,
            'Email needs review: ' || coalesce(p->>'subject', '(no subject)'),
            array_to_string(coalesce(array(select jsonb_array_elements_text(p->'notes')), '{}'), ' · '),
            'intake:' || v_email);
        v_result := 'review';
    end if;

    update public.emails
       set case_id = v_case, classification = v_class, status = 'processed', processed_at = now()
     where id = v_email;
    return jsonb_build_object('email_id', v_email, 'case_id', v_case, 'result', v_result);
end $$;

-- ---------------------------------------------------------------------
-- Privileges (intake_ingest keeps its grants: create or replace)
-- ---------------------------------------------------------------------
revoke all on function private.audit_email_retry(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.request_intake_retry(uuid) from public, anon;
grant  execute on function public.request_intake_retry(uuid) to authenticated, service_role;
revoke execute on function public.claim_intake_retries(int), public.intake_retry_failed(uuid, text),
                           public.escalate_stuck_intake_retries() from public, anon, authenticated;
grant  execute on function public.claim_intake_retries(int), public.intake_retry_failed(uuid, text),
                           public.escalate_stuck_intake_retries() to service_role;
