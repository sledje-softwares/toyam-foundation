-- Included twice by explain.sql (\set staff_label / staff_id before \ir). Staff paths of apps/web.
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'staff_id', 'role', 'authenticated')::text, true) \g /dev/null
\echo
\echo == :staff_label
select * from pg_temp.bench(:'staff_label' || ': /cases list (open, due_at, page 1)', $q$
    select c.id, c.case_ref, c.insurer_claim_no, c.claim_type, c.status, c.received_at, c.due_at,
           (select json_build_object('code', i.code, 'name', i.name) from public.insurers i where i.id = c.insurer_id),
           (select json_build_object('full_name', p.full_name) from public.profiles p where p.id = c.office_owner_id)
      from public.cases c
     where c.status in ('received', 'intake_confirmed', 'assigned', 'field_in_progress', 'office_review', 'orchestrator_review')
     order by c.due_at asc, c.id asc limit 25 offset 0 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /cases count exact', $q$
    select count(*) from public.cases c
     where c.status in ('received', 'intake_confirmed', 'assigned', 'field_in_progress', 'office_review', 'orchestrator_review') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /cases insured name of page', $q$
    select v.case_id, v.value from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
     where f.key = 'insured_name' and v.case_id in ($q$ || :'page_ids' || $q$) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case by case_ref', $q$
    select * from public.cases where case_ref = '$q$ || :'case_ref' || $q$' $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case layout counts (messages, files)', $q$
    select (select count(*) from public.case_messages where case_id = '$q$ || :'case_id' || $q$'),
           (select count(*) from public.evidence where case_id = '$q$ || :'case_id' || $q$') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case thread (200, sender, task, files, comments)', $q$
    select m.id, m.created_at, m.kind, m.body, m.visibility, m.withdrawn_at,
           (select json_build_object('full_name', p.full_name, 'role', p.role) from public.profiles p where p.id = m.sender_id),
           (select json_build_object('title', t.title, 'kind', t.kind, 'status', t.status) from public.tasks t where t.id = m.task_id),
           (select json_agg(json_build_object('id', e.id, 'name', e.original_filename, 'type', e.evidence_type,
                                              'comments', (select json_agg(json_build_object('id', c.id)) from public.evidence_comments c where c.evidence_id = e.id)))
              from public.evidence e where e.message_id = m.id)
      from public.case_messages m
     where m.case_id = '$q$ || :'case_id' || $q$' order by m.created_at desc limit 200 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case evidence page (100, all embeds)', $q$
    select e.id, e.sha256, e.original_filename, e.evidence_type, e.server_received_at, e.relevance,
           (select json_build_object('full_name', p.full_name) from public.profiles p where p.id = e.captured_by),
           (select json_build_object('title', t.title) from public.tasks t where t.id = e.task_id),
           (select json_build_object('visibility', m.visibility) from public.case_messages m where m.id = e.message_id),
           (select json_agg(json_build_object('id', l.id, 'is_active', l.is_active, 'description', l.description,
                                              'category', (select json_build_object('name', c.name) from public.evidence_categories c where c.id = l.category_id)))
              from public.evidence_labels l where l.evidence_id = e.id),
           (select json_agg(json_build_object('width', d.width)) from public.evidence_derivatives d where d.evidence_id = e.id),
           (select json_agg(json_build_object('engine', o.engine, 'text', o.text, 'is_current', o.is_current)) from public.evidence_ocr o where o.evidence_id = e.id),
           (select json_agg(json_build_object('id', c.id, 'body', c.body,
                                              'author', (select json_build_object('full_name', p.full_name) from public.profiles p where p.id = c.author_id)))
              from public.evidence_comments c where c.evidence_id = e.id)
      from public.evidence e
     where e.case_id = '$q$ || :'case_id' || $q$' order by e.server_received_at desc, e.id limit 100 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': v_evidence_processing (case)', $q$
    select evidence_id, state from public.v_evidence_processing where case_id = '$q$ || :'case_id' || $q$' $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case tasks + v_case_checklist', $q$
    select (select json_agg(t) from (select id, title, status from public.tasks where case_id = '$q$ || :'case_id' || $q$' order by created_at desc) t),
           (select json_agg(x) from (select task_id, status, is_mandatory, evidence_count from public.v_case_checklist where case_id = '$q$ || :'case_id' || $q$') x) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case_outbox_status()', $q$ select * from public.case_outbox_status('$q$ || :'case_id' || $q$') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': case_field_history() (history page)', $q$ select * from public.case_field_history('$q$ || :'rcase_id' || $q$') limit 500 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /reports list (page 1)', $q$
    select c.id, c.case_ref, c.status, c.due_at,
           (select json_agg(json_build_object('decision', a.decision)) from public.report_approvals a where a.case_id = c.id),
           (select json_agg(json_build_object('version', r.version)) from public.reports r where r.case_id = c.id)
      from public.cases c
     where c.template_id is not null and c.status in ('assigned', 'field_in_progress', 'office_review', 'orchestrator_review')
     order by c.due_at, c.id limit 25 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /reports v_report_progress (25 cases)', $q$
    select case_id, required_total, required_filled, fields_total, fields_filled from public.v_report_progress
     where case_id in ($q$ || :'page_ids' || $q$) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': report workspace values + files', $q$
    select (select json_agg(v) from (select field_id, value, source, updated_at from public.case_field_values where case_id = '$q$ || :'rcase_id' || $q$') v),
           (select json_agg(x) from (select e.id, l.category_id from public.evidence e join public.evidence_labels l on l.evidence_id = e.id and l.is_active
                                      where e.case_id = '$q$ || :'rcase_id' || $q$' and e.withdrawn_at is null and e.evidence_type <> 'note'
                                      order by e.server_received_at desc limit 1000) x),
           (select json_agg(p) from (select evidence_id, state from public.v_evidence_processing where case_id = '$q$ || :'rcase_id' || $q$' limit 1000) p) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': report workspace field matches + suggestions', $q$
    select (select count(*) from public.evidence_field_matches m join public.evidence e on e.id = m.evidence_id
             where e.case_id = '$q$ || :'rcase_id' || $q$' and m.score >= 0.3),
           (select count(*) from public.field_suggestions s join public.evidence e on e.id = s.evidence_id
             where e.case_id = '$q$ || :'rcase_id' || $q$' and s.status = 'pending') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': prepare_report_version()', $q$ select public.prepare_report_version('$q$ || :'rcase_id' || $q$') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': save_case_field_values (1 field)', $q$
    select public.save_case_field_values('$q$ || :'rcase_id' || $q$', jsonb_build_object('insured_name', 'Perf ' || gen_random_uuid()),
           jsonb_build_object('insured_name', (select v.value from public.case_field_values v join public.case_template_fields f on f.id = v.field_id
                                                where v.case_id = '$q$ || :'rcase_id' || $q$' and f.key = 'insured_name'))) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': post_thread_message (text to field)', $q$
    select public.post_thread_message('$q$ || :'case_id' || $q$', gen_random_uuid(), 'text', 'Please call the insured') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /dashboard open cases (cap 5000)', $q$
    select id, insurer_id, due_at, office_owner_id from public.cases where status not in ('submitted', 'closed', 'cancelled') limit 5000 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /dashboard counts (intake, failed, approvals)', $q$
    select (select count(*) from public.intake_extractions where status = 'pending_review'),
           (select count(*) from public.emails where status in ('failed', 'retry_requested')),
           (select count(*) from public.report_approvals where decision = 'pending') $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /dashboard open tasks (cap 5000)', $q$
    select assignee_id from public.tasks where status in ('pending', 'in_progress') limit 5000 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /dashboard status history 30 d', $q$
    select case_id, to_status, changed_at from public.case_status_history where changed_at >= now() - interval '30 days'
     order by changed_at desc limit 5000 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /dashboard escalation notifications', $q$
    select n.id, n.kind, n.title, n.created_at, (select json_build_object('case_ref', c.case_ref) from public.cases c where c.id = n.case_id)
      from public.notifications n where n.kind in ('case_unassigned', 'no_field_task', 'intake_retry_stuck')
     order by n.created_at desc limit 8 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /tasks list (open, due_at, page 1)', $q$
    select t.id, t.title, t.kind, t.status, t.due_at, t.created_at,
           (select json_build_object('case_ref', c.case_ref, 'office_owner_id', c.office_owner_id) from public.cases c where c.id = t.case_id),
           (select json_build_object('full_name', p.full_name) from public.profiles p where p.id = t.assignee_id)
      from public.tasks t
     where t.status in ('pending', 'in_progress') and exists (select 1 from public.cases c where c.id = t.case_id)
     order by t.due_at, t.id limit 25 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /tasks count exact', $q$
    select count(*) from public.tasks t where t.status in ('pending', 'in_progress') and exists (select 1 from public.cases c where c.id = t.case_id) $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /intake review list', $q$
    select x.id, x.created_at, x.status, x.template_id, x.missing_required, x.parser_action, x.extracted ->> 'insurer_claim_no',
           (select json_build_object('subject', e.subject, 'from', e.from_address) from public.emails e where e.id = x.email_id)
      from public.intake_extractions x where x.status = 'pending_review' and exists (select 1 from public.emails e where e.id = x.email_id)
     order by x.created_at, x.id limit 25 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': /intake/failed list', $q$
    select id, subject, from_address, status, error, retry_attempts from public.emails
     where status in ('failed', 'retry_requested') order by received_at desc, id limit 25 $q$)
union all
select * from pg_temp.bench(:'staff_label' || ': workload: open cases per owner', $q$
    select office_owner_id from public.cases where status not in ('submitted', 'closed', 'cancelled') and office_owner_id is not null limit 10000 $q$)
\if :have_workload
union all
select * from pg_temp.bench(:'staff_label' || ': staff_workload()', $q$ select * from public.staff_workload() $q$)
\endif
;
rollback;
