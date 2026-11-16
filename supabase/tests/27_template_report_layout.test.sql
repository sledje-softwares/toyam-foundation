-- load_case_template() stores report_layout (20261117400000_template_report_layout.sql, D51).
-- Self-contained; rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into public.insurers (id, name, code) values ('2e000000-0000-4000-8000-0000000000a1', 'Layout Insurer', 'WLY');

create temp table r (tag text, template_id uuid, version int, created boolean);
insert into r select 'v1', * from public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"od","name":"WLY od",
  "report_layout":{"version":1,"page":{"size":"A4","margin_mm":{"top":20,"right":15,"bottom":20,"left":15}},"font":{"family":"Arial","size_pt":10},
                   "body":[{"type":"paragraph","text":"{{field.insurer_claim_no}}"}]},
  "sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');

select is((select t.report_layout->'font'->>'family' from public.case_templates t join r on r.template_id = t.id where r.tag = 'v1'),
          'Arial', 'report_layout is stored on the new version');
select is((select t.report_layout->'body'->0->>'text' from public.case_templates t join r on r.template_id = t.id where r.tag = 'v1'),
          '{{field.insurer_claim_no}}', 'layout content kept as given');

insert into r select 'same', * from public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"od","name":"WLY od",
  "report_layout":{"version":1,"page":{"size":"A4","margin_mm":{"top":20,"right":15,"bottom":20,"left":15}},"font":{"family":"Arial","size_pt":10},
                   "body":[{"type":"paragraph","text":"{{field.insurer_claim_no}}"}]},
  "sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
select ok((select not created and template_id = (select template_id from r where tag = 'v1') from r where tag = 'same'),
          'identical config with the same layout is a no-op');

insert into r select 'v2', * from public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"od","name":"WLY od",
  "report_layout":{"version":1,"page":{"size":"A4","margin_mm":{"top":20,"right":15,"bottom":20,"left":15}},"font":{"family":"Cambria","size_pt":11},
                   "body":[{"type":"paragraph","text":"{{field.insurer_claim_no}}"}]},
  "sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
select is((select version from r where tag = 'v2'), 2, 'a layout change makes a new template version');
select is((select t.report_layout->'font'->>'family' from public.case_templates t join r on r.template_id = t.id where r.tag = 'v1'),
          'Arial', 'the earlier version keeps its layout');
select ok((select t.is_active from public.case_templates t join r on r.template_id = t.id where r.tag = 'v2'), 'new version is active');

insert into r select 'none', * from public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"plain","name":"WLY plain",
  "sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
select is((select t.report_layout from public.case_templates t join r on r.template_id = t.id where r.tag = 'none'),
          null, 'no report_layout key → null');

insert into r select 'jnull', * from public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"jnull","name":"WLY jnull",
  "report_layout":null,"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}');
select is((select t.report_layout from public.case_templates t join r on r.template_id = t.id where r.tag = 'jnull'),
          null, 'report_layout: null → null');

select throws_ok($$select public.load_case_template('{"insurer_code":"WLY","claim_type":"motor","variant":"arr","name":"WLY arr",
  "report_layout":[1,2],"sections":[{"key":"claim","title":"Claim","fields":[{"key":"insurer_claim_no","label":"Claim no","source":"intake"}]}]}')$$,
  '22023', 'report_layout must be an object', 'a non-object layout is refused');

select * from finish();
rollback;
