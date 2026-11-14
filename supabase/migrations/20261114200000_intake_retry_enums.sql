-- =====================================================================
-- Queued intake retry (D39), part 1 of 2: enum value.
--
-- New enum values cannot be used in the transaction that adds them, so this
-- lives ahead of 20261114200100_intake_retry.sql.
--
--   email_status 'retry_requested'  staff asked for a failed email to be processed
--                                   again; the intake Worker's 10-minute cron picks it up
-- Notification kinds are free text (public.notifications.kind), so the new kind
-- 'intake_retry_stuck' needs no enum value.
-- =====================================================================

alter type public.email_status add value if not exists 'retry_requested' after 'failed';
