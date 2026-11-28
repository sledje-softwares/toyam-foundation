-- =====================================================================
-- Performance at volume (no behaviour change; no RPC / view signature or return shape changes)
--
-- Measured with supabase/perf/volume.sql (4 000 cases, 12 000 tasks, ~190 000 messages,
-- ~150 000 files) and supabase/perf/explain.sql (each hot path as the orchestrator, an office
-- employee and a field operator through RLS). Results: supabase/perf/README.md.
--
-- 1. RLS helpers are evaluated once per statement instead of once per row.
--    public.is_staff() / is_field() / is_admin() carry `set search_path`, so PostgreSQL never
--    inlines them, and private.can_manage_case() etc. are security definer: every policy call
--    ran per row (with a profiles lookup inside each). Policies now wrap argument-free helpers
--    in `(select …)` (one InitPlan per statement) and replace the per-row case check by a
--    short-circuit for admin / orchestrator plus a hashed semi-join for office employees and
--    field operators:
--        private.can_manage_case(x)   ==  (select private.sees_all_cases()) or x in (select private.office_case_ids())
--        private.field_can_see_case(x) ==  x in (select private.field_case_ids())
--    Both sides are equal for every caller (admin / orchestrator: true; office: the case is
--    theirs; field / inactive / unknown: false, or NULL where the old form gave false, which RLS
--    treats the same in USING and WITH CHECK). Per-file / per-task / per-report checks keep the
--    per-row function for office employees but skip it for admin / orchestrator and for every
--    other role. supabase/tests/34_performance.test.sql restores the old policies inside its
--    transaction and proves that every role sees exactly the same rows.
-- 2. private.can_manage_case / _case_owner / _task / _evidence / _report: same answers, one
--    statement each (no nested current_user_role() call).
-- 3. Indexes for the real filter / join paths (see each one); two indexes dropped that are exact
--    prefixes of a unique index with the same predicate.
-- 4. public.staff_workload(): open cases per office owner and open tasks per operator in one
--    call (the web read up to 10 000 / 5 000 rows to count them). Security invoker: the caller
--    sees counts over the rows RLS already shows them (D44), field users get nothing.
-- 5. private.match_filename_categories(): one subtransaction per file instead of one per
--    pattern (65 per file; ~11 ms per insurer attachment before). Same categories in the same
--    order; when a pattern fails to compile it falls back to the old per-pattern loop, warnings
--    included (a broken pattern is only reported once the fast path reaches it).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------
create or replace function private.sees_all_cases() returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce(private.current_user_role() in ('admin', 'orchestrator'), false);
$$;

-- Cases an active office employee owns (empty for every other role): the office side of
-- private.can_manage_case() as a set, so a policy builds it once and probes a hash per row.
create or replace function private.office_case_ids() returns setof uuid
language sql stable security definer set search_path = '' rows 1000 as $$
    select c.id from public.cases c
     where c.office_owner_id = (select auth.uid())
       and private.current_user_role() = 'office';
$$;

-- Cases on which the caller holds (or held) a task: private.field_can_see_case() as a set.
create or replace function private.field_case_ids() returns setof uuid
language sql stable security definer set search_path = '' rows 100 as $$
    select distinct t.case_id from public.tasks t where t.assignee_id = (select auth.uid());
$$;

revoke all on function private.sees_all_cases(), private.office_case_ids(), private.field_case_ids() from public, anon;
grant execute on function private.sees_all_cases(), private.office_case_ids(), private.field_case_ids() to authenticated, service_role;

-- Same answers as before (20261115500000 / 20261115800000), one statement each.
create or replace function private.can_manage_case(p_case_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select case p.role
                 when 'admin' then true
                 when 'orchestrator' then true
                 when 'office' then exists (select 1 from public.cases c where c.id = p_case_id and c.office_owner_id = p.id)
                 else false end
          from public.profiles p where p.id = (select auth.uid()) and p.is_active), false);
$$;

create or replace function private.can_manage_case_owner(p_office_owner_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select case p.role
                 when 'admin' then true
                 when 'orchestrator' then true
                 when 'office' then p_office_owner_id is not null and p_office_owner_id = p.id
                 else false end
          from public.profiles p where p.id = (select auth.uid()) and p.is_active), false);
$$;

