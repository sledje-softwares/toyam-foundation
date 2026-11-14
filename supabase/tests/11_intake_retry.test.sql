-- D39 queued intake retry: request_intake_retry(), claim_intake_retries(), intake_ingest() retry
-- branch, intake_retry_failed(), escalate_stuck_intake_retries().
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- Fixture: office b1, orchestrator c1, admin d1, field f1
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000b1','authenticated','authenticated','r-off@example.com',null,'{"role":"office","full_name":"R Office"}','{}'),
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000c1','authenticated','authenticated','r-orch@example.com',null,'{"role":"orchestrator","full_name":"R Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000d1','authenticated','authenticated','r-adm@example.com',null,'{"role":"admin","full_name":"R Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','19000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919870000001','{"role":"field","full_name":"R Field"}','{}');

create function pg_temp.eid(p_msg text) returns uuid language sql as $$
  select id from public.emails where gmail_message_id = p_msg $$;
create function pg_temp.decision(p_msg text, p_retry uuid) returns jsonb language sql as $$
  select jsonb_build_object('parser_version','rules-v1','message_id',p_msg,'from_address','rcu@retry.example',
    'subject','Retried mail','received_at','2026-11-14T05:00:00Z','body_text','Dear team',
    'raw_storage_path','emails/2026/11/r/' || p_msg || '.eml','classification','other','action','review',
    'fields','{}'::jsonb,'missing_required','[]'::jsonb,'attachments','[]'::jsonb,'notes','["retried"]'::jsonb,
    'retry_email_id', p_retry) $$;
grant execute on function pg_temp.eid(text), pg_temp.decision(text, uuid) to authenticated, service_role;

set local role service_role;
set local request.jwt.claims to '';
select public.intake_record_failure(m, 'emails/2026/11/r/' || m || '.eml', 'Malformed MIME', 'Broken ' || m, 'rcu@retry.example')
  from unnest(array['r-1@x','r-2@x','r-3@x','sha-r4']) m;
select public.intake_ingest(pg_temp.decision('r-ok@x', null) - 'retry_email_id');   -- a processed email
select public.intake_ingest(pg_temp.decision('r-dup@x', null) - 'retry_email_id');  -- already received once
reset role;
create temp table t_n as select count(*)::int as n from public.emails;
grant select on t_n to authenticated, service_role;

-- =====================================================================
-- Requesting a retry
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select public.request_intake_retry(pg_temp.eid('r-1@x'))$$, '42501', null::text, 'field users cannot request a retry');
select is((select count(*)::int from public.emails), 0, 'field users see no emails');

set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.claim_intake_retries(10)$$, '42501', null::text, 'staff cannot claim retries');
select throws_ok($$select public.intake_retry_failed(pg_temp.eid('r-1@x'), 'x')$$, '42501', null::text, 'staff cannot fail a retry');
select throws_ok($$select public.escalate_stuck_intake_retries()$$, '42501', null::text, 'staff cannot run the escalation');
select throws_ok($$select public.intake_ingest(pg_temp.decision('r-1@x', pg_temp.eid('r-1@x')))$$, '42501', null::text, 'staff cannot ingest');

select isnt(public.request_intake_retry(pg_temp.eid('r-1@x')), null::timestamptz, 'staff can request a retry');
select is((select status::text || '/' || (retry_requested_by = '19000000-0000-4000-8000-0000000000b1')::text || '/' || (retry_requested_at is not null)::text
             from public.emails where gmail_message_id = 'r-1@x'), 'retry_requested/true/true', 'request stamps status, who and when');
select throws_ok($$select public.request_intake_retry(pg_temp.eid('r-1@x'))$$, '22023', null::text, 'a queued email cannot be queued again');
select throws_ok($$select public.request_intake_retry(pg_temp.eid('r-ok@x'))$$, '22023', null::text, 'processed emails cannot be retried');
select throws_ok($$select public.request_intake_retry(gen_random_uuid())$$, '22023', null::text, 'unknown emails cannot be retried');
select is(public.intake_retry(pg_temp.eid('r-2@x')), 'emails/2026/11/r/r-2@x.eml', 'intake_retry() still returns the raw path');
select is((select status::text from public.emails where gmail_message_id = 'r-2@x'), 'retry_requested', 'intake_retry() queues instead of deleting');
select lives_ok($$select public.request_intake_retry(pg_temp.eid('r-3@x')); select public.request_intake_retry(pg_temp.eid('sha-r4'))$$,
                'staff queue two more');
select is((select count(*)::int from public.emails), (select n from t_n), 'requesting deletes nothing');

-- =====================================================================
-- Claim (service role)
-- =====================================================================
reset role;
select ok(exists (select 1 from public.audit_log where table_name = 'emails' and record_id = pg_temp.eid('r-1@x')
                     and action = 'RETRY_REQUESTED' and actor_id = '19000000-0000-4000-8000-0000000000b1'), 'request is audited (who, old and new state)');
