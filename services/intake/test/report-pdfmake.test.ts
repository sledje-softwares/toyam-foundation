// 7.7 PDF writer (pdfmake definition, built in the office user's browser): structure of the definition, font
// mapping, and one real render per insurer layout with pdfmake in Node (30 synthetic photos, fictional data only).
// Set REPORT_OUT_DIR to keep the rendered PDFs (e.g. `pdftoppm -r 50 -png` them to look at the pages).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import pdfmake from 'pdfmake';
import {
  bindReport, type RBlock, type ReportData, type ReportPhoto, type ResolvedDocument, type RTable,
} from '../../../supabase/functions/_shared/report/bind.ts';
import { toBase64 } from '../../../supabase/functions/_shared/report/image.ts';
import {
  pdfFontKey, pdfFontKeysUsed, pdfFontsUsed, pdfmakeFonts, pdfmakeFromDocument, type PdfNode,
  REPORT_FONT_FILES, renderReportPdfDefinition,
} from '../../../supabase/functions/_shared/report/pdfmake.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { TEMPLATES_DIR, readYaml, resolveTemplateLayout, type TemplateYaml } from '../src/template-config.ts';
import { exampleData, exampleLayout, photoA, photoB } from './report-helpers.ts';

const FONTS_DIR = new URL('../../../apps/web/public/fonts/', import.meta.url).pathname;
const OUT = process.env.REPORT_OUT_DIR;
const NOW = new Date('2099-01-10T06:45:00Z');
const PT = 72 / 25.4;

/** Every text string in a node tree (runs joined per text node). */
function texts(n: unknown, out: string[] = []): string[] {
  if (n === null || n === undefined) return out;
  if (typeof n === 'string') { out.push(n); return out; }
  if (Array.isArray(n)) { for (const x of n) texts(x, out); return out; }
  if (typeof n !== 'object') return out;
  const o = n as PdfNode;
  if (typeof o.text === 'string') out.push(o.text);
  else if (Array.isArray(o.text)) out.push(o.text.map((r: PdfNode | string) => (typeof r === 'string' ? r : r.text)).join(''));
  for (const k of ['stack', 'columns']) if (o[k]) texts(o[k], out);
  if (o.table) texts(o.table.body, out);
  return out;
}

/** Nodes matching a predicate, depth first. */
function find(n: unknown, pred: (o: PdfNode) => boolean, out: PdfNode[] = []): PdfNode[] {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const x of n) find(x, pred, out); return out; }
  const o = n as PdfNode;
  if (pred(o)) out.push(o);
  for (const k of ['stack', 'columns', 'text']) if (Array.isArray(o[k])) find(o[k], pred, out);
  if (o.table) find(o.table.body, pred, out);
  return out;
}

function doc(body: RBlock[], over: Partial<ResolvedDocument> = {}): ResolvedDocument {
  return {
    title: 'Test',
    page: { width_mm: 210, height_mm: 297, margin_mm: { top: 20, right: 10, bottom: 20, left: 10 }, header_mm: 5, footer_mm: 5 },
    font: { family: 'Calibri', fallback: 'Carlito, sans-serif', size_pt: 10, color: '#000000', line_height: 1.15 },
    header: [], footer: [], body, warnings: [], ...over,
  };
}
const para = (text: string, over: Record<string, unknown> = {}): RBlock =>
  ({ kind: 'paragraph', runs: [{ text }], align: 'left', space_before_pt: 0, space_after_pt: 0, ...over }) as RBlock;
const cell = (text: string, over: Record<string, unknown> = {}) =>
  ({ blocks: [para(text)], colspan: 1, rowspan: 1, width_mm: 30, valign: 'top', ...over }) as RTable['rows'][0]['cells'][0];
const jpeg = (bytes = photoA()) => ({ bytes, mime: 'image/jpeg' as const, width: 160, height: 120 });