create or replace function private.can_manage_task(p_task_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select case p.role
                 when 'admin' then true
                 when 'orchestrator' then true
                 when 'office' then exists (select 1 from public.tasks t join public.cases c on c.id = t.case_id
                                             where t.id = p_task_id and c.office_owner_id = p.id)
                 else false end
          from public.profiles p where p.id = (select auth.uid()) and p.is_active), false);
$$;

create or replace function private.can_manage_evidence(p_evidence_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select case p.role
                 when 'admin' then true
                 when 'orchestrator' then true
                 when 'office' then exists (select 1 from public.evidence e join public.cases c on c.id = e.case_id
                                             where e.id = p_evidence_id and c.office_owner_id = p.id)
                 else false end
          from public.profiles p where p.id = (select auth.uid()) and p.is_active), false);
$$;

create or replace function private.can_manage_report(p_report_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
    select coalesce((
        select case p.role
                 when 'admin' then true
                 when 'orchestrator' then true
                 when 'office' then exists (select 1 from public.reports r join public.cases c on c.id = r.case_id
                                             where r.id = p_report_id and c.office_owner_id = p.id)
                 else false end
          from public.profiles p where p.id = (select auth.uid()) and p.is_active), false);
$$;

-- ---------------------------------------------------------------------
-- 2. Policies (same names, roles and commands; expressions evaluated once per statement)
--    CM(x)  = (select private.sees_all_cases()) or x in (select private.office_case_ids())
--    FC(x)  = (select public.is_field()) and x in (select private.field_case_ids())
-- ---------------------------------------------------------------------

-- settings, rules, templates, categories, insurers, profiles: argument-free helpers only
alter policy p_settings_admin on public.app_settings using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_settings_read on public.app_settings using ((select public.is_staff()));
alter policy p_rule_members_write on public.assignment_rule_members
    using ((select private.current_user_role()) = any (array['admin', 'orchestrator']::public.user_role[]))
    with check ((select private.current_user_role()) = any (array['admin', 'orchestrator']::public.user_role[]));
alter policy p_rule_members_read on public.assignment_rule_members using ((select public.is_staff()));
alter policy p_rules_write on public.assignment_rules
    using ((select private.current_user_role()) = any (array['admin', 'orchestrator']::public.user_role[]))
    with check ((select private.current_user_role()) = any (array['admin', 'orchestrator']::public.user_role[]));
alter policy p_rules_read on public.assignment_rules using ((select public.is_staff()));
alter policy p_audit_admin on public.audit_log using ((select public.is_admin()));
alter policy p_ctcf_admin on public.case_template_category_fields using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctcf_read on public.case_template_category_fields using ((select public.is_staff()));
alter policy p_ctcl_admin on public.case_template_checklists using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctcl_read on public.case_template_checklists using ((select public.is_staff()));
alter policy p_ctpf_admin on public.case_template_fields using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctpf_read on public.case_template_fields using ((select public.is_staff()));
alter policy p_ctsc_admin on public.case_template_section_categories using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctsc_read on public.case_template_section_categories using ((select public.is_staff()));
alter policy p_ctps_admin on public.case_template_sections using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctps_read on public.case_template_sections using ((select public.is_staff()));
alter policy p_ctpl_admin on public.case_templates using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_ctpl_read on public.case_templates using ((select public.is_staff()));
alter policy p_tpli_admin on public.checklist_template_items using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_tpli_read on public.checklist_template_items using ((select public.is_staff()));
alter policy p_tpl_admin on public.checklist_templates using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_tpl_read on public.checklist_templates using ((select public.is_staff()));
alter policy p_categories_admin on public.evidence_categories using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_categories_read on public.evidence_categories using ((select public.is_staff()) or (select public.is_field()));
alter policy p_insurers_admin on public.insurers using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_insurers_read on public.insurers using ((select public.is_staff()) or (select public.is_field()));
alter policy p_entities_staff on public.entities using ((select public.is_staff())) with check ((select public.is_staff()));
alter policy p_profiles_admin on public.profiles using ((select public.is_admin())) with check ((select public.is_admin()));
alter policy p_profiles_self on public.profiles using (id = (select auth.uid()) or (select public.is_staff()));
alter policy p_tokens_own on public.device_tokens
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()) and (select private.current_user_role()) is not null);

-- cases
alter policy p_cases_staff on public.cases
    using ((select private.sees_all_cases()) or id in (select private.office_case_ids()))
    with check ((select private.sees_all_cases()) or private.can_manage_case_owner(office_owner_id));
alter policy p_cases_field on public.cases
    using ((select public.is_field()) and id in (select private.field_case_ids()));

