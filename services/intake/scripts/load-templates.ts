// Load config/templates into a Supabase project (M2 piece 2.5).
//
//   node scripts/load-templates.ts --dry-run          validate and print a summary
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/load-templates.ts [--no-activate] [file.yaml …]
//
// Categories are upserted first, then each template is loaded with public.load_case_template();
// identical configs are no-ops, changed configs become a new active version.
// A template's report layout (`report_layout: layouts/<x>.yaml`, docs/13-report-layouts.md) is validated, its
// asset files are embedded, and it is loaded as part of the template JSON: load_case_template() stores it in
// case_templates.report_layout (migration 20261117400000) and a layout change is a new template version.
// A template's category → field map (`category_map: maps/<x>.yaml`, docs/09) is validated and sent as `category_fields`;
// load_case_template() stores it in case_template_category_fields (migration 20261119500000); a score change is a new
// version.
import { basename } from 'node:path';
import {
  TEMPLATES_DIR, type TemplateYaml, readYaml, resolveTemplate, templateFiles, validateTemplate,
} from '../src/template-config.ts';

interface Category { code: string }

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const activate = !args.includes('--no-activate');
const files = args.filter((a) => a.endsWith('.yaml'));

const categories = readYaml<Category[]>(`${TEMPLATES_DIR}_categories.yaml`);
const codes = new Set(categories.map((c) => c.code));
const targets = files.length ? files : templateFiles();

let failed = false;
const loaded: Array<{ file: string; config: TemplateYaml }> = [];
for (const file of targets) {
  const { config, errors: layoutErrors } = resolveTemplate(readYaml<TemplateYaml>(file), file, codes);
  const errors = [...validateTemplate(config, codes), ...layoutErrors];
  const fields = config.sections.flatMap((s) => s.fields ?? []);
  const intake = fields.filter((f) => f.source === 'intake').length;
  const layout = (config.report_layout ? ', report layout' : ', no report layout')
    + (config.category_fields ? `, category map (${Object.values(config.category_fields as Record<string, object>).reduce((n, m) => n + Object.keys(m).length, 0)} pairs)` : ', no category map');
  console.log(`${basename(file)}: ${config.insurer_code}/${config.claim_type}/${config.variant ?? 'general'} — ${config.sections.length} sections, ${fields.length} fields (${intake} intake)${layout}`);
  for (const e of errors) console.log(`  ✖ ${e}`);
  if (errors.length) failed = true;
  loaded.push({ file, config });
}
if (failed) {
  console.error('Validation failed; nothing loaded.');
  process.exit(1);
}
if (dryRun) {
  console.log(`OK: ${categories.length} categories, ${loaded.length} templates (dry run).`);
  process.exit(0);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role: server-side use only).');
  process.exit(1);
}

async function rpc(fn: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key!, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

console.log(`categories upserted: ${await rpc('load_evidence_categories', { p_categories: categories })}`);
for (const { file, config } of loaded) {
  const rel = `config/templates/${basename(file)}`;
  const [r] = (await rpc('load_case_template', { p_config: config, p_source_file: rel, p_activate: activate })) as
    Array<{ template_id: string; version: number; created: boolean }>;
  console.log(`${rel}: version ${r.version} ${r.created ? 'created' : 'unchanged'}${activate ? ' (active)' : ''}`);
}