describe('PDF writer (pdfmake definition)', () => {
  it('sets page size, orientation and margins in pt, title and default style', () => {
    const d = pdfmakeFromDocument(bindReport(exampleLayout(), exampleData()), { creator: 'Tests', now: NOW });
    assert.deepEqual(d.pageSize, { width: 595.28, height: 841.89 });
    assert.equal(d.pageOrientation, 'portrait');
    assert.deepEqual(d.pageMargins, [42.52, 90.71, 42.52, 51.02]); // A4, margins 15 / 32 / 15 / 18 mm
    assert.equal(d.info.title, 'Example investigation report — INV-2099-000001');
    assert.equal(d.info.creator, 'Tests');
    assert.equal(d.info.creationDate, NOW);
    assert.equal(d.defaultStyle.font, 'Caladea'); // Cambria
    assert.equal(d.defaultStyle.fontSize, 10);
    assert.equal(d.defaultStyle.color, '#111111');
    assert.equal(d.defaultStyle.lineHeight, 1); // CSS 1.15 / Caladea's 1.15 em box
    const land = pdfmakeFromDocument(doc([], { page: { width_mm: 297, height_mm: 210, margin_mm: { top: 10, right: 10, bottom: 10, left: 10 }, header_mm: 5, footer_mm: 5 } }));
    assert.equal(land.pageOrientation, 'landscape');
  });

  it('fills page fields in the header / footer functions (page 2 of 5)', () => {
    const d = pdfmakeFromDocument(bindReport(exampleLayout(), exampleData()));
    assert.equal(typeof d.footer, 'function');
    const footer = d.footer!(2, 5)!;
    assert.ok(texts(footer).includes('Page 2 of 5'), JSON.stringify(texts(footer)));
    assert.ok(texts(d.footer!(5, 5)).includes('Page 5 of 5'));
    // footer: bottom-aligned box inside the side margins, footer_mm above the page edge
    assert.deepEqual(footer.margin, [42.52, 0, 42.52, 0]);
    assert.equal(footer.table.body[0][0].verticalAlignment, 'bottom');
    assert.equal(footer.table.heights[0], Math.round((51.02 - 17.01 - 1) * 100) / 100);
    const header = d.header!(2, 5)!;
    assert.deepEqual(header.margin, [42.52, 17.01, 42.52, 0]); // header_mm 6
    assert.ok(texts(header).some((t) => t.includes('Case INV-2099-000001')));
    // the letterhead in the header is registered once, before pdfmake reads `images`
    const imgs = find(header, (o) => typeof o.image === 'string');
    assert.equal(imgs.length, 1);
    assert.ok(d.images[imgs[0].image].startsWith('data:image/png;base64,'));
  });

  it('adds the filler cells pdfmake needs after colspan and under rowspan cells', () => {
    const t: RTable = {
      kind: 'table', width_mm: 90, columns_mm: [30, 30, 30], border: { width_pt: 0.5, color: '#112233', style: 'dashed' },
      padding_x_mm: 1.5, padding_y_mm: 0.5, space_after_pt: 6,
      rows: [
        { cells: [cell('head', { colspan: 3, width_mm: 90, background: '#D9D9D9' })], header: true, keep_together: false },
        { cells: [cell('tall', { rowspan: 2, valign: 'middle' }), cell('wide', { colspan: 2, width_mm: 60 })], header: false, keep_together: false },
        { cells: [cell('b'), cell('c', { no_border: true })], header: false, keep_together: false, height_mm: 10 },
      ],
    };
    const d = pdfmakeFromDocument(doc([t]));
    const node = d.content[0];
    const body = node.table.body as PdfNode[][];
    assert.equal(body.length, 3);
    for (const row of body) assert.equal(row.length, 3);
    assert.equal(body[0][0].colSpan, 3);
    assert.equal(body[0][0].fillColor, '#D9D9D9');
    assert.deepEqual([body[0][1], body[0][2]], [{}, {}]);
    assert.equal(body[1][0].rowSpan, 2);
    assert.equal(body[1][0].verticalAlignment, 'middle');
    assert.equal(body[1][1].colSpan, 2);
    assert.deepEqual(body[1][2], {});
    assert.deepEqual(body[2][0], {}); // covered by the rowspan
    assert.deepEqual(texts(body[2][1]), ['b']);
    assert.deepEqual(body[2][2].border, [false, false, false, false]);
    assert.equal(node.table.headerRows, 1);
    assert.deepEqual(node.table.heights, ['auto', 'auto', Math.round((10 * PT - 2 * 0.5 * PT - 0.5) * 100) / 100]);
    // content width = column − 2 × padding − one line (pdfmake adds padding and lines around it)
    assert.deepEqual(node.table.widths, Array(3).fill(Math.round((30 * PT - 3 * PT - 0.5) * 100) / 100));
    assert.equal(node.layout.hLineWidth(), 0.5);
    assert.equal(node.layout.vLineColor(), '#112233');
    assert.deepEqual(node.layout.hLineStyle(), { dash: { length: 3, space: 2 } });
    assert.equal(node.layout.paddingLeft(), Math.round(1.5 * PT * 100) / 100);
    assert.deepEqual(node.margin, [0, 0, 0, 6]);
    assert.equal(node.table.dontBreakRows, true); // fixed row heights only with rows kept whole (pdfmake split bug)
  });

  it('drops minimum row heights from a table whose rows cannot all be kept whole', () => {
    const long = Array.from({ length: 120 }, () => 'Invented long narrative line.').join('\n');
    const t: RTable = {
      kind: 'table', width_mm: 60, columns_mm: [60], border: null, padding_x_mm: 1, padding_y_mm: 1, space_after_pt: 0,
      rows: [
        { cells: [cell(long, { width_mm: 60 })], header: false, keep_together: false },
        { cells: [cell('seal', { width_mm: 60 })], header: false, keep_together: false, height_mm: 30 },
      ],
    };
    const node = pdfmakeFromDocument(doc([t])).content[0];
    assert.equal(node.table.heights, undefined);
    assert.equal(node.table.dontBreakRows, undefined);
  });

  it('keeps groups and keep_together rows on one page only when they surely fit', () => {
    const img = (h: number): RBlock => ({ kind: 'image', image: jpeg(), width_mm: 50, height_mm: h, align: 'left' });
    const small: RBlock = { kind: 'group', keep_together: true, blocks: [para('Heading', { keep_with_next: true, heading: 2 }), para('Body text')] };
    const tall: RBlock = { kind: 'group', keep_together: true, blocks: [img(150), img(150)] }; // 300 mm > page body
    const loose: RBlock = { kind: 'group', keep_together: false, blocks: [para('x')] };
    const d = pdfmakeFromDocument(doc([small, tall, loose]));
    assert.equal(d.content[0].unbreakable, true);
    assert.equal(d.content[1].unbreakable, undefined);
    assert.equal(d.content[2].unbreakable, undefined);
    const row = (h: number) => ({ cells: [{ blocks: [img(h)], colspan: 1, rowspan: 1, width_mm: 60, valign: 'top' as const }], header: false, keep_together: true });
    const photos = (h: number): RTable => ({ kind: 'table', width_mm: 60, columns_mm: [60], border: null, padding_x_mm: 1.5, padding_y_mm: 1.5, space_after_pt: 0, rows: [row(h), row(h)] });
    const d2 = pdfmakeFromDocument(doc([photos(60), photos(270)]));
    assert.equal(d2.content[0].table.dontBreakRows, true);
    assert.equal(d2.content[1].table.dontBreakRows, undefined); // a 270 mm row would be cut off by pdfmake
  });

  it('turns page breaks into pageBreak: before on the next block and keeps headings with the next block', () => {
    const d = pdfmakeFromDocument(doc([
      { kind: 'page_break' }, para('one'), { kind: 'page_break' }, { kind: 'page_break' }, para('two', { keep_with_next: true }), para('three'), { kind: 'page_break' },
    ]));
    assert.equal(d.content.length, 3);
    assert.equal(d.content[0].pageBreak, undefined); // a leading break would only add an empty page
    assert.equal(d.content[1].pageBreak, 'before');
    assert.equal(d.content[2].pageBreak, undefined);
    assert.equal(d.content[1].headlineLevel, 1);
    assert.equal(typeof d.pageBreakBefore, 'function');
    const at = (top: number) => ({ pageNumbers: [1], startPosition: { top, pageNumber: 1 } });
    const ctx = (following: ReturnType<typeof at>[]) => ({ getFollowingNodesOnPage: () => following, getPreviousNodesOnPage: () => [] });
    assert.equal(d.pageBreakBefore!({ headlineLevel: 1, ...at(700) }, ctx([at(10)])), true); // only the footer follows on the page
    assert.equal(d.pageBreakBefore!({ headlineLevel: 1, ...at(700) }, ctx([at(720)])), false);
    assert.equal(d.pageBreakBefore!({ ...at(700) }, ctx([])), false);
    assert.equal(pdfmakeFromDocument(doc([para('x')])).pageBreakBefore, undefined);
  });

  it('collapses adjacent vertical margins like CSS (the larger one wins), also into a group', () => {
    const d = pdfmakeFromDocument(doc([
      para('a', { space_after_pt: 6 }), para('b', { space_before_pt: 4, space_after_pt: 2 }), para('c', { space_before_pt: 9 }),
      { kind: 'group', keep_together: false, blocks: [para('d', { space_before_pt: 5 })] },
      { kind: 'spacer', height_mm: 4 }, para('e', { space_before_pt: 3 }),
    ]));
    assert.deepEqual(d.content.map((n) => n.margin?.[1] ?? n.stack?.[0].margin[1]), [0, 0, 7, 5, 4 * PT, 3].map((x) => Math.round(x * 100) / 100));
  });

  it('embeds images as data URLs (once per byte array) sized in pt, and draws a dashed box for a missing one', () => {
    const a = photoA();
    const d = pdfmakeFromDocument(doc([
      { kind: 'image', image: jpeg(a), width_mm: 50, height_mm: 37.5, align: 'center' },
      { kind: 'image', image: jpeg(a), width_mm: 20, height_mm: 15, align: 'right' },
      { kind: 'image', image: null, width_mm: 40, height_mm: 30, align: 'left', missing_text: 'Photo not available: Odometer' },
    ]));
    const [big, small, missing] = d.content;
    assert.deepEqual({ ...big }, { image: 'img1', width: 141.73, height: 106.3, alignment: 'center' });
    assert.equal(small.image, 'img1');
    assert.deepEqual(Object.keys(d.images), ['img1']);
    assert.equal(d.images.img1, `data:image/jpeg;base64,${toBase64(a)}`);
    assert.deepEqual(texts(missing), ['Photo not available: Odometer']);
    const c = missing.table.body[0][0];
    assert.deepEqual([c.fontSize, c.color, c.alignment, c.verticalAlignment], [8, '#666666', 'center', 'middle']);
    assert.deepEqual(missing.layout.vLineStyle(), { dash: { length: 3, space: 2 } });
    assert.equal(missing.layout.hLineColor(), '#888888');
    // outer size = content + 2 × 2 mm padding + 2 × 0.75 pt line = the resolved 40 × 30 mm
    assert.equal(Math.round((missing.table.widths[0] + 4 * PT + 1.5) * 10) / 10, Math.round(40 * PT * 10) / 10);
    assert.equal(Math.round((missing.table.heights[0] + 4 * PT + 1.5) * 10) / 10, Math.round(30 * PT * 10) / 10);
    // in the example layout the third garage photo is missing: same text as the HTML writer
    const ex = pdfmakeFromDocument(bindReport(exampleLayout(), exampleData()));
    assert.ok(texts(ex.content).includes('Photo not available: Odometer'));
  });

  it('caps an image to the width available in its cell', () => {
    const t: RTable = {
      kind: 'table', width_mm: 40, columns_mm: [40], border: { width_pt: 0.5, color: '#000000', style: 'solid' }, padding_x_mm: 0, padding_y_mm: 0, space_after_pt: 0,
      rows: [{ cells: [{ blocks: [{ kind: 'image', image: jpeg(), width_mm: 40, height_mm: 30, align: 'center' }], colspan: 1, rowspan: 1, width_mm: 40, valign: 'top' }], header: false, keep_together: false }],
    };
    const img = find(pdfmakeFromDocument(doc([t])).content, (o) => typeof o.image === 'string')[0];
    assert.equal(img.width, Math.round((40 * PT - 0.5) * 100) / 100);
    assert.ok(Math.abs(img.width / img.height - 4 / 3) < 0.01);
  });

  it('maps run styles: font, size, colour, bold, italics, underline, caps, line height per font', () => {
    const d = pdfmakeFromDocument(doc([{
      kind: 'paragraph', align: 'justify', space_before_pt: 2, space_after_pt: 3, line_height: 1.3,
      runs: [
        { text: 'Brand ', font: 'Arial', size_pt: 22, bold: true, color: '#E36C0A' },
        { text: 'plain\tafter tab', italic: true, underline: true },
        { text: 'loud', caps: true, bold: false },
      ],
    }]));
    const p = d.content[0];
    assert.equal(p.alignment, 'justify');
    assert.deepEqual(p.margin, [0, 2, 0, 3]);
    assert.equal(p.preserveLeadingSpaces, true);
    assert.deepEqual(p.text[0], { text: 'Brand ', font: 'LiberationSans', fontSize: 22, color: '#E36C0A', bold: true, lineHeight: Math.round((1.3 * 2048) / 2288 * 10000) / 10000 });
    assert.deepEqual(p.text[1], { text: 'plain    after tab', italics: true, decoration: 'underline', lineHeight: Math.round((1.3 * 2048) / 2500 * 10000) / 10000 });
    assert.deepEqual(p.text[2], { text: 'LOUD', bold: false, lineHeight: Math.round((1.3 * 2048) / 2500 * 10000) / 10000 });
  });

  it('hangs list markers in the indent and shades a paragraph background across the full width', () => {
    const d = pdfmakeFromDocument(doc([
      para('item text', { indent_mm: 6, marker: '1.' }),
      para('indented', { indent_mm: 6 }),
      para('shaded', { background: '#DCE6F2', space_after_pt: 4 }),
    ]));
    const [item, indented, shaded] = d.content;
    assert.equal(item.columns[0].width, Math.round(6 * PT * 100) / 100);
    assert.equal(item.columns[0].text, '1.');
    assert.equal(item.columns[1].width, '*');
    assert.equal(indented.margin[0], Math.round(6 * PT * 100) / 100);
    assert.equal(shaded.table.body[0][0].fillColor, '#DCE6F2');
    assert.deepEqual(shaded.table.widths, ['*']);
    assert.deepEqual(shaded.margin, [0, 0, 0, 4]);
  });

  it('maps layout font families to the shipped substitutes', () => {
    const cases: Array<[string | undefined, string | string[] | undefined, string]> = [
      ['Calibri', undefined, 'Carlito'], ['CALIBRI', undefined, 'Carlito'], ['Carlito', undefined, 'Carlito'],
      ['Cambria', undefined, 'Caladea'], [' caladea ', undefined, 'Caladea'],
      ['Arial', undefined, 'LiberationSans'], ['Helvetica', undefined, 'LiberationSans'], ['sans-serif', undefined, 'LiberationSans'],
      ["'Liberation Sans'", undefined, 'LiberationSans'], ['LiberationSans', undefined, 'LiberationSans'],
      ['Comic Neue', 'Caladea, serif', 'Caladea'], // unknown → the layout's fallback list
      ['Comic Neue', ['Cambria'], 'Caladea'], // unknown run font → the layout's default family
      ['Comic Neue', 'Wingdings', 'Carlito'], [undefined, undefined, 'Carlito'], ['constructor', 'toString', 'Carlito'],
    ];
    for (const [family, fallback, key] of cases) assert.equal(pdfFontKey(family, fallback), key, `${family} / ${fallback}`);
    const d = pdfmakeFromDocument(doc([{ kind: 'paragraph', align: 'left', space_before_pt: 0, space_after_pt: 0, runs: [{ text: 'x', font: 'Comic Neue' }] }],
      { font: { family: 'Cambria', fallback: 'serif', size_pt: 10, color: '#000000', line_height: 1.15 } }));
    assert.equal(d.content[0].text[0].font, 'Caladea');
    for (const files of Object.values(REPORT_FONT_FILES)) assert.equal(Object.keys(files).join(), 'normal,bold,italics,bolditalics');
    assert.equal(REPORT_FONT_FILES.Carlito.bolditalics, 'Carlito-BoldItalic.ttf');
  });

  it('lists the fonts and variants a definition uses (header and footer included)', () => {
    const d = pdfmakeFromDocument(bindReport(exampleLayout(), exampleData()));
    assert.deepEqual(pdfFontKeysUsed(d), ['Caladea', 'LiberationSans']); // brand runs in the header are Arial
    const used = pdfFontsUsed(d);
    assert.deepEqual(used.LiberationSans, ['bold']);
    assert.ok(used.Caladea!.includes('normal') && used.Caladea!.includes('bold') && used.Caladea!.includes('italics'));
    const fonts = pdfmakeFonts(used, (f) => `/fonts/${f}`);
    assert.deepEqual(fonts.LiberationSans, { bold: '/fonts/LiberationSans-Bold.ttf' });
    assert.equal(fonts.Caladea.normal, '/fonts/Caladea-Regular.ttf');
    assert.deepEqual(pdfFontsUsed(pdfmakeFromDocument(doc([para('x')]))), { Carlito: ['normal'] });
  });
});

