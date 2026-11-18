-- Report sender test mode (20261119210000_report_send_test_mode.sql): a test run claims with the test
-- address, finishes as test_sent with no submission and no case status change; a live claim afterwards
-- records the submission as before. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- Fixture: b1 office owns X1, X2, X3 (template without approval, pdf + docx), each with a v1 report and an insurer mail.
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000b1','authenticated','authenticated','x-off1@example.com',null,'{"role":"office","full_name":"X Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1e000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000391','{"role":"field","full_name":"X Field"}','{}');
insert into public.insurers (id, name, code) values ('2e000000-0000-4000-8000-0000000000a1', 'Test-mode Insurer', 'XTM');
select public.load_case_template('{"insurer_code":"XTM","claim_type":"motor","variant":"free","name":"XTM free","requires_approval":false,
  "output_formats":["pdf","docx"],"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select v.id::uuid, '2e000000-0000-4000-8000-0000000000a1', v.claim, 'motor', t.id, '1e000000-0000-4000-8000-0000000000b1', 'office_review'
  from (values ('3e000000-0000-4000-8000-000000000001', 'XTM-1'), ('3e000000-0000-4000-8000-000000000002', 'XTM-2'),
               ('3e000000-0000-4000-8000-000000000003', 'XTM-3')) v(id, claim)
  join public.case_templates t on t.variant = 'free' and t.is_active
  join public.insurers i on i.id = t.insurer_id and i.code = 'XTM';
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin)
select v.rid::uuid, v.cid::uuid, 1, 'cases/' || v.cid || '/v1.pdf', '1e000000-0000-4000-8000-0000000000b1', 'generated'
  from (values ('5e000000-0000-4000-8000-000000000001', '3e000000-0000-4000-8000-000000000001'),
               ('5e000000-0000-4000-8000-000000000002', '3e000000-0000-4000-8000-000000000002'),
               ('5e000000-0000-4000-8000-000000000003', '3e000000-0000-4000-8000-000000000003')) v(rid, cid);
insert into public.report_files (report_id, format, storage_path, size_bytes) values
 ('5e000000-0000-4000-8000-000000000001', 'pdf', 'cases/x1/v1.pdf', 1000),
 ('5e000000-0000-4000-8000-000000000002', 'pdf', 'cases/x2/v1.pdf', 1000),
 ('5e000000-0000-4000-8000-000000000003', 'pdf', 'cases/x3/v1.pdf', 1000);
insert into public.emails (gmail_message_id, gmail_thread_id, from_address, to_addresses, cc_addresses, subject, received_at, status, case_id, is_internal)
select '<xtm-' || n || '@insurer.example>', 'xth-' || n, 'claims@insurer.example', '{toyaminvestigation@gmail.com}', '{}',
       'Investigation XTM-' || n, now() - interval '2 days', 'processed', ('3e000000-0000-4000-8000-00000000000' || n)::uuid, false
  from generate_series(1, 3) n;

select has_function('public', 'claim_report_send', array['uuid', 'text', 'text'], 'claim_report_send takes the test recipient');
select hasnt_function('public', 'claim_report_send', array['uuid', 'text'], 'the two-argument version is replaced (no ambiguous overload)');

set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select public.request_report_send('3e000000-0000-4000-8000-000000000001', '{pdf}', null, null, 'Re: Investigation XTM-1', 'Please find the report', 'IR_1');
create temp table t_x1 as select id from public.report_sends where case_id = '3e000000-0000-4000-8000-000000000001';
grant select on t_x1 to authenticated, service_role;
select throws_ok($$select * from public.claim_report_send((select id from t_x1), '<t1@gmail.example>', 'dev@example.com')$$,
                 '42501', null, 'claim: staff cannot call the sender function');

-- =====================================================================
-- A. A test run (X1)
-- =====================================================================
reset role;
set local role service_role;
select throws_ok($$select * from public.claim_report_send((select id from t_x1), '<t1@gmail.example>', 'not an address')$$,
                 '22023', null, 'claim: a bad test recipient is refused');
select is((select status from public.report_sends where id = (select id from t_x1)), 'queued', 'claim: a refused claim leaves the send queued');
select is((select message_id from public.claim_report_send((select id from t_x1), '<t1@gmail.example>', ' Dev@Example.com ')), '<t1@gmail.example>',
          'claim: a test claim returns the row');
select is((select test_recipient::text from public.report_sends where id = (select id from t_x1)), 'dev@example.com', 'claim: the test address is recorded');
select is((select public.complete_report_send((select id from t_x1), 'attached', null, null)), null::uuid, 'complete: a test run returns no submission');
select is((select status from public.report_sends where id = (select id from t_x1)), 'test_sent', 'complete: status test_sent');
select is((select count(*)::int from public.submissions where case_id = '3e000000-0000-4000-8000-000000000001'), 0, 'complete: no submission recorded');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000001'), 'office_review', 'complete: the case status is unchanged');
select is((select count(*)::int from public.case_messages where case_id = '3e000000-0000-4000-8000-000000000001' and visibility = 'staff'
            and body like 'Test run: the report email went to dev@example.com instead of the insurer (claims@insurer.example)%'), 1,
          'complete: a staff-only thread message says where the mail went');
select is((select public.complete_report_send((select id from t_x1), 'attached', null, null)), null::uuid, 'complete: repeating it is harmless');
select throws_ok($$update public.report_sends set test_recipient = null where id = (select id from t_x1)$$,
                 '23514', null, 'a test_sent row always names its test address and has no submission');

-- staff see the outcome; the report can be sent again (live this time)
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select status || ' ' || test_recipient::text from public.report_sends where id = (select id from t_x1)), 'test_sent dev@example.com',
          'staff read the test outcome under RLS');
