-- =====================================================================
-- D43 follow-up: rate limits for the no-JWT field-drain function (device_id + secret only).
--   * 5 failed secret checks per device_id within 15 minutes lock the device for 1 hour (audited).
--   * At most 120 calls per device per minute; at most 500 presigned files per device per hour.
-- Counters are 1-minute buckets (server clock, now()); no extensions. Limits are app_settings.
-- Why a separate check function: a function that raises rolls its own writes back, so a failed
-- secret could never be counted by drain_verify(). The edge function calls drain_check() first; it
-- returns a result instead of raising, so counters and the lock audit commit. drain_verify() also
-- refuses a locked device (read only, raises hint device_locked) as defence in depth.
-- Service role only, like every drain_* function.
-- =====================================================================
insert into public.app_settings (key, value, description) values
    ('drain_fail_limit',        '5',   'Failed secret checks per device within drain_fail_window_minutes that lock it'),
    ('drain_fail_window_minutes','15', 'Window for counting failed secret checks'),
    ('drain_lock_minutes',      '60',  'How long a device is locked out of field-drain after too many failed secrets'),
    ('drain_calls_per_minute',  '120', 'field-drain calls per device per minute'),
    ('drain_presigns_per_hour', '500', 'Presigned files per device per hour')
on conflict (key) do nothing;

create table private.drain_rate (
    device_id    uuid        not null,          -- as sent by the caller; may not exist in field_devices
    kind         text        not null check (kind in ('call', 'fail', 'presign')),
    bucket_start timestamptz not null,          -- date_trunc('minute', now())
    n            int         not null default 0,
    primary key (device_id, kind, bucket_start)
);
create table private.drain_lock (
    device_id    uuid primary key,
    locked_at    timestamptz not null,
    locked_until timestamptz not null
);
revoke all on private.drain_rate, private.drain_lock from public, anon, authenticated, service_role;

create or replace function private.drain_bump(p_device_id uuid, p_kind text) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
    insert into private.drain_rate as r (device_id, kind, bucket_start, n)
    values (p_device_id, p_kind, date_trunc('minute', now()), 1)
    on conflict (device_id, kind, bucket_start) do update set n = r.n + 1
    returning r.n into v_n;
    return v_n;
end $$;

-- Seconds left on a lock (0 = not locked).
create or replace function private.drain_lock_left(p_device_id uuid) returns int
language sql stable security definer set search_path = '' as $$
    select coalesce(ceil(extract(epoch from (select l.locked_until - now() from private.drain_lock l
                                              where l.device_id = p_device_id)))::int, 0)
$$;
revoke all on function private.drain_bump(uuid, text), private.drain_lock_left(uuid)
    from public, anon, authenticated, service_role;

-- drain_verify: refuse a locked device before looking at the secret (read only).
create or replace function private.drain_verify(p_device_id uuid, p_secret text) returns public.field_devices
language plpgsql stable security definer set search_path = '' as $$
declare v public.field_devices; v_left int;
begin
    v_left := private.drain_lock_left(p_device_id);
    if v_left > 0 then
        raise exception 'Too many failed attempts' using errcode = '42501', hint = 'device_locked', detail = v_left::text;
    end if;
    if p_device_id is not null and coalesce(p_secret, '') ~ '^[0-9a-f]{64}$' then
        select * into v from public.field_devices d
         where d.device_id = p_device_id
           and d.secret_sha256 = encode(extensions.digest(p_secret, 'sha256'), 'hex');
    end if;
    if v.device_id is null then
        raise exception 'Unknown device' using errcode = '42501', hint = 'device_unknown';
    end if;
    return v;
end $$;

-- First call of every field-drain request. result: 'ok', 'device_unknown' (counted), 'device_locked',
-- 'rate_limited'; retry_after_seconds is set for the last two. p_action 'presign' also uses the
-- hourly file cap. Never raises on a bad secret, so the counters survive.
create or replace function public.drain_check(p_device_id uuid, p_secret text, p_action text default 'status')
returns table (result text, retry_after_seconds int)
language plpgsql security definer set search_path = '' as $$
declare
    v_left int; v_fails int; v_files int; v_oldest timestamptz; v_ok boolean := false;
    v_fail_limit int := private.setting_int('drain_fail_limit', 5);
    v_window int := private.setting_int('drain_fail_window_minutes', 15);
    v_lock_min int := private.setting_int('drain_lock_minutes', 60);
    v_calls int := private.setting_int('drain_calls_per_minute', 120);
    v_presigns int := private.setting_int('drain_presigns_per_hour', 500);
begin
    if p_device_id is null then
        return query select 'device_unknown'::text, null::int;
        return;
    end if;
    -- opportunistic cleanup of old buckets for this device
    delete from private.drain_rate where device_id = p_device_id and bucket_start < now() - interval '2 hours';
    delete from private.drain_lock where device_id = p_device_id and locked_until <= now() - interval '1 day';

    v_left := private.drain_lock_left(p_device_id);
    if v_left > 0 then
        return query select 'device_locked'::text, v_left;
        return;
    end if;

    if private.drain_bump(p_device_id, 'call') > v_calls then
        return query select 'rate_limited'::text, greatest(1, ceil(extract(epoch from
            (date_trunc('minute', now()) + interval '1 minute' - now())))::int);
        return;
    end if;

    if coalesce(p_secret, '') ~ '^[0-9a-f]{64}$' then
        select true into v_ok from public.field_devices d
         where d.device_id = p_device_id and d.secret_sha256 = encode(extensions.digest(p_secret, 'sha256'), 'hex');
    end if;
    if not coalesce(v_ok, false) then
        perform private.drain_bump(p_device_id, 'fail');
        select coalesce(sum(r.n), 0) into v_fails from private.drain_rate r
         where r.device_id = p_device_id and r.kind = 'fail'
           and r.bucket_start > now() - make_interval(mins => v_window);
        if v_fails >= v_fail_limit then
            insert into private.drain_lock as l (device_id, locked_at, locked_until)
            values (p_device_id, now(), now() + make_interval(mins => v_lock_min))
            on conflict (device_id) do update set locked_at = excluded.locked_at, locked_until = excluded.locked_until;
            delete from private.drain_rate where device_id = p_device_id and kind = 'fail';
            insert into public.audit_log (actor_id, action, table_name, record_id, old_data, new_data)
            values (null, 'DRAIN_DEVICE_LOCKED', 'field_devices', p_device_id, null,
                    jsonb_build_object('failed_checks', v_fails, 'window_minutes', v_window, 'lock_minutes', v_lock_min));
            return query select 'device_locked'::text, v_lock_min * 60;
            return;
        end if;
        return query select 'device_unknown'::text, null::int;
        return;
    end if;

    if p_action = 'presign' then
        select coalesce(sum(r.n), 0), min(r.bucket_start) into v_files, v_oldest from private.drain_rate r
         where r.device_id = p_device_id and r.kind = 'presign' and r.bucket_start > now() - interval '1 hour';
        if v_files >= v_presigns then
            return query select 'rate_limited'::text,
                greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::int);
            return;
        end if;
        perform private.drain_bump(p_device_id, 'presign');
    end if;
    return query select 'ok'::text, null::int;
end $$;

revoke all on function public.drain_check(uuid, text, text) from public, anon, authenticated;
grant execute on function public.drain_check(uuid, text, text) to service_role;