// ---------------------------------------------------------------------------------------------
// Real renders with pdfmake (Node build), both insurer layouts, 30 photos

interface FieldDef { key: string; label: string; type?: string; options?: string[] }
interface SectionDef { key: string; fields?: FieldDef[] }

const LONG = 'Invented narrative sentence for the PDF test. A second invented sentence follows so that the justified text wraps over a few lines and the paragraph spacing shows.';
const OVERRIDES: Record<string, string> = {
  investigation_points: Array.from({ length: 6 }, (_, i) => `${i + 1}. Invented point number ${i + 1} to address in the field.`).join('\n'),
  statements: ['Mr. Example One (Rider statement)\n' + LONG + '\n\n' + LONG, 'Ms. Example Two (Insured statement)\n' + LONG].join('\n---\n'),
  findings: Array.from({ length: 4 }, (_, i) => `${i + 1}. ${LONG}\n\nContinuation paragraph of finding ${i + 1}.`).join('\n'),
  documents_collected: 'RC copy\nPolicy copy\nEstimate of the vehicle\nPhotographs of the vehicle',
  observations: Array.from({ length: 5 }, (_, i) => `Invented observation ${i + 1}: ${LONG}`).join('\n'),
  case_summary: LONG + '\n\n' + LONG,
  final_conclusion: LONG + '\n\n' + LONG + '\n\n**Invented bold closing sentence.**',
  conclusion: LONG + '\n\n' + LONG + '\n\n**Invented bold closing sentence.**',
  submission_date: '2099-01-09',
};
function value(f: FieldDef): string {
  if (OVERRIDES[f.key] !== undefined && f.type !== 'choice') return OVERRIDES[f.key];
  switch (f.type) {
    case 'date': return '2099-01-02';
    case 'datetime': return '2099-01-02T10:30';
    case 'number': return '3';
    case 'choice': return f.options?.[0] ?? 'Yes';
    case 'long_text': return LONG;
    default: return `Invented ${f.label.toLowerCase()}`;
  }
}

