// 7.7 report layouts: placeholder parser, strict validator, template loader integration (fictional fixtures).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { defaultLayout, parsePlaceholder, parseTemplate } from '../../../supabase/functions/_shared/report/spec.ts';
import { templateInfo, validateLayout } from '../../../supabase/functions/_shared/report/validate.ts';
import { resolveTemplateLayout, templateFiles, readYaml, type TemplateYaml } from '../src/template-config.ts';
import { exampleLayout, exampleTemplate } from './report-helpers.ts';

const base = () => ({
  version: 1,
  page: { size: 'A4', margin_mm: { top: 20, right: 15, bottom: 20, left: 15 } },
  font: { family: 'Calibri', size_pt: 10 },
  body: [] as unknown[],
});
const withBody = (...body: unknown[]) => ({ ...base(), body });
const errs = (layout: unknown, tpl?: Parameters<typeof validateLayout>[1]) => validateLayout(layout, tpl);
const has = (list: string[], re: RegExp) => assert.ok(list.some((e) => re.test(e)), `expected ${re} in:\n${list.join('\n')}`);

describe('placeholders', () => {
  it('parses namespaces and formatter chains', () => {
    const p = parsePlaceholder(' field.loss_date | date:"dd.MM.yyyy" | default:"N\\"A" ');
    assert.ok(typeof p !== 'string');
    assert.equal(p.ns, 'field');
    assert.equal(p.key, 'loss_date');
    assert.deepEqual(p.formatters, [{ name: 'date', args: ['dd.MM.yyyy'] }, { name: 'default', args: ['N"A'] }]);
    const q = parsePlaceholder('item|first_line');
    assert.ok(typeof q !== 'string' && q.ns === 'item');
    const pipe = parsePlaceholder('field.x|join:" | "');
    assert.ok(typeof pipe !== 'string' && pipe.formatters[0].args[0] === ' | ');
  });
  it('rejects unknown namespaces, case facts, formatters and arities', () => {
    assert.match(String(parsePlaceholder('user.name')), /unknown placeholder/);
    assert.match(String(parsePlaceholder('case.secret_key')), /unknown case fact/);
    assert.match(String(parsePlaceholder('field.x|shout')), /unknown formatter/);
    assert.match(String(parsePlaceholder('field.x|default')), /takes 1/);
    assert.match(String(parsePlaceholder('field.x|date:dd')), /quoted/);
    assert.match(String(parsePlaceholder('field.x|default:"open')), /unterminated/);
    assert.match(String(parsePlaceholder('field.X')), /unknown placeholder/);
  });
  it('splits text into literals and placeholders and reports every bad one', () => {
    const { parts, errors } = parseTemplate('Claim {{case.claim_no}} / {{field.a}} {{nope}} {{');
    assert.equal(parts.filter((p) => typeof p !== 'string').length, 2);
    assert.equal(errors.length, 2);
  });
});

