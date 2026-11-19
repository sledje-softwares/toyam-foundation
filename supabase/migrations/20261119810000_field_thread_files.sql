-- Field thread attachments (2026-11-19, docs/14 gaps 6, 7, 9): the field app shows the files of the
-- messages in a case thread as thumbnails (384 px copy) and in a full-screen viewer (1600 px copy).
--
-- A field operator may already read the evidence rows posted into their own threads (p_evidence_field_r:
-- own files, and files of `visibility = 'all'` messages on cases they can see). Until now they could not
-- read the shrunk copies of those rows, so `evidence-view` with `variant: w384 | w1600` served them the
-- full-size original. This policy lets a field user read a copy row exactly when the evidence row itself
-- is visible to them: the `exists` runs under the caller's own RLS on `evidence`, so staff-only messages,
-- withdrawn files of others and other operators' cases stay hidden (rule 4). Read only; copies are still
-- written only by record_device_derivative().
create policy p_derivatives_field_r on public.evidence_derivatives for select to authenticated
    using (public.is_field() and exists (select 1 from public.evidence e where e.id = evidence_id));

comment on policy p_derivatives_field_r on public.evidence_derivatives is
    'Field users read the copy rows of evidence they can see (thread thumbnails / viewer, evidence-view variants).';
