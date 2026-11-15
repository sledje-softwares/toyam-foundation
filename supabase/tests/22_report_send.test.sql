-- Report send outbox (20261116100000_report_send.sql): reply target, request rules, claim / complete / fail,
-- unknown outcomes, portal pack. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

-- Fixture: a1 admin, c1 orchestrator, b1 office (owns W1, W2, W3), b2 office (owns nothing), f1 field.
-- Insurer WSN. Template "free" (no approval, pdf + docx) and template "appr" (approval required, pdf).
-- W1 free, office_review, v1 report with pdf + docx files, insurer mail (+ an internal reply)
-- W2 free, office_review, v1 with a pdf file only       W3 appr, office_review, v1 with pdf, not approved
-- W4 free, no email at all
insert into auth.users (instance_id, id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000a1','authenticated','authenticated','w-admin@example.com',null,'{"role":"admin","full_name":"W Admin"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000c1','authenticated','authenticated','w-orch@example.com',null,'{"role":"orchestrator","full_name":"W Orch"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000b1','authenticated','authenticated','w-off1@example.com',null,'{"role":"office","full_name":"W Office 1"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000b2','authenticated','authenticated','w-off2@example.com',null,'{"role":"office","full_name":"W Office 2"}','{}'),
 ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000f1','authenticated','authenticated',null,'919850000291','{"role":"field","full_name":"W Field"}','{}');
insert into public.insurers (id, name, code) values ('2f000000-0000-4000-8000-0000000000a1', 'Send Insurer', 'WSN');
select public.load_case_template('{"insurer_code":"WSN","claim_type":"motor","variant":"free","name":"WSN free","requires_approval":false,
  "output_formats":["pdf","docx"],"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
select public.load_case_template('{"insurer_code":"WSN","claim_type":"motor","variant":"appr","name":"WSN appr","requires_approval":true,
  "output_formats":["pdf"],"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
insert into public.cases (id, insurer_id, insurer_claim_no, claim_type, template_id, office_owner_id, status)
select v.id::uuid, '2f000000-0000-4000-8000-0000000000a1', v.claim, 'motor', t.id, '1f000000-0000-4000-8000-0000000000b1', 'office_review'
  from (values ('3f000000-0000-4000-8000-000000000001', 'WSN-1', 'free'), ('3f000000-0000-4000-8000-000000000002', 'WSN-2', 'free'),
               ('3f000000-0000-4000-8000-000000000003', 'WSN-3', 'appr'), ('3f000000-0000-4000-8000-000000000004', 'WSN-4', 'free')) v(id, claim, variant)
  join public.case_templates t on t.variant = v.variant and t.is_active
  join public.insurers i on i.id = t.insurer_id and i.code = 'WSN';
insert into public.reports (id, case_id, version, storage_path, uploaded_by, origin)
select v.rid::uuid, v.cid::uuid, 1, 'cases/' || v.cid || '/v1.pdf', '1f000000-0000-4000-8000-0000000000b1', 'generated'
  from (values ('5f000000-0000-4000-8000-000000000001', '3f000000-0000-4000-8000-000000000001'),
               ('5f000000-0000-4000-8000-000000000002', '3f000000-0000-4000-8000-000000000002'),
               ('5f000000-0000-4000-8000-000000000003', '3f000000-0000-4000-8000-000000000003'),
               ('5f000000-0000-4000-8000-000000000004', '3f000000-0000-4000-8000-000000000004')) v(rid, cid);
insert into public.report_files (report_id, format, storage_path, size_bytes) values
 ('5f000000-0000-4000-8000-000000000001', 'pdf',  'cases/w1/v1.pdf', 1000), ('5f000000-0000-4000-8000-000000000001', 'docx', 'cases/w1/v1.docx', 2000),
 ('5f000000-0000-4000-8000-000000000002', 'pdf',  'cases/w2/v1.pdf', 1000),
 ('5f000000-0000-4000-8000-000000000003', 'pdf',  'cases/w3/v1.pdf', 1000),
 ('5f000000-0000-4000-8000-000000000004', 'pdf',  'cases/w4/v1.pdf', 1000);
insert into public.emails (gmail_message_id, gmail_thread_id, from_address, to_addresses, cc_addresses, subject, received_at, status, case_id,
                           in_reply_to, references_ids, is_internal)
values
 ('<ins-1@insurer.example>', 'th-1', 'claims@insurer.example', '{toyaminvestigation@gmail.com}', '{boss@insurer.example,Ops@Insurer.example}',
  'Investigation WSN-1', now() - interval '2 days', 'processed', '3f000000-0000-4000-8000-000000000001', null, '{<root@insurer.example>}', false),
 ('<int-1@toyaminvestigation.in>', 'th-1', 'gi@toyaminvestigation.in', '{claims@insurer.example}', '{}',
  'Re: Investigation WSN-1', now() - interval '1 day', 'processed', '3f000000-0000-4000-8000-000000000001', '<ins-1@insurer.example>', '{}', true),
 ('<ins-2@insurer.example>', 'th-2', 'claims@insurer.example', '{toyaminvestigation@gmail.com}', '{}',
  'Investigation WSN-2', now() - interval '2 days', 'processed', '3f000000-0000-4000-8000-000000000002', null, '{}', false),
 ('<ins-3@insurer.example>', 'th-3', 'claims@insurer.example', '{toyaminvestigation@gmail.com}', '{}',
  'Investigation WSN-3', now() - interval '2 days', 'processed', '3f000000-0000-4000-8000-000000000003', null, '{}', false);

select has_table('public', 'report_sends', 'report_sends exists');
select has_function('public', 'request_report_send', array['uuid', 'text[]', 'text[]', 'text[]', 'text', 'text', 'text'], 'request_report_send exists');

-- =====================================================================
-- A. Reply target
-- =====================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select is((select to_addresses from public.report_send_target('3f000000-0000-4000-8000-000000000001')), array['claims@insurer.example'],
          'target: To is the insurer sender, not the firm''s own reply');
select is((select cc_addresses from public.report_send_target('3f000000-0000-4000-8000-000000000001')), array['boss@insurer.example', 'ops@insurer.example', 'toyaminvestigation@gmail.com']::text[],
          'target: CC keeps the original recipients (firm mailbox included), without the sender, case-folded');
select is((select in_reply_to from public.report_send_target('3f000000-0000-4000-8000-000000000001')), '<ins-1@insurer.example>', 'target: replies to the insurer''s Message-ID');
select is((select references_ids from public.report_send_target('3f000000-0000-4000-8000-000000000001')), array['<root@insurer.example>', '<ins-1@insurer.example>'],
          'target: References chain ends with the replied message');
select is((select count(*)::int from public.report_send_target('3f000000-0000-4000-8000-000000000004')), 0, 'target: none when the case has no insurer mail');
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select * from public.report_send_target('3f000000-0000-4000-8000-000000000001')$$, '42501', null, 'target: an office user who does not own the case is refused');
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000f1","role":"authenticated"}';
select throws_ok($$select * from public.report_send_target('3f000000-0000-4000-8000-000000000001')$$, '42501', null, 'target: field users are refused');

-- =====================================================================
-- B. Requesting a send
-- =====================================================================
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{pdf}', null, null, 'Re: x', 'Please find the report', 'IR_1')$$,
                 '42501', null, 'request: field users are refused');
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{pdf}', null, null, 'Re: x', 'Please find the report', 'IR_1')$$,
                 '42501', null, 'request: a non-owner office user is refused');
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{}', null, null, 'Re: x', 'Please find the report', 'IR_1')$$,
                 '22023', null, 'request: formats are required');
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{pdf}', '{not-an-address}', null, 'Re: x', 'Please find the report', 'IR_1')$$,
                 '22023', null, 'request: a bad address is refused');
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000002', '{pdf,docx}', null, null, 'Re: x', 'Please find the report', 'IR_2')$$,
                 '55000', null, 'request: a format that was not generated is refused');
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000003', '{pdf}', null, null, 'Re: x', 'Please find the report', 'IR_3')$$,
                 '42501', null, 'request: an unapproved report is refused where approval is required');
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000004', '{pdf}', null, null, 'Re: x', 'Please find the report', 'IR_4')$$,
                 '55000', null, 'request: a case with no insurer mail is refused');
