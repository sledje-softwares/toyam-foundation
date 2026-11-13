-- =====================================================================
-- Evidence files on Cloudflare R2, archive tracking and purge candidates.
--
-- Evidence objects live in R2 under cases/{case_id}/tasks/{task_id}/{sha256}.{ext}
-- (convention enforced on evidence.storage_path by public.evidence_validate).
-- A server-side presigner (Edge Function, later) calls
-- public.can_upload_evidence(task_id) with the user's JWT before issuing a
-- short-lived presigned PUT URL.
--
-- An archive job (service role) copies files to long-term archive, records
-- the location and hash verification, and later purges the cloud copy.
-- Archive columns are set-once (null -> value) and only the service role
-- (or the database owner) may write them; core-field immutability and the
-- no-delete rule are unchanged.
-- =====================================================================

alter table public.evidence
    add column storage_backend         text not null default 'r2'
        check (storage_backend in ('r2', 'supabase')),
    add column archived_at             timestamptz,
    add column archive_location        text,
    add column archive_sha256_verified boolean,
    add column cloud_purged_at         timestamptz,
    add constraint evidence_purge_requires_verified_archive
        check (cloud_purged_at is null
               or (archived_at is not null and archive_sha256_verified is true));

-- Archive job roles: service_role (API / Edge Functions) or the owner (direct DB job).
create or replace function private.is_archive_writer() returns boolean
language sql stable set search_path = '' as $$
    select current_user in ('service_role', 'postgres', 'supabase_admin');
$$;
revoke all on function private.is_archive_writer() from public, anon;
grant execute on function private.is_archive_writer() to authenticated, service_role;

create or replace function public.evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
    c_mutable constant text[] := array['is_flagged','flag_reason','checklist_item_id',
        'archived_at','archive_location','archive_sha256_verified','cloud_purged_at'];
begin
    if tg_op = 'DELETE' then
        raise exception 'Evidence records cannot be deleted' using errcode = '42501';
    end if;
    if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable) then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    -- checklist link may only be cleared (ON DELETE SET NULL of the checklist item)
    if new.checklist_item_id is distinct from old.checklist_item_id and new.checklist_item_id is not null then
        raise exception 'Evidence core fields are immutable' using errcode = '42501';
    end if;
    -- archive columns: archive job only, set once
    if (new.archived_at, new.archive_location, new.archive_sha256_verified, new.cloud_purged_at)
       is distinct from
       (old.archived_at, old.archive_location, old.archive_sha256_verified, old.cloud_purged_at) then
        if not private.is_archive_writer() then
            raise exception 'Evidence archive fields are written by the archive job only'
                using errcode = '42501';
        end if;
        if (old.archived_at             is not null and new.archived_at             is distinct from old.archived_at)
        or (old.archive_location        is not null and new.archive_location        is distinct from old.archive_location)
        or (old.archive_sha256_verified is not null and new.archive_sha256_verified is distinct from old.archive_sha256_verified)
        or (old.cloud_purged_at         is not null and new.cloud_purged_at         is distinct from old.cloud_purged_at) then
            raise exception 'Evidence archive fields can be set only once' using errcode = '42501';
        end if;
    end if;
    return new;
end $$;

-- New rows never arrive pre-archived from API users.
create or replace function public.evidence_insert_archive_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
    if not private.is_archive_writer()
       and (new.archived_at is not null or new.archive_location is not null
            or new.archive_sha256_verified is not null or new.cloud_purged_at is not null) then
        raise exception 'Evidence archive fields are written by the archive job only'
            using errcode = '42501';
    end if;
    return new;
end $$;
create trigger trg_evidence_insert_archive_guard before insert on public.evidence
    for each row execute function public.evidence_insert_archive_guard();
revoke execute on function public.evidence_insert_archive_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Upload permission check for the R2 presigner (called with the user's JWT)
-- Staff: any existing task. Field: own task that is pending / in progress.
-- ---------------------------------------------------------------------
create or replace function public.can_upload_evidence(p_task_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(
        (public.is_staff() and exists (select 1 from public.tasks t where t.id = p_task_id))
        or (public.is_field() and exists (
                select 1 from public.tasks t
                where t.id = p_task_id
                  and t.assignee_id = (select auth.uid())
                  and t.status in ('pending', 'in_progress'))),
        false);
$$;
revoke all on function public.can_upload_evidence(uuid) from public, anon;
grant execute on function public.can_upload_evidence(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Purge candidates for the archive job (service role only)
-- Archived + hash-verified, not yet purged, the case has a submission older
-- than p_days, and no open task on the case (re-investigation in progress).
-- Cases without a submission (e.g. closed/cancelled without submitting) are
-- never eligible.
-- ---------------------------------------------------------------------
create or replace function public.evidence_purge_candidates(p_days int default 7)
returns table (evidence_id uuid, case_id uuid, storage_backend text, storage_path text,
               archive_location text, archived_at timestamptz, last_submitted_at timestamptz)
language sql stable set search_path = '' as $$
    select e.id, e.case_id, e.storage_backend, e.storage_path, e.archive_location, e.archived_at, s.last_submitted_at
    from public.evidence e
    join lateral (select max(sub.submitted_at) as last_submitted_at
                  from public.submissions sub where sub.case_id = e.case_id) s on true
    where e.storage_path is not null
      and e.archived_at is not null
      and e.archive_sha256_verified is true
      and e.cloud_purged_at is null
      and s.last_submitted_at < now() - make_interval(days => greatest(p_days, 0))
      and not exists (select 1 from public.tasks t
                      where t.case_id = e.case_id and t.status in ('pending', 'in_progress'))
    order by e.case_id, e.id;
$$;
revoke all on function public.evidence_purge_candidates(int) from public, anon, authenticated;
grant execute on function public.evidence_purge_candidates(int) to service_role;