-- case-scoped tables
alter policy p_assignments_read on public.case_assignments
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_case_ent_staff on public.case_entities
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
    with check ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_cfv_field on public.case_field_values
    using ((select public.is_field()) and case_id in (select private.field_case_ids()) and private.is_intake_field(field_id));
alter policy p_cfv_staff_r on public.case_field_values
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_msg_field_w on public.case_messages
    with check ((select public.is_field()) and sender_id = (select auth.uid())
                and kind = any (array['text', 'media', 'voice']::public.message_kind[]) and visibility = 'all'
                and private.field_can_post(case_id));
alter policy p_msg_staff_w on public.case_messages
    with check (((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
                and sender_id = (select auth.uid()) and kind = any (array['text', 'media', 'voice']::public.message_kind[]));
alter policy p_msg_field_r on public.case_messages
    using ((select public.is_field()) and visibility = 'all' and case_id in (select private.field_case_ids()));
alter policy p_msg_staff_r on public.case_messages
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_hist_staff on public.case_status_history
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_reads_own on public.case_thread_reads
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid())
                and ((select private.sees_all_cases()) or case_id in (select private.office_case_ids())
                     or ((select public.is_field()) and private.field_can_see_case(case_id))));
alter policy p_parties_staff on public.parties
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
    with check ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_parties_field on public.parties
    using ((select public.is_field()) and case_id in (select private.field_case_ids()));
alter policy p_approvals_i on public.report_approvals
    with check (((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
                and requested_by = (select auth.uid()));
alter policy p_approvals_r on public.report_approvals
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_approvals_u on public.report_approvals
    using ((select private.current_user_role()) = any (array['orchestrator', 'admin']::public.user_role[]))
    with check ((select private.current_user_role()) = any (array['orchestrator', 'admin']::public.user_role[]));
alter policy p_rsends_staff_r on public.report_sends
    using ((select public.is_staff()) and ((select private.sees_all_cases()) or case_id in (select private.office_case_ids())));
alter policy p_reports_staff on public.reports
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
    with check ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_subs_staff_i on public.submissions
    with check ((select public.is_staff()) and submitted_by = (select auth.uid())
                and ((select private.sees_all_cases()) or case_id in (select private.office_case_ids())));
alter policy p_subs_staff_r on public.submissions
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_tasks_staff_i on public.tasks
    with check ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_tasks_staff_r on public.tasks
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_tasks_field_r on public.tasks
    using ((select public.is_field()) and assignee_id = (select auth.uid()));
alter policy p_tasks_field_u on public.tasks
    using ((select public.is_field()) and assignee_id = (select auth.uid()))
    with check ((select public.is_field()) and assignee_id = (select auth.uid()));

-- intake (unlinked rows: any staff; linked rows follow the case)
alter policy p_emails_staff on public.emails
    using ((select private.sees_all_cases())
           or ((select public.is_staff()) and (case_id is null or case_id in (select private.office_case_ids()))))
    with check ((select private.sees_all_cases())
                or ((select public.is_staff()) and (case_id is null or case_id in (select private.office_case_ids()))));
alter policy p_extract_staff on public.intake_extractions
    using ((select private.sees_all_cases())
           or ((select public.is_staff()) and (case_id is null or case_id in (select private.office_case_ids()))))
    with check ((select private.sees_all_cases())
                or ((select public.is_staff()) and (case_id is null or case_id in (select private.office_case_ids()))));
alter policy p_attach_staff on public.email_attachments
    using ((select private.sees_all_cases()) or ((select public.is_staff()) and private.can_manage_email(email_id)));

-- evidence
alter policy p_evidence_field_w on public.evidence
    with check ((select public.is_field()) and captured_by = (select auth.uid())
                and capture_source = any (array['camera', 'gallery', 'share']::public.capture_source[])
                and exists (select 1 from public.tasks t
                             where t.id = evidence.task_id and t.case_id = evidence.case_id and t.assignee_id = (select auth.uid())
                               and t.status = any (array['pending', 'in_progress']::public.task_status[])));
alter policy p_evidence_staff_w on public.evidence
    with check (((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
                and captured_by = (select auth.uid()));
alter policy p_evidence_field_r on public.evidence
    using ((select public.is_field())
           and (captured_by = (select auth.uid())
                or (message_id is not null and withdrawn_at is null
                    and case_id in (select private.field_case_ids())
                    and exists (select 1 from public.case_messages m where m.id = evidence.message_id and m.visibility = 'all'))));
alter policy p_evidence_staff_r on public.evidence
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));
alter policy p_evidence_staff_u on public.evidence
    using ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()))
    with check ((select private.sees_all_cases()) or case_id in (select private.office_case_ids()));

