-- D43 follow-up (20261114600000_drain_rate_limit.sql): rate limits for the no-JWT field-drain
-- function. Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (instance_id, id, aud, role, phone, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','1f000000-0000-4000-8000-0000000000f1','authenticated','authenticated','919860000091','{"role":"field","full_name":"Rate Field"}','{}');
insert into public.field_devices (device_id, profile_id, secret_sha256) values
 ('6f000000-0000-4000-8000-000000000001', '1f000000-0000-4000-8000-0000000000f1', encode(extensions.digest(repeat('ab', 32), 'sha256'), 'hex')),
 ('6f000000-0000-4000-8000-000000000002', '1f000000-0000-4000-8000-0000000000f1', encode(extensions.digest(repeat('ab', 32), 'sha256'), 'hex')),
 ('6f000000-0000-4000-8000-000000000003', '1f000000-0000-4000-8000-0000000000f1', encode(extensions.digest(repeat('ab', 32), 'sha256'), 'hex'));

-- ---------------------------------------------------------------------
-- Failed secrets: 5 within 15 minutes lock the device for 1 hour
-- ---------------------------------------------------------------------
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))), 'ok', 'good secret passes');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('cd', 32))), 'device_unknown', 'bad secret 1');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', 'not hex')), 'device_unknown', 'malformed secret 2 counts too');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('cd', 32))), 'device_unknown', 'bad secret 3');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('cd', 32))), 'device_unknown', 'bad secret 4');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))), 'ok', 'a good secret in between does not reset the count');
select results_eq($$select result, retry_after_seconds from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('cd', 32))$$,
    $$values ('device_locked'::text, 3600)$$, 'bad secret 5 locks the device for an hour');
reset role;
select is((select count(*)::int from public.audit_log where action = 'DRAIN_DEVICE_LOCKED' and record_id = '6f000000-0000-4000-8000-000000000001'), 1, 'the lock is audited');
select is((select new_data->>'failed_checks' from public.audit_log where action = 'DRAIN_DEVICE_LOCKED' and record_id = '6f000000-0000-4000-8000-000000000001'), '5', 'audit row carries the failure count');
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))), 'device_locked', 'even the right secret is refused while locked');
select throws_ok($$select * from public.drain_status('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))$$,
    '42501', 'Too many failed attempts', 'drain_verify refuses a locked device too');
select is((select count(*)::int from public.audit_log where action = 'DRAIN_DEVICE_LOCKED' and record_id = '6f000000-0000-4000-8000-000000000001'), 1, 'repeat calls while locked add no audit rows');
reset role;
update private.drain_lock set locked_until = now() - interval '1 minute' where device_id = '6f000000-0000-4000-8000-000000000001';
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))), 'ok', 'unlocked after the hour');
select lives_ok($$select * from public.drain_status('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))$$, 'drain_verify accepts it again');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('cd', 32))), 'device_unknown', 'failures started from zero after the lock');

-- failures older than 15 minutes do not count
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000002', repeat('cd', 32))), 'device_unknown', 'device 2 bad 1');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000002', repeat('cd', 32))), 'device_unknown', 'device 2 bad 2');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000002', repeat('cd', 32))), 'device_unknown', 'device 2 bad 3');
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000002', repeat('cd', 32))), 'device_unknown', 'device 2 bad 4');
reset role;
update private.drain_rate set bucket_start = bucket_start - interval '20 minutes'
 where device_id = '6f000000-0000-4000-8000-000000000002' and kind = 'fail';
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000002', repeat('cd', 32))), 'device_unknown', 'the fifth failure outside the window does not lock');

-- ---------------------------------------------------------------------
-- Call cap (120 / minute) and presign cap (500 / hour)
-- ---------------------------------------------------------------------
reset role;
insert into private.drain_rate (device_id, kind, bucket_start, n)
values ('6f000000-0000-4000-8000-000000000003', 'call', date_trunc('minute', now()), 120);
set local role service_role;
select results_eq($$select result, (retry_after_seconds between 1 and 60) from public.drain_check('6f000000-0000-4000-8000-000000000003', repeat('ab', 32))$$,
    $$values ('rate_limited'::text, true)$$, 'call 121 in a minute is refused with a retry time');
reset role;
update private.drain_rate set bucket_start = bucket_start - interval '1 minute' where device_id = '6f000000-0000-4000-8000-000000000003' and kind = 'call';
insert into private.drain_rate (device_id, kind, bucket_start, n)
values ('6f000000-0000-4000-8000-000000000003', 'presign', date_trunc('minute', now()) - interval '30 minutes', 500);
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000003', repeat('ab', 32), 'post')), 'ok', 'the next minute is allowed; other actions ignore the file cap');
select results_eq($$select result, (retry_after_seconds between 1500 and 1860) from public.drain_check('6f000000-0000-4000-8000-000000000003', repeat('ab', 32), 'presign')$$,
    $$values ('rate_limited'::text, true)$$, 'file 501 in an hour is refused; retry when the oldest bucket expires');
reset role;
update private.drain_rate set bucket_start = bucket_start - interval '31 minutes' where device_id = '6f000000-0000-4000-8000-000000000003' and kind = 'presign';
set local role service_role;
select is((select result from public.drain_check('6f000000-0000-4000-8000-000000000003', repeat('ab', 32), 'presign')), 'ok', 'allowed again after the hour');
reset role;
select is((select sum(n)::int from private.drain_rate where device_id = '6f000000-0000-4000-8000-000000000003' and kind = 'presign' and bucket_start >= now() - interval '1 hour'), 1, 'only the new presign is counted');

-- ---------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------
set local role anon;
select throws_ok($$select * from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))$$, '42501', null::text, 'anon cannot call drain_check');
select throws_ok($$select * from private.drain_rate$$, '42501', null::text, 'anon cannot read the counters');
reset role;
set local role authenticated;
select throws_ok($$select * from public.drain_check('6f000000-0000-4000-8000-000000000001', repeat('ab', 32))$$, '42501', null::text, 'authenticated cannot call drain_check');
select throws_ok($$select * from private.drain_lock$$, '42501', null::text, 'authenticated cannot read the locks');
reset role;

select * from finish();
rollback;