/** A real JPEG header (160 × 120) padded with incompressible bytes to the size of a 1600 px device copy. */
function devicePhoto(seed: number, size = 300_000): Uint8Array {
  const head = seed % 2 ? photoB() : photoA();
  const out = new Uint8Array(size);
  out.set(head);
  out.set(randomBytes(size - head.length), head.length);
  return out;
}

function realData(template: TemplateYaml, split: Record<string, number>): ReportData {
  const fields: ReportData['fields'] = {};
  for (const s of template.sections as unknown as SectionDef[]) for (const f of s.fields ?? []) fields[f.key] = { type: f.type ?? 'text', label: f.label, value: value(f) };
  const photos: Record<string, ReportPhoto[]> = {};
  let n = 0;
  for (const [section, count] of Object.entries(split)) {
    photos[section] = Array.from({ length: count }, () => {
      n++;
      return { evidence_id: `ev-${n}`, caption: `Invented photo ${n}`, image: { bytes: devicePhoto(n), mime: 'image/jpeg' as const, width: 1600, height: 1200 } };
    });
  }
  const img = { bytes: photoB(), mime: 'image/jpeg' as const };
  return {
    case: {
      case_ref: 'INV-2099-000001', insurer_code: 'EXM', insurer_name: 'Example Insurance Ltd', claim_no: 'EX/CLM/0001', policy_no: 'EX-POL-0001',
      template_key: 'x', template_name: 'x', template_version: 1, office_owner_name: 'Asha Example',
      received_at: '2099-01-02T04:30:00Z', due_at: '2099-01-17T04:30:00Z', generated_at: '2099-01-10T06:45:00+00:00', report_version: 1,
    },
    fields, photos, assets: { band_top: img, logo: img, band_bottom: img, seal: img },
  };
}