set local role service_role;
set local request.jwt.claims to '';
select is((select count(*)::int from public.claim_intake_retries(2)), 2, 'claim honours the limit');
select is((select count(*)::int from public.claim_intake_retries(10)), 2, 'claim takes the rest');
select is((select count(*)::int from public.claim_intake_retries(10)), 0, 'claimed rows are leased');
select is((select raw_storage_path from public.claim_intake_retries(10)), null, 'nothing left to claim');
reset role;
update public.emails set retry_claimed_at = now() - interval '20 minutes' where gmail_message_id = 'r-1@x';
set local role service_role;
select is((select array_agg(raw_storage_path) from public.claim_intake_retries(10)), array['emails/2026/11/r/r-1@x.eml'],
          'a stale lease is claimed again, with the raw path');

-- =====================================================================
-- Reprocess: ingested, failed again, duplicate
-- =====================================================================
select is((select public.intake_ingest(pg_temp.decision('r-1@x', pg_temp.eid('r-1@x')))->>'email_id')::uuid, pg_temp.eid('r-1@x'),
          'a retried email is ingested into its own row');
select is((select status::text || '/' || retry_attempts || '/' || coalesce(error, '-') || '/' || (retry_claimed_at is null)::text
             from public.emails where gmail_message_id = 'r-1@x'), 'processed/1/-/true', 'ingested: processed, attempts 1, error and lease cleared');
select is((select count(*)::int from public.intake_extractions where email_id = pg_temp.eid('r-1@x')), 1, 'the retried email reaches the review queue');
select throws_ok($$select public.intake_ingest(pg_temp.decision('r-1@x', pg_temp.eid('r-1@x')))$$, '22023', null::text,
                 'only queued emails can be reprocessed');
select is((select public.intake_ingest(pg_temp.decision('r-1@x', null) - 'retry_email_id')->>'result'), 'duplicate',
          'Message-ID idempotency still holds after a retry');

select is(public.intake_retry_failed(pg_temp.eid('r-2@x'), 'Malformed MIME again'), true, 'a retry can fail');
select is((select status::text || '/' || retry_attempts || '/' || error from public.emails where gmail_message_id = 'r-2@x'),
          'failed/1/Malformed MIME again', 'failed again: status failed, attempts 1, new error');
select is(public.intake_retry_failed(pg_temp.eid('r-2@x'), 'again'), false, 'a failed email is not failed twice');

select is((select public.intake_ingest(pg_temp.decision('r-dup@x', pg_temp.eid('sha-r4')))->>'result'), 'duplicate',
          'a retry of a message received meanwhile is a duplicate');
select is((select status::text || '/' || retry_attempts from public.emails where gmail_message_id = 'sha-r4'), 'ignored/1',
          'the duplicate retried row is kept and closed');
select is((select count(*)::int from public.emails), (select n from t_n), 'reprocessing deletes nothing');

-- =====================================================================
-- Escalation
-- =====================================================================
create temp table t_esc as select * from public.escalate_stuck_intake_retries();
select is((select array_agg(email_id) from t_esc), array[pg_temp.eid('r-2@x')], 'escalation returns the email that failed again (r-3 is under an hour)');
select is((select count(*)::int from public.notifications n
            where n.kind = 'intake_retry_stuck' and n.dedupe_key = 'intake_retry:' || pg_temp.eid('r-2@x')),
          (select count(*)::int from public.profiles where is_active and role in ('orchestrator', 'admin')),
          'one in-app alert per active orchestrator and admin');
select is((select count(*)::int from public.notifications where kind = 'intake_retry_stuck'
              and user_id in ('19000000-0000-4000-8000-0000000000b1', '19000000-0000-4000-8000-0000000000f1')), 0,
          'office and field users get no alert');
select is((select count(*)::int from public.escalate_stuck_intake_retries()), 0, 'the escalation alerts once');
reset role;
update public.emails set retry_requested_at = now() - interval '61 minutes' where gmail_message_id = 'r-3@x';
set local role service_role;
select is((select array_agg(email_id::text || '/' || email_status::text) from public.escalate_stuck_intake_retries()),
          array[pg_temp.eid('r-3@x')::text || '/retry_requested'], 'a retry waiting an hour is escalated');
select is((select count(*)::int from public.notifications where kind = 'intake_retry_stuck'
              and user_id = '19000000-0000-4000-8000-0000000000c1'), 2, 'orchestrator has one alert per stuck email');

-- =====================================================================
-- RLS: field users see neither the rows nor the alerts
-- =====================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select is((select count(*)::int from public.emails where retry_attempts > 0 or status = 'retry_requested'), 0, 'field users cannot see retried emails');
select is((select count(*)::int from public.notifications where kind = 'intake_retry_stuck'), 0, 'field users cannot see retry alerts');
set local request.jwt.claims to '{"sub":"19000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.notifications where kind = 'intake_retry_stuck'), 2, 'the orchestrator sees own alerts');

select * from finish();
rollback;
