-- =====================================================================
-- M3 Email intake (docs/05 "Intake pipeline", D12, D24-D26)
--
-- The edge function `intake` decodes a raw message, runs the rule-based parser
-- (supabase/functions/_shared/intake) against public.intake_config(), stores the raw
-- message and attachments in the email-raw bucket and calls public.intake_ingest(decision).
--
--   intake_config()            insurers, active templates (intake fields only), firm addresses
--   intake_ingest(jsonb)       one transaction per email; idempotent on Message-ID:
--                              internal / unmatched / follow-up (thread or claim no.) /
--                              new case (rules complete) / review queue
--   confirm_intake(...)        staff create a case from a review-queue item
--   reject_intake(...)         staff dismiss a review-queue item
--   intake_record_failure(...) service: parsing failed, keep a visible failed row (3.10)
--   intake_retry(email)        staff: clear a failed row; returns the raw path to re-process
-- Insurer attachments flagged as evidence become case evidence
-- (capture_source = email_attachment, storage_backend = supabase, bucket email-raw).
-- =====================================================================

alter table public.emails
    add column in_reply_to     text,
    add column references_ids  text[]   not null default '{}',
    add column cc_addresses    citext[] not null default '{}',
    add column from_name       text,
    add column is_internal     boolean  not null default false,
    add column raw_sha256      text check (raw_sha256 is null or raw_sha256 ~ '^[0-9a-f]{64}$'),
    add column template_id     uuid references public.case_templates(id),
    add column parser_version  text,
    add column parse_notes     text[]   not null default '{}';
create index ix_emails_in_reply_to on public.emails (in_reply_to);
comment on column public.emails.gmail_message_id is 'Message-ID header without <> (idempotency key); gmail-<X-GM-MSGID> when the header is missing';

alter table public.email_attachments
    add column content_id  text,
    add column is_inline   boolean not null default false,
    add column is_evidence boolean not null default false;

alter table public.intake_extractions
    add column template_id      uuid references public.case_templates(id),
    add column missing_required text[] not null default '{}',
    add column parser_action    text,
    add column reject_reason    text;

insert into public.app_settings (key, value, description) values
    ('internal_email_domains',   '["toyaminvestigation.in"]',
     'Mail from these domains is the firm''s own and never creates a case'),
    ('internal_email_addresses', '["toyaminvestigation@gmail.com"]',
     'Mail from these addresses is the firm''s own and never creates a case')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Configuration for the parser
-- ---------------------------------------------------------------------
create or replace function public.intake_config() returns jsonb
language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'internal_domains',   coalesce((select s.value from public.app_settings s where s.key = 'internal_email_domains'), '[]'),
        'internal_addresses', coalesce((select s.value from public.app_settings s where s.key = 'internal_email_addresses'), '[]'),
        'insurers', coalesce((
            select jsonb_agg(jsonb_build_object('id', i.id, 'code', i.code, 'name', i.name,
                                                'domains', to_jsonb(i.sender_domains::text[])) order by i.code)
              from public.insurers i where i.is_active), '[]'),
        'templates', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', t.id, 'insurer_id', t.insurer_id, 'insurer_code', i.code,
                       'claim_type', t.claim_type, 'variant', t.variant, 'version', t.version,
                       'intake_rules', t.intake_rules,
                       'fields', coalesce((
                           select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.field_type,
                                                               'required', f.is_required, 'extract', f.extract)
                                            order by s.position, f.position)
                             from public.case_template_fields f
                             join public.case_template_sections s on s.id = f.section_id
                            where f.template_id = t.id and f.source = 'intake'), '[]'))
                   order by i.code, t.claim_type, t.variant)
              from public.case_templates t join public.insurers i on i.id = t.insurer_id
             where t.is_active and i.is_active), '[]'));
$$;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- Insurer attachments marked as evidence → case evidence (once per file and case)
create or replace function private.add_email_evidence(p_email_id uuid, p_case_id uuid) returns int
language sql security definer set search_path = '' as $$
    with ins as (
        insert into public.evidence (case_id, evidence_type, capture_source, storage_backend, storage_path,
                                     mime_type, size_bytes, sha256, original_filename, email_attachment_id, captured_by)
        select p_case_id,
               case when a.mime_type like 'image/%' then 'photo'
                    when a.mime_type like 'audio/%' then 'audio'
                    when a.mime_type like 'video/%' then 'video'
                    else 'document' end::public.evidence_type,
               'email_attachment', 'supabase', a.storage_path, a.mime_type, a.size_bytes, a.sha256, a.filename, a.id, null
          from public.email_attachments a
         where a.email_id = p_email_id and a.is_evidence
        on conflict (case_id, sha256) where sha256 is not null do nothing
        returning 1)
    select count(*)::int from ins;
