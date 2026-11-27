-- D54 (2026-11-27): field operators comment on a file after they sent it.
--
-- A comment belongs to the file, not to the thread: it is NOT a case_messages row, it does not show as
-- a chat bubble and it does not raise the unread badge. It is shown to office staff beside the image,
-- passed to the per-image LLM labeller together with the image, and kept for a later report-drafting
-- step. Comments are evidence-like records: append-only, never edited or deleted (rule 2 spirit).
--
--   1. public.evidence_comments: one row per comment; case_id is copied from the evidence row by the
--      insert trigger (never trusted from the caller); created_at is set by the database (rule 3).
--      Guard trigger refuses every UPDATE and DELETE. Idempotent on client_comment_id (rule 6).
--   2. RLS: read only. Staff through private.can_manage_evidence() (D44: an office user sees the comments
--      of files on cases they own). Field users read the comments of the files they can see: the
--      `exists` runs under the caller's own RLS on evidence (p_evidence_field_r), so staff-only messages,
--      withdrawn files of others and other operators' cases stay hidden (rule 4). No insert / update /
--      delete policy: comments are written only by add_evidence_comment().
--   3. public.add_evidence_comment(evidence, body, client_comment_id): field operator with an open task
--      on an open case (private.field_can_post), on a file sent in a thread message visible to everyone,
--      not withdrawn. Body trimmed, 1-1000 characters; at most 50 comments per file and author.
--   4. The file's `label` job is re-queued (2-minute delay, so several comments typed in a row are
--      labelled once) so the labeller sees the comment. A job running at that moment is left alone;
--      complete_processing_job() re-queues it instead of finishing it when a comment arrived after the
--      job started (otherwise the comment would never reach the labeller).
--   5. Realtime publication (RLS applies), audit trail.
--
-- Field users read the file's labels and the LLM description (evidence_labels incl. description, policy
-- p_labels_read since 20261115500000); OCR stays staff-only (rule 4). Pinned by supabase/tests/33.

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table public.evidence_comments (
    id                uuid primary key default gen_random_uuid(),
    evidence_id       uuid not null references public.evidence(id),
    case_id           uuid not null references public.cases(id),          -- copied from the evidence row
    author_id         uuid not null references public.profiles(id),
    body              text not null check (char_length(btrim(body)) between 1 and 1000),
    client_comment_id uuid not null unique,                               -- idempotency key from the app
    created_at        timestamptz not null default now()
);
create index ix_evidence_comments_evidence on public.evidence_comments (evidence_id, created_at);

comment on table public.evidence_comments is
    'D54: comments a field operator adds to a file after sending it. Part of the file (not thread messages): '
    'shown to staff beside the image, given to the labeller, kept for report drafting. Append-only.';
comment on column public.evidence_comments.case_id is 'Copied from evidence.case_id by the insert trigger';
comment on column public.evidence_comments.client_comment_id is 'Idempotency key generated on the phone (outbox retries)';

-- Insert: case_id from the evidence row, server time. Update / delete: refused for every writer.
create or replace function private.evidence_comments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'File comments cannot be deleted' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
        raise exception 'File comments cannot be edited' using errcode = '42501';
    end if;
    select e.case_id into new.case_id from public.evidence e where e.id = new.evidence_id;
    if new.case_id is null then
        raise exception 'File not found' using errcode = 'P0002';
    end if;
    new.body       := btrim(new.body);
    new.created_at := now();
    return new;
end $$;
create trigger trg_evidence_comments_guard before insert or update or delete on public.evidence_comments
    for each row execute function private.evidence_comments_guard();

create trigger trg_evidence_comments_audit after insert on public.evidence_comments
    for each row execute function private.audit_row();

-- ---------------------------------------------------------------------
-- 2. Access
-- ---------------------------------------------------------------------
alter table public.evidence_comments enable row level security;

create policy p_evidence_comments_read on public.evidence_comments for select to authenticated
    using (private.can_manage_evidence(evidence_id)
           or (public.is_field() and exists (select 1 from public.evidence e where e.id = evidence_id)));

comment on policy p_evidence_comments_read on public.evidence_comments is
    'Staff: files on cases they manage (D44). Field: comments of the files they can see (RLS on evidence, rule 4).';

revoke all on table public.evidence_comments from anon, public;
revoke insert, update, delete, truncate, references, trigger on table public.evidence_comments from authenticated;
grant select on table public.evidence_comments to authenticated;

-- ---------------------------------------------------------------------
-- 3. Label job re-queue
-- ---------------------------------------------------------------------
-- The newest label job of the file (highest pipeline version row) is put back in the queue, unless it is
-- running (complete_processing_job handles that case) or skipped (the stage does not apply, e.g. the file
-- type has no labeller or a rule already labelled it). Files without a label job get none. Only the newest
-- row: older pipeline versions are history, re-running them would pay for the same answer twice.
create or replace function private.evidence_comments_requeue_label() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    update public.processing_jobs j
       set status = 'queued', attempts = 0, run_after = now() + interval '2 minutes',
           locked_at = null, locked_by = null, last_error = null, finished_at = null
     where j.id = (select max(l.id) from public.processing_jobs l
                    where l.evidence_id = new.evidence_id and l.stage = 'label')
       and j.status in ('queued', 'done', 'failed');
    return null;
end $$;
create trigger trg_evidence_comments_requeue after insert on public.evidence_comments
    for each row execute function private.evidence_comments_requeue_label();

