// Rewrites the embedded data (categories + templates) of tools/truth-labeller.html from config/templates/.
//   npm run build:truth-labeller
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { LabelCategory, LabelTemplate } from '../src/prompt.ts';

const dir = new URL('../../../config/templates/', import.meta.url);
const htmlUrl = new URL('../tools/truth-labeller.html', import.meta.url);

const categories = (parseYaml(readFileSync(new URL('_categories.yaml', dir), 'utf8')) as LabelCategory[]).map((c) => ({
  code: c.code,
  name: c.name,
  description: c.description ?? '',
}));

const templates = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
  .sort()
  .map((f) => {
    const t = parseYaml(readFileSync(new URL(f, dir), 'utf8')) as LabelTemplate & { name?: string };
    return {
      id: f.replace(/\.yaml$/, ''),
      name: t.name ?? f,
      sections: (t.sections ?? []).map((s) => ({
        key: s.key,
        title: s.title ?? s.key,
        fields: (s.fields ?? []).map((x) => ({ key: x.key, label: x.label ?? x.key })),
      })),
    };
  });

// "<" is escaped so the JSON can never close the script tag.
const json = JSON.stringify({ categories, templates }).replace(/</g, '\\u003c');
const html = readFileSync(htmlUrl, 'utf8');
const re = /\/\*EMBED:DATA\*\/[\s\S]*?\/\*END:DATA\*\//;
if (!re.test(html)) throw new Error('EMBED:DATA markers not found in truth-labeller.html');
writeFileSync(htmlUrl, html.replace(re, () => `/*EMBED:DATA*/${json}/*END:DATA*/`));
console.log(`Embedded ${categories.length} categories and ${templates.length} templates.`);