describe('validateLayout', () => {
  it('accepts the example layout (checked against its template) and the default layout', () => {
    const t = exampleTemplate();
    assert.deepEqual(errs(exampleLayout(), templateInfo(t.sections)), []);
    const sections = t.sections.map((s) => ({ key: s.key, title: s.title, fields: s.fields ?? [] }));
    assert.deepEqual(errs(defaultLayout(sections), templateInfo(t.sections)), []);
  });

  it('reports structure errors with JSON paths', () => {
    has(errs(null), /^\$: must be an object/);
    has(errs({ ...base(), extra: 1, body: [{ type: 'paragraph', text: 'x' }] }), /^\$\.extra: unknown key/);
    has(errs({ ...base(), version: 2, body: [{ type: 'paragraph', text: 'x' }] }), /^\$\.version: must be 1/);
    has(errs(withBody()), /^\$\.body: must be a non-empty list/);
    has(errs(withBody({ type: 'marquee' })), /^\$\.body\[0\]\.type: unknown or not allowed here: "marquee"/);
    has(errs(withBody({ type: 'paragraph', text: 'x', colour: 'red' })), /^\$\.body\[0\]\.colour: unknown key/);
    has(errs(withBody({ type: 'paragraph' })), /^\$\.body\[0\]: needs exactly one of text, runs/);
    has(errs(withBody({ type: 'paragraph', text: 'x', style: { color: 'red' } })), /^\$\.body\[0\]\.style\.color: must be a colour/);
    has(errs(withBody({ type: 'paragraph', text: 'x', style: 'nope' })), /^\$\.body\[0\]\.style: unknown style "nope"/);
    has(errs({ ...base(), font: { family: 'Evil"; }', size_pt: 10 }, body: [{ type: 'spacer', height_mm: 2 }] }), /^\$\.font\.family/);
    has(errs({ ...base(), page: { size: 'A5', margin_mm: { top: 1, right: 1, bottom: 1, left: 1 } }, body: [{ type: 'page_break' }] }), /^\$\.page\.size: must be one of/);
  });

  it('checks placeholders: syntax, where page / item may appear, template fields', () => {
    const tpl = { fields: { claim_no: 'text', notes: 'long_text' }, sections: ['claim'] };
    has(errs(withBody({ type: 'paragraph', text: '{{case.nope}}' })), /^\$\.body\[0\]\.text: unknown case fact/);
    has(errs(withBody({ type: 'paragraph', text: 'Page {{page}}' })), /\{\{page\}\} is only allowed in the header and footer/);
    has(errs(withBody({ type: 'paragraph', text: '{{item}}' })), /\{\{item\}\} is only allowed in the cells of a repeat row/);
    has(errs(withBody({ type: 'paragraph', text: '{{field.missing}}' }), tpl), /unknown field "missing" in this template/);
    has(errs(withBody({ type: 'photos', section: 'garage' }), tpl), /unknown section "garage"/);
    has(errs(withBody({ type: 'list', field: 'missing' }), tpl), /^\$\.body\[0\]\.field: unknown field/);
    has(errs(withBody({ type: 'paragraph', text: 'x', when: { field: 'missing' } }), tpl), /when\.field: unknown field/);
    assert.deepEqual(errs({ ...base(), footer: [{ type: 'paragraph', text: '{{page}} / {{pages}}' }], body: [{ type: 'paragraph', text: '{{field.notes}}' }] }, tpl), []);
    has(errs({ ...base(), header: [{ type: 'photos', section: 'claim' }], body: [{ type: 'page_break' }] }), /^\$\.header\[0\]\.type: unknown or not allowed here/);
  });

  it('checks the table grid: column counts, spans, rowspans and conditional rows', () => {
    const t = (rows: unknown[], columns = [1, 1, 1]) => withBody({ type: 'table', columns, rows });
    assert.deepEqual(errs(t([{ cells: ['a', 'b', 'c'] }])), []);
    has(errs(t([{ cells: ['a', 'b'] }])), /rows\[0\]: cells cover 2 columns but 3 free columns remain/);
    has(errs(t([{ cells: ['a', { text: 'b', colspan: 3 }] }])), /rows\[0\]/);
    assert.deepEqual(errs(t([{ cells: [{ text: 'a', rowspan: 2 }, 'b', 'c'] }, { cells: ['d', 'e'] }])), []);
    has(errs(t([{ cells: [{ text: 'a', rowspan: 2 }, 'b', 'c'] }, { cells: ['d', 'e', 'f'] }])), /rows\[1\]: cells cover 3 columns but 2 free columns remain/);
    has(errs(t([{ cells: [{ text: 'a', rowspan: 3 }, 'b', 'c'] }, { cells: ['d', 'e'] }])), /a rowspan runs past the last row/);
    has(errs(t([{ cells: [{ text: 'a', rowspan: 2 }, 'b', 'c'] }, { cells: ['d', 'e'], when: { photos: 'x' } }])), /not allowed on a row covered by a rowspan/);
    has(errs(t([{ cells: [{ text: 'a', rowspan: 2 }, 'b', 'c'] }, { heading: 'H' }])), /rows\[1\]: cells cover 3 columns but 2 free/);
    has(errs(t([{ cells: ['a', 'b', 'c'] }, { heading: 'H', header: true }])), /header rows must come first/);
    has(errs(t([{ field: 'x' }], [1])), /a field row needs a table of at least 2 columns/);
    assert.deepEqual(errs(t([{ field: 'x', label_span: 2 }])), []);
    has(errs(t([{ repeat: { field: 'x' }, cells: ['{{index}}', '{{item}}'] }])), /cells cover 2 columns/);
    assert.deepEqual(errs(t([{ repeat: { field: 'x', split: 'lines' }, cells: ['{{index}}', '{{item}}', '{{item|upper}}'], empty: [{ text: 'none', colspan: 3 }] }])), []);
    has(errs(t([{ repeat: { field: 'x', split: 'words' }, cells: ['a', 'b', 'c'] }])), /repeat\.split: must be one of/);
    has(errs(t([{ wat: 1 }])), /must have one of cells, heading, field, repeat/);
    has(errs(t([{ cells: [{ text: 'a', blocks: [] }, 'b', 'c'] }])), /use one of text, runs, blocks/);
    has(errs(t([{ cells: [{ blocks: [{ type: 'table', columns: [1], rows: [{ cells: ['x'] }] }] }, 'b', 'c'] }])), /unknown or not allowed here: "table"/);
  });

  it('checks named styles, table styles and assets', () => {
    has(errs({ ...base(), styles: { a: { use: 'b' }, b: { use: 'a' } }, body: [{ type: 'paragraph', text: 'x' }] }), /refer to each other in a loop/);
    has(errs({ ...base(), styles: { 'bad name': {} }, body: [{ type: 'paragraph', text: 'x' }] }), /name must start with a letter/);
    has(errs({ ...base(), body: [{ type: 'table', columns: [1], style: 'grid', rows: [{ cells: ['x'] }] }] }), /unknown table style "grid"/);
    has(errs(withBody({ type: 'image', asset: 'logo' })), /unknown asset "logo"/);
    has(errs({ ...base(), assets: { logo: { file: 'x.png' } }, body: [{ type: 'image', asset: 'logo' }] }), /file assets must be embedded by the template loader/);
    has(errs({ ...base(), assets: { logo: { mime: 'image/png', width: 1, height: 1, data_base64: btoa('not a png at all') } }, body: [{ type: 'image', asset: 'logo' }] }), /does not hold a image\/png image/);
    assert.deepEqual(errs({ ...base(), assets: { seal: { runtime: true } }, body: [{ type: 'image', asset: 'seal' }] }), []);
  });
});