-- Worker API (unchanged signature, service role only): as before, plus — a label job finishing `done`
-- goes back to the queue (2 minutes, attempts reset) when a comment on its file arrived after the job
-- started, because the labeller read the comments before that comment existed.
create or replace function public.complete_processing_job(p_job_id bigint, p_status public.job_status,
                                                          p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.processing_jobs;
begin
    select * into v from public.processing_jobs where id = p_job_id for update;
    if not found or v.status <> 'running' then
        raise exception 'Job % is not running', p_job_id using errcode = '22023';
    end if;
    if p_status = 'failed' and v.attempts < v.max_attempts then
        update public.processing_jobs
           set status = 'queued', last_error = p_error, locked_at = null, locked_by = null,
               run_after = now() + make_interval(mins => power(2, v.attempts)::int)
         where id = p_job_id;
    elsif p_status = 'done' and v.stage = 'label'
          and exists (select 1 from public.evidence_comments c
                       where c.evidence_id = v.evidence_id and c.created_at >= coalesce(v.started_at, v.locked_at)) then
        update public.processing_jobs
           set status = 'queued', attempts = 0, run_after = now() + interval '2 minutes',
               locked_at = null, locked_by = null, last_error = null, finished_at = null
         where id = p_job_id;
    elsif p_status in ('done', 'failed', 'skipped') then
        update public.processing_jobs
           set status = p_status, last_error = p_error, finished_at = now(), locked_at = null
         where id = p_job_id;
    else
        raise exception 'Final status must be done, failed or skipped' using errcode = '22023';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Field RPC
-- ---------------------------------------------------------------------
-- Errcodes: 42501 not a field user / no open task on an open case; 22023 bad input (missing id, empty or
-- too long body, file not sent in the thread); P0002 file not found (also for files the caller cannot
-- see: other operators' cases, staff-only messages, so nothing leaks); 55000 withdrawn file; 54000 more
-- than 50 comments by the caller on the file; 23505 client_comment_id already used for another file or
-- author. A retry with the same client_comment_id, author and file returns the stored id before any
-- other check (the outbox may resend after the task closed).
create or replace function public.add_evidence_comment(p_evidence_id uuid, p_body text, p_client_comment_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
    v_uid  uuid := (select auth.uid());
    v_body text := btrim(coalesce(p_body, ''));
    v_ev   public.evidence;
    v_vis  text;
    v_old  public.evidence_comments;
    v_id   uuid;
begin
    if not public.is_field() then
        raise exception 'Only field operators can comment on a file' using errcode = '42501';
    end if;
    if p_client_comment_id is null then
        raise exception 'client_comment_id is required' using errcode = '22023';
    end if;

    -- retry of an already stored comment (the outbox may resend after the task closed)
    select * into v_old from public.evidence_comments c where c.client_comment_id = p_client_comment_id;
    if found then
        if v_old.author_id = v_uid and v_old.evidence_id = p_evidence_id then
            return v_old.id;
        end if;
        raise exception 'client_comment_id is already used for another comment' using errcode = '23505';
    end if;

    if v_body = '' then
        raise exception 'A comment needs some text' using errcode = '22023';
    end if;
    if char_length(v_body) > 1000 then
        raise exception 'A comment can be at most 1000 characters' using errcode = '22023';
    end if;

    select * into v_ev from public.evidence e where e.id = p_evidence_id;
    if v_ev.id is not null and v_ev.message_id is not null then
        select m.visibility into v_vis from public.case_messages m where m.id = v_ev.message_id;
    end if;
    -- not found, other operators' cases and staff-only files all look the same (rule 4)
    if v_ev.id is null or not private.field_can_see_case(v_ev.case_id)
       or (v_ev.message_id is not null and v_vis is distinct from 'all') then
        raise exception 'File not found' using errcode = 'P0002';
    end if;
    if v_ev.message_id is null then
        raise exception 'Comments can be added only to files sent in the case thread' using errcode = '22023';
    end if;
    if v_ev.withdrawn_at is not null then
        raise exception 'This file was withdrawn' using errcode = '55000';
    end if;
    if not private.field_can_post(v_ev.case_id) then
        raise exception 'You have no open task on this case' using errcode = '42501';
    end if;

    -- one writer per file and author at a time (cap)
    perform pg_advisory_xact_lock(hashtextextended('add_evidence_comment:' || p_evidence_id::text || ':' || v_uid::text, 0));
    if (select count(*) from public.evidence_comments c
         where c.evidence_id = p_evidence_id and c.author_id = v_uid) >= 50 then
        raise exception 'At most 50 comments per file' using errcode = '54000';
    end if;

    insert into public.evidence_comments (evidence_id, case_id, author_id, body, client_comment_id)
    values (p_evidence_id, v_ev.case_id, v_uid, v_body, p_client_comment_id)
    on conflict (client_comment_id) do nothing
    returning id into v_id;
    if v_id is null then                                    -- a concurrent retry stored it first
        select * into v_old from public.evidence_comments c where c.client_comment_id = p_client_comment_id;
        if v_old.author_id = v_uid and v_old.evidence_id = p_evidence_id then
            return v_old.id;
        end if;
        raise exception 'client_comment_id is already used for another comment' using errcode = '23505';
    end if;
    return v_id;
end $$;

comment on function public.add_evidence_comment(uuid, text, uuid) is
    'D54: field operator adds a comment to a file they can see in an open case thread; idempotent on '
    'client_comment_id; re-queues the file''s label job';

revoke all on function public.add_evidence_comment(uuid, text, uuid) from public, anon;
grant execute on function public.add_evidence_comment(uuid, text, uuid) to authenticated;

revoke all on function private.evidence_comments_guard(), private.evidence_comments_requeue_label()
    from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Realtime (Supabase postgres_changes respects RLS)
-- ---------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'evidence_comments') then
        alter publication supabase_realtime add table public.evidence_comments;
    end if;
end $$;
