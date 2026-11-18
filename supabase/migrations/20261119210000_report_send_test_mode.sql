-- =====================================================================
-- 8.2 Report sender: test mode (D50 implementation)
--
-- The edge function `report-send` runs in test mode unless SEND_MODE=live: every To / Cc is replaced by
-- one developer address (SEND_TEST_TO), so the insurers on real threads never receive test mail. A test
-- run must never count as delivery to the insurer, so the database (not the function) decides what a
-- finished test run records:
--
--   report_sends.test_recipient   set at the claim when the attempt is a test (the address it went to);
--                                 cleared again by a live claim (a failed test retried after the switch
--                                 to live mode is a live attempt).
--   status 'test_sent'            a finished test run: no submission, the case status is unchanged, a
--                                 staff-only thread message says where the mail went. The report can be
--                                 queued again (test_sent is not an open status).
--   claim_report_send(id, msgid, test_recipient default null)
--                                 replaces the two-argument version (same result columns).
--   finish_report_send            (used by complete_report_send and resolve_report_send) branches on
--                                 test_recipient: an `unknown` test run settled as "sent" is test_sent too.
-- =====================================================================

alter table public.report_sends
    add column test_recipient public.citext
        check (test_recipient is null or test_recipient ~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$');
comment on column public.report_sends.test_recipient is
    'Test-mode attempt (SEND_MODE=test): the only address the mail went to. Set by claim_report_send; a test run never records a submission';

alter table public.report_sends drop constraint report_sends_status_check;
alter table public.report_sends add constraint report_sends_status_check
    check (status in ('queued', 'sending', 'sent', 'failed', 'unknown', 'test_sent'));
alter table public.report_sends add constraint report_sends_test_sent_check
    check (status <> 'test_sent' or (test_recipient is not null and submission_id is null));
comment on column public.report_sends.status is
    'queued → sending → sent | failed (nothing left the building, may be retried) | unknown (outcome not certain; staff settle it) | test_sent (test mode: went to the test address only, nothing recorded as sent)';

-- ---------------------------------------------------------------------
-- Claim with the attempt's mode
-- ---------------------------------------------------------------------
drop function public.claim_report_send(uuid, text);

create function public.claim_report_send(p_id uuid, p_message_id text, p_test_recipient text default null)
returns table (id uuid, case_id uuid, report_id uuid, formats text[], to_addresses text[], cc_addresses text[], subject text,
               body text, attachment_name text, in_reply_to text, references_ids text[], message_id text, case_ref text)
language plpgsql security definer set search_path = '' as $$
declare
    v      public.report_sends;
    v_test text := nullif(lower(btrim(coalesce(p_test_recipient, ''))), '');
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
    if v_test is not null and (v_test !~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_test) > 254) then
        raise exception 'Invalid test recipient' using errcode = '22023';
    end if;
    update public.report_sends
       set status = 'sending', attempts = attempts + 1, claimed_at = now(),
           message_id = coalesce(report_sends.message_id, p_message_id), test_recipient = v_test::public.citext
     where report_sends.id = p_id;
    return query
        select s.id, s.case_id, s.report_id, s.formats, s.to_addresses::text[], s.cc_addresses::text[], s.subject, s.body,
               s.attachment_name, s.in_reply_to, s.references_ids, s.message_id, c.case_ref
          from public.report_sends s join public.cases c on c.id = s.case_id where s.id = p_id;
end $$;
revoke all on function public.claim_report_send(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_report_send(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
-- Finishing: a test run records no submission
-- ---------------------------------------------------------------------
create or replace function private.finish_report_send(p_id uuid, p_sent_at timestamptz, p_delivery text,
                                                      p_link_expires timestamptz, p_pack_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v   public.report_sends;
    v_s uuid;
    v_at timestamptz := least(coalesce(p_sent_at, now()), now());
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if v.status = 'sent' then
        return v.submission_id;
    end if;
    if v.status = 'test_sent' then
        return null;
    end if;
    if v.test_recipient is not null then
        update public.report_sends
           set status = 'test_sent', sent_at = v_at, delivery = p_delivery, link_expires_at = p_link_expires,
               pack_path = p_pack_path, error = null
         where id = p_id;
        perform private.post_system_message(v.case_id,
            'Test run: the report email went to ' || v.test_recipient::text || ' instead of the insurer'
            || ' (' || array_to_string(v.to_addresses::text[], ', ') || '). Nothing was recorded as sent',
            null, 'system', null, 'staff');
        return null;
    end if;
    insert into public.submissions (case_id, report_id, channel, submitted_at, submitted_by, formats, to_addresses, cc_addresses,
                                    sent_message_id, gmail_thread_id, notes)
    values (v.case_id, v.report_id, 'email', v_at, v.requested_by, v.formats,
            v.to_addresses, v.cc_addresses, v.message_id, v.gmail_thread_id,
            case when p_delivery = 'link' then 'Annexures sent as a secure link' else null end)
    returning id into v_s;
    update public.report_sends
       set status = 'sent', sent_at = v_at, delivery = p_delivery,
           link_expires_at = p_link_expires, pack_path = p_pack_path, error = null, submission_id = v_s
     where id = p_id;
    return v_s;
end $$;
revoke all on function private.finish_report_send(uuid, timestamptz, text, timestamptz, text) from public, anon, authenticated;

-- complete_report_send: same body as 20261116100000 plus test_sent as a finished state (repeat is harmless)
create or replace function public.complete_report_send(p_id uuid, p_delivery text, p_link_expires timestamptz, p_pack_path text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v public.report_sends;
begin
    select * into v from public.report_sends s where s.id = p_id for update;
    if not found or v.status not in ('sending', 'unknown', 'sent', 'test_sent') then
        raise exception 'Send is not in progress' using errcode = '55000';
    end if;
    if p_delivery not in ('attached', 'link') then
        raise exception 'Invalid delivery' using errcode = '22023';
    end if;
    return private.finish_report_send(p_id, now(), p_delivery, p_link_expires, p_pack_path);
end $$;
revoke all on function public.complete_report_send(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_report_send(uuid, text, timestamptz, text) to service_role;