-- per-file tables: office keeps the per-row check, everyone else skips it
alter policy p_evidence_comments_read on public.evidence_comments
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id))
           or ((select public.is_field()) and exists (select 1 from public.evidence e where e.id = evidence_comments.evidence_id)));
alter policy p_derivatives_field_r on public.evidence_derivatives
    using ((select public.is_field()) and exists (select 1 from public.evidence e where e.id = evidence_derivatives.evidence_id));
alter policy p_derivatives_staff_r on public.evidence_derivatives
    using ((select public.is_staff())
           and ((select private.sees_all_cases())
                or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id))));
alter policy p_field_matches_staff on public.evidence_field_matches
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)));
alter policy p_labels_field_w on public.evidence_labels
    with check ((select public.is_field()) and source = 'operator'
                and exists (select 1 from public.evidence e where e.id = evidence_labels.evidence_id and e.captured_by = (select auth.uid())));
alter policy p_labels_staff_w on public.evidence_labels
    with check (((select private.sees_all_cases())
                 or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)))
                and source = any (array['human', 'operator']::public.label_source[]));
alter policy p_labels_read on public.evidence_labels
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id))
           or ((select public.is_field()) and exists (select 1 from public.evidence e where e.id = evidence_labels.evidence_id)));
alter policy p_ocr_staff on public.evidence_ocr
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)));
alter policy p_suggest_staff on public.field_suggestions
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)));
alter policy p_suggest_staff_u on public.field_suggestions
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)))
    with check ((select private.sees_all_cases())
                or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id)));
alter policy p_jobs_read on public.processing_jobs
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_evidence(evidence_id))
           or ((select public.is_field()) and exists (select 1 from public.evidence e where e.id = processing_jobs.evidence_id)));

-- per-task / per-report / outbox tables
alter policy p_checklist_staff on public.task_checklist_items
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_task(task_id)))
    with check ((select private.sees_all_cases())
                or ((select private.current_user_role()) = 'office' and private.can_manage_task(task_id)));
alter policy p_check_field_r on public.task_checklist_items
    using ((select public.is_field())
           and exists (select 1 from public.tasks t where t.id = task_checklist_items.task_id and t.assignee_id = (select auth.uid())));
alter policy p_check_field_u on public.task_checklist_items
    using ((select public.is_field())
           and exists (select 1 from public.tasks t where t.id = task_checklist_items.task_id and t.assignee_id = (select auth.uid())
                         and t.status = any (array['pending', 'in_progress']::public.task_status[])))
    with check ((select public.is_field())
                and exists (select 1 from public.tasks t where t.id = task_checklist_items.task_id and t.assignee_id = (select auth.uid())
                              and t.status = any (array['pending', 'in_progress']::public.task_status[])));
alter policy p_task_holds_staff on public.task_holds
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_task(task_id)));
alter policy p_rannex_staff on public.report_annexures
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_report(report_id)))
    with check ((select private.sees_all_cases())
                or ((select private.current_user_role()) = 'office' and private.can_manage_report(report_id)));
alter policy p_rfiles_staff on public.report_files
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_manage_report(report_id)))
    with check ((select private.sees_all_cases())
                or ((select private.current_user_role()) = 'office' and private.can_manage_report(report_id)));
alter policy p_outbox_own_r on public.device_outbox_status
    using ((select public.is_field()) and profile_id = (select auth.uid()));
alter policy p_outbox_staff_r on public.device_outbox_status
    using ((select private.sees_all_cases())
           or ((select private.current_user_role()) = 'office' and private.can_see_operator_outbox(profile_id)));

-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------
-- open cases per owner (staff_workload, /cases/new and reassign counts, dashboard workload)
create index ix_cases_open_owner on public.cases (office_owner_id)
    where status not in ('submitted', 'closed', 'cancelled');