/** Image placements in the page content streams (`/In Do`). */
function imageDraws(pdf: Buffer): number {
  let draws = 0;
  const s = pdf.toString('latin1');
  for (const m of s.matchAll(/<<([^]*?)>>\s*stream\r?\n/g)) {
    if (!/\/FlateDecode/.test(m[1]) || /\/Subtype\s*\/Image|\/Length1/.test(m[1])) continue;
    const start = m.index! + m[0].length;
    const len = Number(/\/Length (\d+)/.exec(m[1])?.[1]);
    if (!Number.isFinite(len)) continue;
    try {
      draws += (inflateSync(pdf.subarray(start, start + len)).toString('latin1').match(/\/I\d+ Do/g) ?? []).length;
    } catch { /* not a content stream */ }
  }
  return draws;
}

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

const LAYOUTS = [
  ['icl-motor-od.yaml', 'ICICI Lombard Motor OD', { garage: 24, driver: 1, statement: 3, timeline: 2 }],
  ['igi-motor-od.yaml', 'IndusInd / Reliance Motor OD', { garage: 24, spot: 4, driver: 2 }],
] as const;

for (const [file, name, split] of LAYOUTS) {
  describe(`PDF render with pdfmake: ${name}`, () => {
    it('renders a valid multi-page PDF with 30 photos and "Page x of y" on every page', async (t) => {
      const path = `${TEMPLATES_DIR}${file}`;
      const { config, errors } = resolveTemplateLayout(readYaml<TemplateYaml>(path), path);
      assert.deepEqual(errors, []);
      const layout = structuredClone(config.report_layout) as ReportLayout;
      // test-only: add the page fields to the footer (ICICI prints none, IndusInd only the number)
      layout.footer = [...(layout.footer ?? []), { type: 'paragraph', text: 'Page {{page}} of {{pages}}', style: { size_pt: 8, align: 'center' } }];
      const data = realData(config, split);
      assert.equal(Object.values(data.photos!).flat().length, 30);

      const wall0 = performance.now();
      const cpu0 = cpuMs();
      const { definition, fonts, warnings } = renderReportPdfDefinition(layout, data, { now: NOW, creator: 'Report tests' });
      const cpuDef = cpuMs() - cpu0;
      assert.deepEqual(warnings, []);

      const calls: Array<{ page: number; pages: number; text: string[] }> = [];
      const footer = definition.footer!;
      definition.footer = (page, pages) => {
        const node = footer(page, pages);
        calls.push({ page, pages, text: texts(node) });
        return node;
      };
      // image placements expected: body images once, header / footer images on every page
      const bodyImages = find(definition.content, (o) => typeof o.image === 'string').length;
      const bandImages = find([definition.header!(1, 1), footer(1, 1)], (o) => typeof o.image === 'string').length;

      // only the font files the definition asks for: pdfmake throws if anything else is needed
      pdfmake.setFonts(pdfmakeFonts(fonts, (f) => join(FONTS_DIR, f)));
      pdfmake.setUrlAccessPolicy(() => false);
      pdfmake.setLocalAccessPolicy((p: string) => p.startsWith(FONTS_DIR));
      const cpu1 = cpuMs();
      const pdf = await pdfmake.createPdf(definition as unknown as Parameters<typeof pdfmake.createPdf>[0]).getBuffer();
      const cpuPdf = cpuMs() - cpu1;
      const wall = performance.now() - wall0;

      assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(pdf.subarray(-32).toString('latin1'), /%%EOF\s*$/);
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      assert.ok(pages >= 8 && pages <= 30, `${pages} pages`);
      assert.deepEqual(calls.map((c) => c.page), Array.from({ length: pages }, (_, i) => i + 1));
      for (const c of calls) {
        assert.equal(c.pages, pages);
        assert.ok(c.text.includes(`Page ${c.page} of ${pages}`), JSON.stringify(c.text));
      }
      // nothing dropped by an unbreakable block that did not fit: every image is drawn
      assert.equal(imageDraws(pdf), bodyImages + pages * bandImages);
      assert.ok(bodyImages >= 31, `${bodyImages} body images`); // 30 photos + seal
      assert.ok(pdf.length > 30 * 300_000, 'photos embedded as given');

      t.diagnostic(`${name}: ${pages} pages, ${(pdf.length / 1e6).toFixed(2)} MB, wall ${Math.round(wall)} ms, ` +
        `CPU definition ${Math.round(cpuDef)} ms + pdfmake ${Math.round(cpuPdf)} ms, fonts ${JSON.stringify(fonts)}`);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, file.replace('.yaml', '.pdf')), pdf);
      }
    });
  });
}

