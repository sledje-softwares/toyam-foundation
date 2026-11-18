// Rewrites the generated blocks of supabase/seed.sql from config/templates (local dev seed only).
//
//   node scripts/gen-template-seed.ts            rewrite both blocks in place
//   node scripts/gen-template-seed.ts --check    exit 1 when seed.sql is out of date (nothing written)
//
// Uses the same loader as `npm run templates:load` (resolveTemplateLayout), so each template's report
// layout is resolved, its asset files are embedded and it is validated exactly as on a hosted project.
// Blocks: "-- BEGIN GENERATED CATEGORIES" … "-- END GENERATED CATEGORIES" and the same for TEMPLATES.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  TEMPLATES_DIR, type TemplateYaml, readYaml, resolveTemplateLayout, templateFiles, validateTemplate,
} from '../src/template-config.ts';

const SEED = new URL('../../../supabase/seed.sql', import.meta.url).pathname;
const check = process.argv.includes('--check');

function dollarQuote(json: string): string {
  if (json.includes('$tpl$')) throw new Error('template JSON contains $tpl$');
  return `$tpl$${json}$tpl$`;
}

const categories = readYaml<Array<{ code: string }>>(`${TEMPLATES_DIR}_categories.yaml`);
const codes = new Set(categories.map((c) => c.code));
const categoriesSql = `select public.load_evidence_categories(${dollarQuote(JSON.stringify(categories))}::jsonb);`;

let failed = false;
const templateSql: string[] = [];
for (const file of templateFiles()) {
  const { config, errors: layoutErrors } = resolveTemplateLayout(readYaml<TemplateYaml>(file), file);
  const errors = [...validateTemplate(config, codes), ...layoutErrors];
  for (const e of errors) console.error(`${basename(file)}: ✖ ${e}`);
  if (errors.length) failed = true;
  templateSql.push(
    `select public.load_case_template(${dollarQuote(JSON.stringify(config))}::jsonb, 'config/templates/${basename(file)}', true);`,
  );
}
if (failed) process.exit(1);

function replaceBlock(text: string, name: string, body: string): string {
  const begin = new RegExp(`(-- BEGIN GENERATED ${name}[^\\n]*\\n)[\\s\\S]*?(-- END GENERATED ${name})`);
  if (!begin.test(text)) throw new Error(`seed.sql has no GENERATED ${name} block`);
  return text.replace(begin, (_m, head: string, tail: string) => `${head}${body}\n${tail}`);
}

const before = readFileSync(SEED, 'utf8');
let after = replaceBlock(before, 'CATEGORIES', categoriesSql);
after = replaceBlock(after, 'TEMPLATES', templateSql.join('\n'));

if (check) {
  if (after !== before) {
    console.error('supabase/seed.sql is out of date: run `node scripts/gen-template-seed.ts` in services/intake');
    process.exit(1);
  }
  console.log('supabase/seed.sql generated blocks are up to date');
} else if (after === before) {
  console.log('supabase/seed.sql already up to date');
} else {
  writeFileSync(SEED, after);
  console.log(`supabase/seed.sql: rewrote categories (${categories.length}) and templates (${templateSql.length})`);
}
