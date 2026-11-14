-- =====================================================================
-- Revised workflow (D14-D25), part 1 of 2: enum values.
--
-- New enum values cannot be used in the transaction that adds them, so
-- they live in their own migration ahead of 20261113000100_revised_flow.sql.
--
--   capture_source 'share'  file sent to the field app from another app
--                           through the Android share sheet (D18)
--   case_status    unchanged; mapping of the revised flow is documented
--                  in docs/06-data-model.md
-- =====================================================================

alter type public.capture_source add value if not exists 'share' after 'gallery';