-- /tasks list and count: open tasks by due date
create index ix_tasks_open_due on public.tasks (due_at, id) where status in ('pending', 'in_progress');
-- values of one template field across cases (insured-name search and columns on /cases, /reports)
create index ix_case_field_values_field on public.case_field_values (field_id);
-- approvals embedded per case (/reports list, report workspace)
create index ix_report_approvals_case on public.report_approvals (case_id);
-- /dashboard turnaround: status changes since a date
create index ix_status_hist_changed on public.case_status_history (changed_at);
-- case_field_history(): field-value changes of one case in the audit log
create index ix_audit_field_values_case on public.audit_log
    ((coalesce(new_data ->> 'case_id', old_data ->> 'case_id')), at desc)
    where table_name = 'case_field_values';
-- escalate_stuck_intake_retries(): rows not yet alerted (nothing to read when nothing is stuck)
create index ix_emails_retry_alert on public.emails (retry_requested_at, id)
    where retry_alerted_at is null and status in ('retry_requested', 'failed');

-- pipeline worker: jobs it holds (listRunningJobs reads status = 'running'; the queue index only covers 'queued')
create index ix_processing_jobs_running on public.processing_jobs (locked_at) where status = 'running';

-- exact prefixes of a unique index with the same predicate
drop index public.ix_evidence_labels_active;            -- = uq_evidence_labels_active (evidence_id, category_id, source) where is_active
drop index public.ix_evidence_field_matches_evidence;   -- = evidence_field_matches_evidence_id_field_id_pipeline_versio_key

-- ---------------------------------------------------------------------
-- 4. Workload counts
-- ---------------------------------------------------------------------
create or replace function public.staff_workload()
returns table (profile_id uuid, open_cases int, open_tasks int)
language sql stable security invoker set search_path = '' as $$
    with c as (select c.office_owner_id as pid, count(*)::int as n from public.cases c
                where c.status not in ('submitted', 'closed', 'cancelled') and c.office_owner_id is not null
                group by c.office_owner_id),
         t as (select t.assignee_id as pid, count(*)::int as n from public.tasks t
                where t.status in ('pending', 'in_progress') and t.assignee_id is not null
                group by t.assignee_id)
    select coalesce(c.pid, t.pid), coalesce(c.n, 0), coalesce(t.n, 0)
      from c full join t on t.pid = c.pid
     where (select public.is_staff());
$$;
comment on function public.staff_workload() is
    'Open cases (status not submitted / closed / cancelled) per office owner and open tasks (pending / in_progress) per assignee, '
    'counted over the rows the caller can see (RLS, D44). Staff only; empty for field users.';
revoke all on function public.staff_workload() from public, anon;
grant execute on function public.staff_workload() to authenticated;

-- ---------------------------------------------------------------------
-- 5. Filename labels: one subtransaction per file
-- ---------------------------------------------------------------------
create or replace function private.match_filename_categories(p_name text) returns setof uuid
language plpgsql stable set search_path = '' as $$
declare v_variants text[] := private.filename_label_variants(p_name); c record; p text; v_hit boolean; v_seen uuid[] := '{}';
        v_ids uuid[] := '{}'; v_failed boolean := false;
begin
    if coalesce(array_length(v_variants, 1), 0) = 0 or v_variants[1] = '' then return; end if;
    -- fast path: every pattern of every category in one subtransaction
    begin
        for c in select ec.id, ec.filename_patterns from public.evidence_categories ec
                  where ec.is_active and ec.filename_patterns <> '{}' order by ec.code loop
            if exists (select 1 from unnest(c.filename_patterns) pt, unnest(v_variants) v
                        where v ~* replace(pt, '\b', '\y')) then
                v_ids := v_ids || c.id;
            end if;
        end loop;
    exception when others then
        v_failed := true;
    end;
    if not v_failed then
        return query select x from unnest(v_ids) with ordinality u(x, n) order by n;
        return;
    end if;
    -- a pattern does not compile: the original per-pattern loop (skips it with a warning)
    for c in select ec.id, ec.code, ec.filename_patterns from public.evidence_categories ec
              where ec.is_active and ec.filename_patterns <> '{}' order by ec.code loop
        v_hit := false;
        foreach p in array c.filename_patterns loop
            begin
                -- config patterns are JS/PCRE style; PostgreSQL's \b is a backspace, its word boundary is \y
                p := replace(p, '\b', '\y');
                if exists (select 1 from unnest(v_variants) v where v ~* p) then v_hit := true; exit; end if;
            exception when others then
                raise warning 'filename_patterns of category % skipped: %', c.code, sqlerrm;
            end;
        end loop;
        if v_hit and not (c.id = any (v_seen)) then v_seen := v_seen || c.id; return next c.id; end if;
    end loop;
end $$;
