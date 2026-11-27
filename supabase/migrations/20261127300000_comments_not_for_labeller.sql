-- D54 correction (2026-11-27): operator comments on a file are NOT input to the per-image labeller.
-- They are kept for the office and for the AI report drafting step (later phase, D5 / D25). Comments and
-- the AI label / description are independent: a comment never re-queues or re-runs labelling.
--
-- Undoes part 3 of 20261127100000_evidence_comments.sql (applied on hosted, so not edited):
--   1. drops the trigger that re-queued the file's `label` job on every new comment, and its function;
--   2. restores public.complete_processing_job() to its 20261113000100 definition (no comment check).

drop trigger if exists trg_evidence_comments_requeue on public.evidence_comments;
drop function if exists private.evidence_comments_requeue_label();

-- Worker API (service role only; create or replace keeps the existing grants). Same body as in
-- 20261113000100_revised_flow.sql.
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
    elsif p_status in ('done', 'failed', 'skipped') then
        update public.processing_jobs
           set status = p_status, last_error = p_error, finished_at = now(), locked_at = null
         where id = p_job_id;
    else
        raise exception 'Final status must be done, failed or skipped' using errcode = '22023';
    end if;
end $$;

comment on table public.evidence_comments is
    'D54: field operator comments on a file, append-only. Shown to office staff beside the image; kept for '
    'the AI report drafting step (later phase). Not sent to the labeller and do not re-run labelling.';
