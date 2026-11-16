// 7.7 report binding: formatters, list splitting, conditions, tables, photos and images (fictional fixtures).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bindReport, fieldsFromSections, LayoutError, type RBlock, type ReportData, type RImage, type RParagraph, type RTable,
} from '../../../supabase/functions/_shared/report/bind.ts';
import { formatDate, groupIndian, parseDateish, splitItems } from '../../../supabase/functions/_shared/report/format.ts';
import { imageSize, sniffImage } from '../../../supabase/functions/_shared/report/image.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { exampleData, exampleLayout, letterhead, photoA, photoB } from './report-helpers.ts';

const layoutWith = (body: unknown[], extra: Record<string, unknown> = {}): ReportLayout => ({
  version: 1,
  page: { size: 'A4', margin_mm: { top: 20, right: 15, bottom: 20, left: 15 } },
  font: { family: 'Arial', size_pt: 10 },
  date_format: 'dd.MM.yyyy',
  datetime_format: "dd.MM.yyyy 'at' hh:mm a",
  ...extra,
  body,
} as ReportLayout);

const data = (fields: Record<string, [string, string | null]>, more: Partial<ReportData> = {}): ReportData => ({
  case: { case_ref: 'INV-2099-000009', claim_no: 'EX/9', generated_at: '2099-03-04T20:00:00Z', report_version: 3 },
  fields: Object.fromEntries(Object.entries(fields).map(([k, [type, value]]) => [k, { type, label: `Label ${k}`, value }])),
  ...more,
});

const textOf = (blocks: RBlock[]): string[] => blocks.flatMap((b) => {
  if (b.kind === 'paragraph') return [`${b.marker ? `${b.marker} ` : ''}${b.runs.map((r) => r.field ? `[${r.field}]` : r.text).join('')}`];
  if (b.kind === 'table') return b.rows.flatMap((r) => r.cells.flatMap((c) => textOf(c.blocks)));
  if (b.kind === 'group') return textOf(b.blocks);
  return [];
});
const one = (template: string, d: ReportData, extra: Record<string, unknown> = {}) =>
  textOf(bindReport(layoutWith([{ type: 'paragraph', text: template }], extra), d).body).join('\n\n');