describe('template loader: report_layout', () => {
  it('embeds asset files and validates against the template', () => {
    const layout = exampleLayout() as unknown as { assets: Record<string, Record<string, unknown>> };
    const lh = layout.assets.letterhead;
    assert.equal(lh.mime, 'image/png');
    assert.equal(lh.width, 300);
    assert.equal(lh.height, 40);
    assert.ok(typeof lh.data_base64 === 'string' && (lh.data_base64 as string).length > 100);
    assert.deepEqual(layout.assets.seal, { runtime: true, description: 'Seal and signature (supplied by the generator)' });
  });

  it('reports bad references, unsafe paths and missing files with the report_layout prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'layout-'));
    const t = exampleTemplate();
    writeFileSync(join(dir, 'l.yaml'), 'version: 1\npage: {size: A4, margin_mm: {top: 10, right: 10, bottom: 10, left: 10}}\n' +
      'font: {family: Arial, size_pt: 10}\nassets: {logo: {file: missing.png}}\nbody:\n  - {type: paragraph, text: "{{field.nope}}"}\n');
    const r1 = resolveTemplateLayout({ ...t, report_layout: 'l.yaml' }, join(dir, 't.yaml'));
    has(r1.errors, /^report_layout \$\.assets\.logo: /);
    writeFileSync(join(dir, 'l2.yaml'), 'version: 1\npage: {size: A4, margin_mm: {top: 10, right: 10, bottom: 10, left: 10}}\n' +
      'font: {family: Arial, size_pt: 10}\nbody:\n  - {type: paragraph, text: "{{field.nope}}"}\n');
    const r2 = resolveTemplateLayout({ ...t, report_layout: 'l2.yaml' }, join(dir, 't.yaml'));
    has(r2.errors, /^report_layout \$\.body\[0\]\.text: unknown field "nope"/);
    const r3 = resolveTemplateLayout({ ...t, report_layout: '../etc/passwd' }, join(dir, 't.yaml'));
    has(r3.errors, /relative path inside config\/templates/);
    const r4 = resolveTemplateLayout({ ...t, report_layout: undefined }, join(dir, 't.yaml'));
    assert.deepEqual(r4.errors, []);
    assert.equal(r4.config.report_layout, undefined);
  });

  it('every config/templates layout that exists validates', () => {
    for (const file of templateFiles()) {
      const { errors } = resolveTemplateLayout(readYaml<TemplateYaml>(file), file);
      assert.deepEqual(errors, [], file);
    }
  });
});