$$;

-- Creates a case from intake values {key: {value, confidence, source}}; returns the case id.
-- If the claim already exists (race or re-sent intimation) the existing case is returned.
create or replace function private.create_case_from_intake(
    p_email_id uuid, p_template_id uuid, p_claim_no text, p_values jsonb, p_received_at timestamptz,
    p_value_source public.field_value_source, out case_id uuid, out created boolean)
language plpgsql security definer set search_path = '' as $$
declare
    v_tpl   public.case_templates;
    v_val   text;
    v_name  text;
begin
    select * into v_tpl from public.case_templates t where t.id = p_template_id;
    if not found then
        raise exception 'Template not found' using errcode = 'P0002';
    end if;
    select c.id into case_id from public.cases c where c.insurer_id = v_tpl.insurer_id and c.insurer_claim_no = p_claim_no;
    if case_id is not null then
        created := false;
        return;
    end if;
    begin
        insert into public.cases (insurer_id, insurer_claim_no, policy_no, claim_type, suspicion_summary, received_at, template_id)
        values (v_tpl.insurer_id, p_claim_no,
                nullif(btrim(p_values #>> '{policy_no,value}'), ''),
                v_tpl.claim_type,
                left(coalesce(p_values #>> '{investigation_points,value}', ''), 4000),
                coalesce(p_received_at, now()), v_tpl.id)
        returning id into case_id;
        created := true;
    exception when unique_violation then
        select c.id into case_id from public.cases c where c.insurer_id = v_tpl.insurer_id and c.insurer_claim_no = p_claim_no;
        created := false;
        return;
    end;

    insert into public.case_field_values (case_id, field_id, value, source, confidence)
    select case_id, f.id, btrim(p_values -> f.key ->> 'value'), p_value_source,
           least(greatest(coalesce((p_values -> f.key ->> 'confidence')::real, 1), 0), 1)
      from public.case_template_fields f
     where f.template_id = v_tpl.id and f.source = 'intake'
       and nullif(btrim(p_values -> f.key ->> 'value'), '') is not null;

    v_name := nullif(btrim(coalesce(p_values #>> '{insured_name,value}', '')), '');
    if v_name is not null then
        insert into public.parties (case_id, role, name, phone, address)
        values (case_id, 'insured', v_name,
                nullif(btrim(coalesce(p_values #>> '{insured_mobile,value}', '')), ''),
                nullif(btrim(coalesce(p_values #>> '{policy_address,value}', p_values #>> '{insured_actual_address,value}', '')), ''));
    end if;
    v_val := nullif(btrim(coalesce(p_values #>> '{driver_name,value}', '')), '');
    if v_val is not null and v_val is distinct from v_name then
        insert into public.parties (case_id, role, name) values (case_id, 'driver', v_val);
    end if;
end $$;

-- ---------------------------------------------------------------------
-- Ingest (service role only)
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
begin
    -- Access: EXECUTE is granted to service_role only (a definer cannot test current_user).
    if nullif(p->>'message_id', '') is null then
        raise exception 'message_id is required' using errcode = '22023';
    end if;

    -- 1. idempotency
    select e.id, e.case_id into v_email, v_case from public.emails e where e.gmail_message_id = p->>'message_id';
    if v_email is not null then
        return jsonb_build_object('email_id', v_email, 'case_id', v_case, 'result', 'duplicate');
    end if;

    if v_template is not null and not exists (select 1 from public.case_templates t where t.id = v_template and t.is_active) then
        v_template := null;
        if v_action = 'create_case' then v_action := 'review'; end if;
    end if;

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

-- Parsing failed: keep a visible record (raw message already stored) so it can be retried (3.10)
create or replace function public.intake_record_failure(p_message_id text, p_raw_storage_path text,
                                                        p_error text, p_subject text default null,
                                                        p_from text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    insert into public.emails (gmail_message_id, from_address, subject, received_at, raw_storage_path, status, error)
    values (p_message_id, coalesce(nullif(p_from, ''), 'unknown'), p_subject, now(), p_raw_storage_path, 'failed', left(p_error, 2000))
    on conflict (gmail_message_id) do update
        set error = excluded.error, raw_storage_path = coalesce(public.emails.raw_storage_path, excluded.raw_storage_path)
        where public.emails.status = 'failed'
    returning id into v_id;
    return v_id;
end $$;

-- Retry: a failed email row is removed so the next ingest of the same message is not a duplicate
create or replace function public.intake_retry(p_email_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can retry intake' using errcode = '42501';
    end if;
    delete from public.emails e where e.id = p_email_id and e.status = 'failed' and e.case_id is null
    returning e.raw_storage_path into v_path;
    if v_path is null then
        raise exception 'Only failed emails can be retried' using errcode = '22023';
    end if;
    return v_path;   -- the intake service re-reads the raw message from this path
end $$;

-- ---------------------------------------------------------------------
-- Review queue actions (office staff)
-- ---------------------------------------------------------------------
-- p_values: {field_key: value} as corrected on the review screen
create or replace function public.confirm_intake(p_extraction_id uuid, p_template_id uuid, p_values jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_ext    public.intake_extractions;
    v_email  public.emails;
    v_vals   jsonb;
    v_claim  text;
    v_case   uuid;
    v_tpl    public.case_templates;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can confirm intake' using errcode = '42501';
    end if;
    select * into v_ext from public.intake_extractions x where x.id = p_extraction_id for update;
    if not found or v_ext.status <> 'pending_review' then
        raise exception 'Nothing to confirm' using errcode = 'P0002';
    end if;
    select * into v_tpl from public.case_templates t where t.id = p_template_id and t.is_active;
    if not found then
        raise exception 'Choose an active template' using errcode = '22023';
    end if;
    select coalesce(jsonb_object_agg(k, jsonb_build_object('value', v #>> '{}', 'confidence', 1)), '{}')
      into v_vals from jsonb_each(coalesce(p_values, '{}')) x(k, v)
     where nullif(btrim(v #>> '{}'), '') is not null;
    v_claim := nullif(btrim(v_vals #>> '{insurer_claim_no,value}'), '');
    if v_claim is null then
        raise exception 'Claim number is required' using errcode = '22023';
    end if;
    if exists (select 1 from public.case_template_fields f
                where f.template_id = v_tpl.id and f.source = 'intake' and f.is_required
                  and nullif(btrim(v_vals -> f.key ->> 'value'), '') is null) then
        raise exception 'Required intake fields are missing' using errcode = '22023';
    end if;
    select * into v_email from public.emails e where e.id = v_ext.email_id;
    select r.case_id into v_case
      from private.create_case_from_intake(v_email.id, v_tpl.id, v_claim, v_vals, v_email.received_at, 'office') r;
    update public.intake_extractions
       set status = 'confirmed', case_id = v_case, reviewed_by = (select auth.uid()), reviewed_at = now(), template_id = v_tpl.id
     where id = v_ext.id;
    update public.emails set case_id = v_case, insurer_id = v_tpl.insurer_id, template_id = v_tpl.id,
                             classification = case when classification = 'other' then 'new_case' else classification end
     where id = v_email.id;
    perform private.add_email_evidence(v_email.id, v_case);
    return v_case;
end $$;

create or replace function public.reject_intake(p_extraction_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_ext public.intake_extractions;
begin
    if not public.is_staff() then
        raise exception 'Only office staff can dismiss intake' using errcode = '42501';
    end if;
    select * into v_ext from public.intake_extractions x where x.id = p_extraction_id for update;
    if not found or v_ext.status <> 'pending_review' then
        raise exception 'Nothing to dismiss' using errcode = 'P0002';
    end if;
    update public.intake_extractions
       set status = 'rejected', reject_reason = nullif(btrim(coalesce(p_reason, '')), ''),
           reviewed_by = (select auth.uid()), reviewed_at = now()
     where id = v_ext.id;
    update public.emails set status = 'ignored' where id = v_ext.email_id and case_id is null;
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
revoke all on function private.add_email_evidence(uuid, uuid) from public, anon, authenticated;
revoke all on function private.create_case_from_intake(uuid, uuid, text, jsonb, timestamptz, public.field_value_source)
    from public, anon, authenticated;
revoke execute on function public.intake_config(), public.intake_ingest(jsonb) from public, anon, authenticated;
grant  execute on function public.intake_config(), public.intake_ingest(jsonb) to service_role;
revoke execute on function public.intake_record_failure(text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.intake_record_failure(text, text, text, text, text) to service_role;
revoke execute on function public.confirm_intake(uuid, uuid, jsonb), public.reject_intake(uuid, text), public.intake_retry(uuid) from public, anon;
grant  execute on function public.confirm_intake(uuid, uuid, jsonb), public.reject_intake(uuid, text), public.intake_retry(uuid) to authenticated, service_role;