select lives_ok($$select public.request_report_send('3e000000-0000-4000-8000-000000000001', '{pdf}', null, null, 'Re: Investigation XTM-1', 'Please find the report', 'IR_1')$$,
                'request: after a test run the same report can be queued again');
create temp table t_x1b as select id from public.report_sends where case_id = '3e000000-0000-4000-8000-000000000001' and status = 'queued';
grant select on t_x1b to authenticated, service_role;

-- =====================================================================
-- B. Live claim (two arguments, as before) records the submission
-- =====================================================================
reset role;
set local role service_role;
select is((select count(*)::int from public.claim_report_send((select id from t_x1b), '<l1@gmail.example>')), 1, 'claim: the two-argument call is a live claim');
select is((select test_recipient from public.report_sends where id = (select id from t_x1b)), null, 'claim: a live claim has no test address');
select isnt((select public.complete_report_send((select id from t_x1b), 'attached', null, null)), null::uuid, 'complete: a live send returns the submission');
select is((select status::text from public.cases where id = '3e000000-0000-4000-8000-000000000001'), 'submitted', 'complete: the case is submitted');

-- =====================================================================
-- C. Unknown test outcome settled by staff (X2); failed test retried live (X3)
-- =====================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select public.request_report_send('3e000000-0000-4000-8000-000000000002', '{pdf}', null, null, 'Re: Investigation XTM-2', 'Please find the report', 'IR_2');
select public.request_report_send('3e000000-0000-4000-8000-000000000003', '{pdf}', null, null, 'Re: Investigation XTM-3', 'Please find the report', 'IR_3');
create temp table t_x23 as select id, case_id from public.report_sends where case_id in ('3e000000-0000-4000-8000-000000000002', '3e000000-0000-4000-8000-000000000003');
grant select on t_x23 to authenticated, service_role;
reset role;
set local role service_role;
select count(*) from public.claim_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000002'), '<t2@gmail.example>', 'dev@example.com');
select public.fail_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000002'), 'connection lost after DATA', true);
select count(*) from public.claim_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000003'), '<t3@gmail.example>', 'dev@example.com');
select public.fail_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000003'), 'auth refused', false);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1e000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.resolve_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000002'), true)$$,
                'resolve: staff settle an unknown test run as sent');
select is((select status from public.report_sends where case_id = '3e000000-0000-4000-8000-000000000002'), 'test_sent', 'resolve: a settled test run is test_sent');
select is((select count(*)::int from public.submissions where case_id = '3e000000-0000-4000-8000-000000000002'), 0, 'resolve: a settled test run records no submission');
select public.retry_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000003'));
reset role;
set local role service_role;
select is((select message_id from public.claim_report_send((select id from t_x23 where case_id = '3e000000-0000-4000-8000-000000000003'), '<l3@gmail.example>')),
          '<t3@gmail.example>', 'retry: a failed test retried live keeps its Message-ID');
select is((select test_recipient from public.report_sends where case_id = '3e000000-0000-4000-8000-000000000003'), null,
          'retry: the live attempt clears the test address');

select * from finish();
rollback;
