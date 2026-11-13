-- =====================================================================
-- File storage (M1 1.4): private Supabase Storage buckets and RLS on
-- storage.objects.
--
-- Evidence FILES are NOT stored here: they go to Cloudflare R2 via
-- short-lived presigned PUT URLs issued by a server-side function that
-- checks public.can_upload_evidence() (see 20261111130000_evidence_r2_archive).
--
-- Buckets (both private; access via authenticated / signed URLs):
--   email-raw  raw .eml and attachments; written by the intake service
--              (service role) only, read by staff
--   reports    report files; staff read/write
-- Field users have no access to either bucket.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    -- Insurer attachments can be of any type; only the service role writes here.
    ('email-raw', 'email-raw', false, 52428800, null),  -- 50 MiB
    ('reports', 'reports', false, 26214400,             -- 25 MiB
     array['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/msword',
           'application/pdf'])
on conflict (id) do update
    set public             = excluded.public,
        file_size_limit    = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- email-raw: staff read only; writes by the service role only (no write policy)
create policy email_raw_staff_select on storage.objects for select to authenticated
    using (bucket_id = 'email-raw' and public.is_staff());

-- reports: staff read / write. Reports are versioned (public.reports.version),
-- so files are not deleted through the API (no DELETE policy).
create policy reports_staff_select on storage.objects for select to authenticated
    using (bucket_id = 'reports' and public.is_staff());
create policy reports_staff_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'reports' and public.is_staff());
create policy reports_staff_update on storage.objects for update to authenticated
    using (bucket_id = 'reports' and public.is_staff())
    with check (bucket_id = 'reports' and public.is_staff());
