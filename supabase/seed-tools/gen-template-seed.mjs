// Prints the SQL that loads config/templates into a fresh local database, for supabase/seed.sql.
//   node supabase/seed-tools/gen-template-seed.mjs categories   (evidence categories)
//   node supabase/seed-tools/gen-template-seed.mjs templates    (case templates)
// Re-run and paste into the matching "BEGIN GENERATED ..." / "END GENERATED ..." blocks in
// seed.sql when config/templates changes (the field checklist is created between the two).
// Plain JS so it runs on any Node (needs the `yaml` package from the repo's node_modules).
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';

const dir = new URL('../../config/templates/', import.meta.url);
const read = (f) => parse(readFileSync(new URL(f, dir), 'utf8'));
const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort();

const mode = process.argv[2];
const out = [];
if (mode === 'categories') {
  out.push(`select public.load_evidence_categories($tpl$${JSON.stringify(read('_categories.yaml'))}$tpl$::jsonb);`);
} else if (mode === 'templates') {
  for (const f of files) {
    out.push(`select public.load_case_template($tpl$${JSON.stringify(read(f))}$tpl$::jsonb, 'config/templates/${f}', true);`);
  }
} else {
  console.error('usage: gen-template-seed.mjs categories|templates');
  process.exit(2);
}
console.log(out.join('\n'));
