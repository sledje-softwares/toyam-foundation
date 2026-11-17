-- Presign check for the shrunk copies the field app uploads next to its photos (edge function
-- evidence-upload, `derivatives`). Copies are a rebuildable cache, not evidence (D51); the original
-- must exist on the case, be captured by the caller, be a photo and not withdrawn.
--
--   device_derivative_target(task, original sha256[]) -> jsonb
--     { "case_id": uuid, "allowed": bool,
--       "originals": { "<sha256>": [widths already recorded] } }     only usable originals are listed
--   allowed = the same rule as record_device_derivative (the operator still sees the case, or is
--   inside the D43 late window of a task they held there). Field operators only (deactivated phones
--   use field-drain, which does not handle copies).
-- Errcodes: 42501 not a field operator / no access to the task · 22023 bad input.
create or replace function public.device_derivative_target(p_task_id uuid, p_originals text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
    v_uid  uuid := (select auth.uid());
    v_case uuid;
begin
    if p_originals is null or cardinality(p_originals) not between 1 and 30
       or exists (select 1 from unnest(p_originals) s where s is null or s !~ '^[0-9a-f]{64}$') then
        raise exception 'originals must be 1-30 values of 64 lower-case hex characters' using errcode = '22023';
    end if;
    if not public.is_field() then
        raise exception 'Only field operators upload copies made on their phone' using errcode = '42501';
    end if;
    select t.case_id into v_case from public.tasks t
     where t.id = p_task_id
       and (t.assignee_id = v_uid
            or exists (select 1 from public.task_holds h where h.task_id = t.id and h.profile_id = v_uid));
    if v_case is null then
        raise exception 'Task not found' using errcode = '42501';
    end if;
    return jsonb_build_object(
        'case_id', v_case,
        'allowed', private.field_derivative_access(v_case, v_uid),
        'originals', coalesce((
            select jsonb_object_agg(e.sha256, coalesce(
                       (select jsonb_agg(d.width order by d.width) from public.evidence_derivatives d where d.evidence_id = e.id),
                       '[]'::jsonb))
              from public.evidence e
             where e.case_id = v_case and e.sha256 = any (p_originals)
               and e.captured_by = v_uid and e.evidence_type = 'photo' and e.withdrawn_at is null), '{}'::jsonb));
end $$;
revoke all on function public.device_derivative_target(uuid, text[]) from public, anon;
grant execute on function public.device_derivative_target(uuid, text[]) to authenticated;