select lives_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{pdf,docx}', null, array['extra@insurer.example'], 'Re: Investigation WSN-1', 'Please find the report', 'IR/WSN:1')$$,
                'request: the owner queues a send');
select is((select status from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000001'), 'queued', 'request: status queued');
select is((select attachment_name from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000001'), 'IR_WSN_1', 'request: unsafe characters leave the file name');
select is((select in_reply_to from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000001'), '<ins-1@insurer.example>', 'request: reply headers come from the insurer mail');
select is((select cc_addresses::text[] from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000001'), array['extra@insurer.example'],
          'request: CC given by staff replaces the default');
select throws_ok($$select public.request_report_send('3f000000-0000-4000-8000-000000000001', '{pdf}', null, null, 'Re: x', 'Please find the report', 'IR_1')$$,
                 '55000', null, 'request: a second open send for the same report is refused');

-- =====================================================================
-- C. Claim, complete (service role only)
-- =====================================================================
create temp table t_send as select id from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000001';
grant select on t_send to authenticated, service_role;
select throws_ok($$select * from public.claim_report_send((select id from t_send), '<m1@gmail.example>')$$, '42501', null, 'claim: staff cannot call the sender functions');
select throws_ok($$select public.complete_report_send((select id from t_send), 'attached', null, null)$$, '42501', null, 'complete: staff cannot call the sender functions');
reset role;
set local role service_role;
select is((select message_id from public.claim_report_send((select id from t_send), '<m1@gmail.example>')), '<m1@gmail.example>', 'claim: returns the row with the Message-ID');
select is((select count(*)::int from public.claim_report_send((select id from t_send), '<m2@gmail.example>')), 0, 'claim: a second claim gets nothing');
select is((select status from public.report_sends where id = (select id from t_send)), 'sending', 'claim: status sending, attempts counted');
select isnt((select public.complete_report_send((select id from t_send), 'attached', null, null)), null, 'complete: returns the submission id');
select is((select count(*)::int from public.submissions where case_id = '3f000000-0000-4000-8000-000000000001' and channel = 'email'
            and sent_message_id = '<m1@gmail.example>' and gmail_thread_id = 'th-1' and formats = '{pdf,docx}'), 1, 'complete: email submission with Message-ID, thread and formats');
select is((select status::text from public.cases where id = '3f000000-0000-4000-8000-000000000001'), 'submitted', 'complete: case submitted');
select is((select status from public.report_sends where id = (select id from t_send)), 'sent', 'complete: send marked sent');
select lives_ok($$select public.complete_report_send((select id from t_send), 'attached', null, null)$$, 'complete: repeating it is harmless');
select is((select count(*)::int from public.submissions where case_id = '3f000000-0000-4000-8000-000000000001'), 1, 'complete: no second submission');

-- =====================================================================
-- D. Failure, retry, unknown outcome (W2)
-- =====================================================================
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select public.request_report_send('3f000000-0000-4000-8000-000000000002', '{pdf}', null, null, 'Re: Investigation WSN-2', 'Please find the report', 'IR_2');
create temp table t_send2 as select id from public.report_sends where case_id = '3f000000-0000-4000-8000-000000000002';
grant select on t_send2 to authenticated, service_role;
reset role;
set local role service_role;
select count(*) from public.claim_report_send((select id from t_send2), '<m3@gmail.example>');
select public.fail_report_send((select id from t_send2), 'smtp refused', false);
select is((select status from public.report_sends where id = (select id from t_send2)), 'failed', 'fail: a refusal before DATA is failed');
select is((select count(*)::int from public.notifications where kind = 'report_send_failed' and user_id = '1f000000-0000-4000-8000-0000000000b1'), 1, 'fail: the requester is notified');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select lives_ok($$select public.retry_report_send((select id from t_send2))$$, 'retry: a failed send can be queued again');
reset role;
set local role service_role;
select is((select message_id from public.claim_report_send((select id from t_send2), '<m4@gmail.example>')), '<m3@gmail.example>', 'retry: the first Message-ID is kept');
select public.fail_report_send((select id from t_send2), 'connection lost after DATA', true);
select is((select status from public.report_sends where id = (select id from t_send2)), 'unknown', 'fail: an uncertain outcome is unknown');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"1f000000-0000-4000-8000-0000000000b1","role":"authenticated"}';
select throws_ok($$select public.retry_report_send((select id from t_send2))$$, '55000', null, 'retry: an unknown outcome cannot be retried blindly');
select lives_ok($$select public.resolve_report_send((select id from t_send2), true)$$, 'resolve: staff confirm the mail was sent');
select is((select status::text from public.cases where id = '3f000000-0000-4000-8000-000000000002'), 'submitted', 'resolve: the case is submitted');

-- =====================================================================
-- E. Portal pack
-- =====================================================================
select throws_ok($$select public.request_portal_pack('3f000000-0000-4000-8000-000000000003', '{pdf}')$$, '42501', null, 'pack: unapproved report refused');
select lives_ok($$select public.request_portal_pack('3f000000-0000-4000-8000-000000000004', '{pdf}')$$, 'pack: an approved-free report passes');
reset role;
select is((select count(*)::int from public.audit_log where action = 'PORTAL_PACK' and record_id = '5f000000-0000-4000-8000-000000000004'), 1, 'pack: the download is audited');
select * from finish();
rollback;