describe('format helpers', () => {
  it('parses stored dates, local datetimes and zoned timestamps (shown in India time)', () => {
    assert.deepEqual(parseDateish('2099-01-31'), { y: 2099, m: 1, d: 31, hh: null, mi: null, ss: null });
    assert.deepEqual(parseDateish('2099-01-31T23:05'), { y: 2099, m: 1, d: 31, hh: 23, mi: 5, ss: null });
    assert.deepEqual(parseDateish('2099-01-31T20:00:00Z'), { y: 2099, m: 2, d: 1, hh: 1, mi: 30, ss: 0 });
    assert.deepEqual(parseDateish('2099-01-31 20:00:00+00'), { y: 2099, m: 2, d: 1, hh: 1, mi: 30, ss: 0 });
    assert.deepEqual(parseDateish('31.01.2099'), { y: 2099, m: 1, d: 31, hh: null, mi: null, ss: null });
    assert.equal(parseDateish('around noon'), null);
    assert.equal(parseDateish('2099-13-01'), null);
  });
  it('formats with tokens and quoted literals', () => {
    const p = parseDateish('2099-07-04T00:07')!;
    assert.equal(formatDate(p, "dd.MM.yyyy 'at' hh:mm a"), '04.07.2099 at 12:07 AM');
    assert.equal(formatDate(p, "d MMM yy, HH:mm 'o''clock'"), "4 Jul 99, 00:07 o'clock");
    assert.equal(formatDate(p, 'MMMM'), 'July');
  });
  it('groups digits the Indian way', () => {
    assert.equal(groupIndian('1234567'), '12,34,567');
    assert.equal(groupIndian('1,234.50'), '1,234.50');
    assert.equal(groupIndian('-100000'), '-1,00,000');
    assert.equal(groupIndian('12 lakh'), '12 lakh');
  });
  it('splits list values', () => {
    assert.deepEqual(splitItems('["A","B"]'), ['A', 'B']);
    assert.deepEqual(splitItems('one\n\ntwo\nthree'), ['one', 'two', 'three']);
    assert.deepEqual(splitItems('1. a\nmore a\n\n2) b\n• c'), ['a\nmore a', 'b', 'c']);
    assert.deepEqual(splitItems('intro\n1. a'), ['intro', 'a']);
    assert.deepEqual(splitItems('p1 l1\np1 l2\n\n\np2', 'paragraphs'), ['p1 l1\np1 l2', 'p2']);
    assert.deepEqual(splitItems('A\nx\n---\nB\ny', 'sections'), ['A\nx', 'B\ny']);
    assert.deepEqual(splitItems('- a\n- b', 'lines'), ['a', 'b']);
    assert.deepEqual(splitItems('   \n'), []);
  });
  it('reads image sizes from JPEG and PNG headers', () => {
    assert.deepEqual(imageSize(photoA()), { width: 160, height: 120 });
    assert.deepEqual(imageSize(photoB()), { width: 120, height: 160 });
    assert.deepEqual(imageSize(letterhead()), { width: 300, height: 40 });
    assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>')), null);
    assert.equal(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
  });
});

describe('bindReport: placeholders and formatters', () => {
  const d = data({
    d: ['date', '2099-01-02'], dt: ['datetime', '2099-01-02T15:30'], dto: ['datetime', '2099-01-02'],
    mc: ['multi_choice', '["Bumper","Mirror"]'], b: ['boolean', 'Yes'], cur: ['currency', '250000'],
    n: ['number', '1234567'], name: ['text', 'rAVI kumar'], empty: ['text', null], blank: ['text', '  '],
    st: ['long_text', 'Mr. X (driver)\nHe said so.\nAnd more.'],
  });
  it('applies type defaults', () => {
    assert.equal(one('{{field.d}}|{{field.dt}}|{{field.dto}}', d), '02.01.2099|02.01.2099 at 03:30 PM|02.01.2099');
    assert.equal(one('{{field.mc}}|{{field.b}}|{{field.cur}}|{{field.n}}', d), 'Bumper, Mirror|Yes|2,50,000|1234567');
  });
  it('applies formatter chains', () => {
    assert.equal(one('{{field.d|date:"d MMMM yyyy"|upper}}', d), '2 JANUARY 2099');
    assert.equal(one('{{field.mc|join:"; "|lower}}', d), 'bumper; mirror');
    assert.equal(one('{{field.b|yesno:"Available|Not available"}}', d), 'Available');
    assert.equal(one('{{field.cur|currency}} / {{field.cur|currency:"Rs. "}} / {{field.n|number}}', d), '₹ 2,50,000 / Rs. 2,50,000 / 12,34,567');
    assert.equal(one('{{field.name|title}}', d), 'Ravi Kumar');
    assert.equal(one('[{{field.empty|default:"NA"}}][{{field.blank|default:"NA"}}][{{field.name|default:"NA"|upper}}]', d), '[NA][NA][RAVI KUMAR]');
    assert.equal(one('{{field.empty|prefix:"Make: "}}|{{field.name|prefix:"Make: "|suffix:"."}}', d), '|Make: rAVI kumar.');
    assert.equal(one('{{field.st|first_line}}', d), 'Mr. X (driver)');
    assert.equal(one('{{field.st|rest_lines}}', d), 'He said so.\nAnd more.');
    assert.equal(one('{{case.generated_at|date:"dd.MM.yyyy HH:mm"}} v{{case.report_version}} {{case.claim_no}}', d), '05.03.2099 01:30 v3 EX/9');
  });
  it('uses empty_value for empty placeholders without a default', () => {
    assert.equal(one('[{{field.empty}}]', d, { empty_value: 'NA' }), '[NA]');
    assert.equal(one('[{{field.empty|default:""}}]', d, { empty_value: 'NA' }), '[]');
    assert.equal(one('[{{field.unknown_key}}]', d), '[]');
    const doc = bindReport(layoutWith([{ type: 'paragraph', text: '{{field.unknown_key}}x' }]), d);
    assert.deepEqual(doc.warnings, ['field "unknown_key" is not in the case data']);
  });
  it('never re-parses values: placeholders typed into a field stay literal', () => {
    const v = data({ x: ['text', '{{case.claim_no}} {{page}} \u0007bell'] });
    assert.equal(one('{{field.x}}', v), '{{case.claim_no}} {{page}} bell');
  });
  it('splits paragraphs at blank lines, keeps line breaks, applies **markup** only when asked', () => {
    const v = data({ x: ['long_text', 'one **two**\nthree\n\n\nfour'] });
    const ps = bindReport(layoutWith([{ type: 'paragraph', text: '{{field.x}}', markup: true }], { paragraph_spacing_pt: 9 }), v).body as RParagraph[];
    assert.equal(ps.length, 2);
    assert.deepEqual(ps[0].runs.map((r) => [r.text, !!r.bold]), [['one ', false], ['two', true], ['\nthree', false]]);
    assert.equal(ps[0].space_after_pt, 9);
    assert.equal(ps[1].space_after_pt, 0);
    const plain = bindReport(layoutWith([{ type: 'paragraph', text: '{{field.x}}' }]), v).body as RParagraph[];
    assert.equal(plain[0].runs.length, 1);
    assert.match(plain[0].runs[0].text, /\*\*two\*\*/);
    const odd = data({ x: ['text', 'a **b** c **d'] });
    const r = (bindReport(layoutWith([{ type: 'paragraph', text: '{{field.x}}', markup: true }]), odd).body[0] as RParagraph).runs;
    assert.deepEqual(r.map((x) => [x.text, !!x.bold]), [['a ', false], ['b', true], [' c ', false], ['**d', false]]);
  });
});

describe('bindReport: conditions, lists, tables', () => {
  const d = data({ s: ['choice', 'Repudiate'], e: ['text', ''], m: ['multi_choice', '[]'], l: ['long_text', '1. a\n2. b\ncont\n\nmore'] }, {
    photos: { garage: [{ caption: 'x', image: null }] },
  });
  const shown = (when: unknown) => bindReport(layoutWith([{ type: 'paragraph', text: 'shown', when }]), d).body.length === 1;
  it('evaluates conditions', () => {
    assert.equal(shown({ field: 's' }), true);
    assert.equal(shown({ field: 'e' }), false);
    assert.equal(shown({ field: 'm', filled: false }), true);
    assert.equal(shown({ field: 's', equals: 'repudiate' }), true);
    assert.equal(shown({ field: 's', not_equals: 'Repudiate' }), false);
    assert.equal(shown({ field: 's', in: ['Recommended', 'Repudiate'] }), true);
    assert.equal(shown({ photos: 'garage' }), true);
    assert.equal(shown({ photos: 'spot' }), false);
    assert.equal(shown({ all: [{ field: 's' }, { not: { photos: 'spot' } }] }), true);
    assert.equal(shown({ any: [{ field: 'e' }, { photos: 'spot' }] }), false);
  });
  it('builds ordered lists with continuation paragraphs and hanging markers', () => {
    const ps = bindReport(layoutWith([{ type: 'list', field: 'l', ordered: true, start: 4, indent_mm: 8 }]), d).body as RParagraph[];
    assert.deepEqual(ps.map((p) => [p.marker ?? '', p.indent_mm, p.runs.map((r) => r.text).join('')]), [
      ['4.', 8, 'a'], ['5.', 8, 'b\ncont'], ['', 8, 'more'],
    ]);
    const empty = bindReport(layoutWith([{ type: 'list', field: 'e', empty_text: 'None' }]), d).body as RParagraph[];
    assert.deepEqual(textOf(empty), ['None']);
    const items = bindReport(layoutWith([{ type: 'list', items: ['{{field.s}}', '{{field.e}}', 'x'] }]), d).body;
    assert.deepEqual(textOf(items), ['• Repudiate', '• x']);
  });
  it('lays out field rows, rowspans and widths', () => {
    const t = bindReport(layoutWith([{
      type: 'table', columns: [30, 30, 40],
      style: { border: { width_pt: 1, color: '#112233' }, padding_x_mm: 2, label_style: { bold: true, background: '#EEEEEE' } },
      rows: [
        { field: 's' },
        { field: 'e', when: { field: 'e' } },
        { cells: [{ text: 'A', rowspan: 2 }, 'B', { text: 'C', rowspan: 2 }] },
        { cells: ['D'] },
      ],
    }]), d).body[0] as RTable;
    assert.equal(t.width_mm, 180);
    assert.deepEqual(t.columns_mm, [54, 54, 72]);
    assert.equal(t.rows.length, 3);
    const [label, value] = t.rows[0].cells;
    assert.equal(textOf(label.blocks)[0], 'Label s');
    assert.equal(label.background, '#EEEEEE');
    assert.equal((label.blocks[0] as RParagraph).runs[0].bold, true);
    assert.equal(value.colspan, 2);
    assert.equal(value.width_mm, 126);
    assert.deepEqual(t.rows[1].cells.map((c) => [c.rowspan, c.width_mm]), [[2, 54], [1, 54], [2, 72]]);
    assert.deepEqual(t.rows[2].cells.map((c) => c.width_mm), [54]);
    assert.deepEqual(t.border, { width_pt: 1, color: '#112233', style: 'solid' });
  });
  it('repeats rows per item and shows the empty row when there are none', () => {
    const rows = (field: string) => (bindReport(layoutWith([{
      type: 'table', columns: [1, 4],
      rows: [{ repeat: { field }, cells: ['{{index}}.', '{{item|upper}}'], empty: [{ text: 'Nothing', colspan: 2 }] }],
    }]), d).body[0] as RTable).rows;
    assert.deepEqual(rows('l').map((r) => textOf(r.cells.flatMap((c) => c.blocks))), [['1.', 'A'], ['2.', 'B\nCONT\n\nMORE']]
      .map(([a, b]) => [a, ...b.split('\n\n')]));
    assert.deepEqual(rows('e').map((r) => textOf(r.cells.flatMap((c) => c.blocks))), [['Nothing']]);
  });
});

describe('bindReport: photos and images', () => {
  it('fits photos into a grid, keeps bytes as given and draws placeholders for missing or invalid images', () => {
    const d = exampleData();
    d.photos!.garage.push({ evidence_id: 'bad', caption: 'Not an image', image: { bytes: new TextEncoder().encode('GIF89a'), mime: 'image/jpeg' } });
    const doc = bindReport(layoutWith([{ type: 'photos', section: 'garage', columns: 2, gap_mm: 4, max_height_mm: 50, captions: true }]), d);
    const t = doc.body[0] as RTable;
    assert.equal(t.rows.length, 2);
    assert.equal(t.border, null);
    const imgs = t.rows.flatMap((r) => r.cells.flatMap((c) => c.blocks.filter((b): b is RImage => b.kind === 'image')));
    assert.equal(imgs.length, 4);
    assert.equal(imgs[0].image!.bytes, d.photos!.garage[0].image!.bytes);
    assert.deepEqual([imgs[0].width_mm, imgs[0].height_mm], [66.67, 50]); // 4:3 in an 86 mm cell, capped at 50 mm
    assert.deepEqual([imgs[1].width_mm, imgs[1].height_mm], [37.5, 50]); // portrait, capped at 50 mm
    assert.equal(imgs[2].image, null);
    assert.equal(imgs[2].missing_text, 'Photo not available: Odometer');
    assert.equal(imgs[3].image, null);
    assert.ok(doc.warnings.some((w) => /bad of section garage is not a JPEG or PNG/.test(w)));
    assert.deepEqual(textOf(t.rows[0].cells[0].blocks), ['Front view']);
  });
  it('shows empty_text when a section has no photos and limits the count', () => {
    const d = exampleData();
    assert.deepEqual(textOf(bindReport(layoutWith([{ type: 'photos', section: 'spot', empty_text: 'No photos' }]), d).body), ['No photos']);
    assert.equal(bindReport(layoutWith([{ type: 'photos', section: 'spot' }]), d).body.length, 0);
    const t = bindReport(layoutWith([{ type: 'photos', section: 'garage', columns: 3, limit: 2 }]), d).body[0] as RTable;
    assert.equal(t.rows[0].cells.filter((c) => c.blocks.length).length, 2);
  });
  it('sizes assets from the layout or the run time; a missing run-time asset is a placeholder', () => {
    const layout = exampleLayout();
    const d = exampleData();
    const body = (b: unknown[]) => bindReport({ ...layout, body: b } as ReportLayout, d).body as RImage[];
    const [lh] = body([{ type: 'image', asset: 'letterhead', width_mm: 60 }]);
    assert.deepEqual([lh.width_mm, lh.height_mm, lh.image!.mime], [60, 8, 'image/png']);
    const [nat] = body([{ type: 'image', asset: 'letterhead' }]);
    assert.deepEqual([nat.width_mm, nat.height_mm], [79.38, 10.58]); // 300 x 40 px at 96 dpi
    const [seal] = body([{ type: 'image', asset: 'seal', max_height_mm: 20 }]);
    assert.deepEqual([seal.width_mm, seal.height_mm], [15, 20]);
    const noSeal = bindReport({ ...layout, body: [{ type: 'image', asset: 'seal' }] } as ReportLayout, { ...d, assets: {} });
    assert.equal((noSeal.body[0] as RImage).image, null);
    assert.deepEqual(noSeal.warnings, ['asset "seal" was not supplied']);
  });
});

describe('bindReport: document', () => {
  it('binds the example: page, header page fields, title', () => {
    const doc = bindReport(exampleLayout(), exampleData());
    assert.deepEqual(doc.page, { width_mm: 210, height_mm: 297, margin_mm: { top: 32, right: 15, bottom: 18, left: 15 }, header_mm: 6, footer_mm: 6 });
    assert.equal(doc.title, 'Example investigation report — INV-2099-000001');
    assert.deepEqual(textOf(doc.footer), ['Page [page] of [pages]']);
    assert.deepEqual(doc.warnings, []);
  });
  it('rejects an invalid layout with LayoutError', () => {
    assert.throws(() => bindReport({ version: 1 } as unknown as ReportLayout, exampleData()), (e: unknown) =>
      e instanceof LayoutError && e.issues.some((x) => x.startsWith('$.page')));
  });
  it('fieldsFromSections maps prepare_report_version sections', () => {
    assert.deepEqual(fieldsFromSections([{ fields: [
      { key: 'a', label: 'A', type: 'text', value: 'x' },
      { key: 'b', label: 'B', type: 'multi_choice', value: ['p', 'q'] },
      { key: 'c', label: 'C', type: 'date', value: null },
    ] }]), {
      a: { type: 'text', label: 'A', value: 'x' },
      b: { type: 'multi_choice', label: 'B', value: '["p","q"]' },
      c: { type: 'date', label: 'C', value: null },
    });
  });
});
