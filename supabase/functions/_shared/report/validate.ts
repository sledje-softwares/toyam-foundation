// Strict validator for report layouts (spec.ts). Returns readable errors with JSON paths, e.g.
// `$.body[2].rows[4].cells[1].colspan: must be an integer from 1 to 2`. Used by the template loader before a layout
// is stored, and by bind() as a guard. Pure; no imports beyond spec.ts / image.ts.
import { fromBase64, sniffImage } from './image.ts';
import { FORMATTERS, LAYOUT_VERSION, parseTemplate } from './spec.ts';

/** Optional template facts: field key → field type, and section keys. Enables reference checks. */
export interface LayoutTemplateInfo {
  fields: Record<string, string>;
  sections: string[];
}

type Where = 'body' | 'header' | 'cell' | 'header_cell';

interface Ctx {
  errors: string[];
  styles: Set<string>;
  tableStyles: Set<string>;
  assets: Set<string>;
  template?: LayoutTemplateInfo;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,62}$/;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace']);
const MAX_TEXT = 20_000;
const MAX_DEPTH = 8;
const MAX_ASSET_BYTES = 3 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function err(c: Ctx, path: string, msg: string): void {
  c.errors.push(`${path}: ${msg}`);
}

function obj(c: Ctx, path: string, v: unknown, allowed: string[], required: string[] = []): v is Record<string, unknown> {
  if (!isObj(v)) { err(c, path, 'must be an object'); return false; }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(c, `${path}.${k}`, `unknown key (allowed: ${allowed.join(', ')})`);
  for (const k of required) if (v[k] === undefined) err(c, `${path}.${k}`, 'is required');
  return true;
}

function num(c: Ctx, path: string, v: unknown, min: number, max: number, int = false): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    err(c, path, `must be ${int ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
}
function bool(c: Ctx, path: string, v: unknown): void {
  if (v !== undefined && typeof v !== 'boolean') err(c, path, 'must be true or false');
}
function oneOf(c: Ctx, path: string, v: unknown, values: readonly string[]): void {
  if (v !== undefined && !values.includes(v as string)) err(c, path, `must be one of ${values.join(', ')}`);
}
function color(c: Ctx, path: string, v: unknown): void {
  if (v !== undefined && (typeof v !== 'string' || !COLOR_RE.test(v))) err(c, path, 'must be a colour like #1F3864');
}
function plainString(c: Ctx, path: string, v: unknown, max = 500): void {
  if (v !== undefined && (typeof v !== 'string' || v.length > max)) err(c, path, `must be text of at most ${max} characters`);
}
function fontName(c: Ctx, path: string, v: unknown): void {
  if (v !== undefined && (typeof v !== 'string' || !FONT_RE.test(v))) err(c, path, 'must be a font family name (letters, digits, spaces, hyphens)');
}
function fontList(c: Ctx, path: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v !== 'string') { err(c, path, 'must be a comma-separated list of font names'); return; }
  for (const f of v.split(',').map((s) => s.trim())) {
    if (!FONT_RE.test(f) && !GENERIC_FONTS.has(f)) err(c, path, `bad font name "${f}"`);
  }
}

/** Text with placeholders. `allow` lists the namespaces permitted here besides case and field. */
function text(c: Ctx, path: string, v: unknown, allow: { page?: boolean; item?: boolean }): void {
  if (typeof v !== 'string') { err(c, path, 'must be text'); return; }
  if (v.length > MAX_TEXT) { err(c, path, `is longer than ${MAX_TEXT} characters`); return; }
  const { parts, errors } = parseTemplate(v);
  for (const e of errors) err(c, path, e);
  for (const p of parts) {
    if (typeof p === 'string') continue;
    if ((p.ns === 'page' || p.ns === 'pages') && !allow.page) err(c, path, `{{${p.ns}}} is only allowed in the header and footer`);
    if ((p.ns === 'item' || p.ns === 'index') && !allow.item) err(c, path, `{{${p.ns}}} is only allowed in the cells of a repeat row`);
    if (p.ns === 'field') fieldRef(c, path, p.key);
    for (const f of p.formatters) if (!FORMATTERS[f.name]) err(c, path, `unknown formatter ${f.name}`);
  }
}

function fieldRef(c: Ctx, path: string, key: unknown): void {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key)) { err(c, path, 'must be a field key'); return; }
  if (c.template && !(key in c.template.fields)) err(c, path, `unknown field "${key}" in this template`);
}
function sectionRef(c: Ctx, path: string, key: unknown): void {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key)) { err(c, path, 'must be a section key'); return; }
  if (c.template && !c.template.sections.includes(key)) err(c, path, `unknown section "${key}" in this template`);
}

const STYLE_KEYS = ['use', 'font', 'size_pt', 'color', 'bold', 'italic', 'underline', 'caps', 'align', 'background',
  'space_before_pt', 'space_after_pt', 'line_height', 'indent_mm'];

function textStyle(c: Ctx, path: string, v: unknown): void {
  if (!obj(c, path, v, STYLE_KEYS)) return;
  if (v.use !== undefined && (typeof v.use !== 'string' || !c.styles.has(v.use))) err(c, `${path}.use`, `unknown style "${String(v.use)}"`);
  fontName(c, `${path}.font`, v.font);
  num(c, `${path}.size_pt`, v.size_pt, 4, 72);
  color(c, `${path}.color`, v.color);
  color(c, `${path}.background`, v.background);
  for (const k of ['bold', 'italic', 'underline', 'caps']) bool(c, `${path}.${k}`, v[k]);
  oneOf(c, `${path}.align`, v.align, ['left', 'center', 'right', 'justify']);
  num(c, `${path}.space_before_pt`, v.space_before_pt, 0, 72);
  num(c, `${path}.space_after_pt`, v.space_after_pt, 0, 72);
  num(c, `${path}.line_height`, v.line_height, 0.8, 3);
  num(c, `${path}.indent_mm`, v.indent_mm, 0, 100);
}

function styleRef(c: Ctx, path: string, v: unknown): void {
  if (v === undefined) return;
  if (typeof v === 'string') { if (!c.styles.has(v)) err(c, path, `unknown style "${v}"`); return; }
  textStyle(c, path, v);
}

function border(c: Ctx, path: string, v: unknown): void {
  if (v === undefined || v === 'none') return;
  if (!obj(c, path, v, ['width_pt', 'color', 'style'], ['width_pt', 'color'])) return;
  num(c, `${path}.width_pt`, v.width_pt, 0.25, 6);
  color(c, `${path}.color`, v.color);
  oneOf(c, `${path}.style`, v.style, ['solid', 'dashed']);
}

function tableStyle(c: Ctx, path: string, v: unknown): void {
  if (!obj(c, path, v, ['use', 'border', 'padding_x_mm', 'padding_y_mm', 'cell_style', 'label_style', 'value_style', 'heading_style', 'space_after_pt'])) return;
  if (v.use !== undefined && (typeof v.use !== 'string' || !c.tableStyles.has(v.use))) err(c, `${path}.use`, `unknown table style "${String(v.use)}"`);
  border(c, `${path}.border`, v.border);
  num(c, `${path}.padding_x_mm`, v.padding_x_mm, 0, 20);
  num(c, `${path}.padding_y_mm`, v.padding_y_mm, 0, 20);
  for (const k of ['cell_style', 'label_style', 'value_style', 'heading_style']) styleRef(c, `${path}.${k}`, v[k]);
  num(c, `${path}.space_after_pt`, v.space_after_pt, 0, 72);
}

function condition(c: Ctx, path: string, v: unknown, depth = 0): void {
  if (!isObj(v)) { err(c, path, 'must be an object'); return; }
  if (depth > MAX_DEPTH) { err(c, path, 'is nested too deeply'); return; }
  if ('field' in v) {
    if (!obj(c, path, v, ['field', 'filled', 'equals', 'not_equals', 'in'], ['field'])) return;
    fieldRef(c, `${path}.field`, v.field);
    const tests = ['filled', 'equals', 'not_equals', 'in'].filter((k) => v[k] !== undefined);
    if (tests.length > 1) err(c, path, `use one of filled, equals, not_equals, in (found ${tests.join(', ')})`);
    bool(c, `${path}.filled`, v.filled);
    plainString(c, `${path}.equals`, v.equals);
    plainString(c, `${path}.not_equals`, v.not_equals);
    if (v.in !== undefined && (!Array.isArray(v.in) || v.in.some((x) => typeof x !== 'string'))) err(c, `${path}.in`, 'must be a list of texts');
  } else if ('photos' in v) {
    if (obj(c, path, v, ['photos'])) sectionRef(c, `${path}.photos`, v.photos);
  } else if ('all' in v || 'any' in v) {
    const k = 'all' in v ? 'all' : 'any';
    if (!obj(c, path, v, [k])) return;
    const list = v[k];
    if (!Array.isArray(list) || list.length === 0) { err(c, `${path}.${k}`, 'must be a non-empty list of conditions'); return; }
    list.forEach((x, i) => condition(c, `${path}.${k}[${i}]`, x, depth + 1));
  } else if ('not' in v) {
    if (obj(c, path, v, ['not'])) condition(c, `${path}.not`, v.not, depth + 1);
  } else {
    err(c, path, 'must have one of field, photos, all, any, not');
  }
}

function runs(c: Ctx, path: string, v: unknown, allow: { page?: boolean; item?: boolean }): void {
  if (!Array.isArray(v) || v.length === 0) { err(c, path, 'must be a non-empty list'); return; }
  v.forEach((r, i) => {
    const p = `${path}[${i}]`;
    if (!obj(c, p, r, ['text', 'style'], ['text'])) return;
    text(c, `${p}.text`, r.text, allow);
    styleRef(c, `${p}.style`, r.style);
  });
}

const SPLITS = ['auto', 'lines', 'paragraphs', 'sections'];
const BLOCKS_BY_WHERE: Record<Where, string[]> = {
  body: ['paragraph', 'heading', 'list', 'table', 'image', 'photos', 'spacer', 'rule', 'page_break', 'group'],
  header: ['paragraph', 'heading', 'table', 'image', 'spacer', 'rule', 'group'],
  cell: ['paragraph', 'heading', 'list', 'image', 'photos', 'spacer', 'rule', 'group'],
  header_cell: ['paragraph', 'heading', 'image', 'spacer', 'rule', 'group'],
};

function blocks(c: Ctx, path: string, v: unknown, where: Where, allowItem: boolean, depth: number): void {
  if (!Array.isArray(v)) { err(c, path, 'must be a list of blocks'); return; }
  v.forEach((b, i) => block(c, `${path}[${i}]`, b, where, allowItem, depth));
}

function block(c: Ctx, path: string, b: unknown, where: Where, allowItem: boolean, depth: number): void {
  if (!isObj(b)) { err(c, path, 'must be an object'); return; }
  if (depth > MAX_DEPTH) { err(c, path, 'is nested too deeply'); return; }
  const type = b.type;
  const allowed = BLOCKS_BY_WHERE[where];
  if (typeof type !== 'string' || !allowed.includes(type)) {
    err(c, `${path}.type`, `unknown or not allowed here: "${String(type)}" (allowed: ${allowed.join(', ')})`);
    return;
  }
  const allow = { page: where === 'header' || where === 'header_cell', item: allowItem };
  if (b.when !== undefined) condition(c, `${path}.when`, b.when);
  switch (type) {
    case 'paragraph': {
      if (!obj(c, path, b, ['type', 'when', 'text', 'runs', 'style', 'markup'])) return;
      if ((b.text === undefined) === (b.runs === undefined)) err(c, path, 'needs exactly one of text, runs');
      if (b.text !== undefined) text(c, `${path}.text`, b.text, allow);
      if (b.runs !== undefined) runs(c, `${path}.runs`, b.runs, allow);
      styleRef(c, `${path}.style`, b.style);
      bool(c, `${path}.markup`, b.markup);
      return;
    }
    case 'heading': {
      if (!obj(c, path, b, ['type', 'when', 'text', 'level', 'style'], ['text'])) return;
      text(c, `${path}.text`, b.text, allow);
      num(c, `${path}.level`, b.level, 1, 3, true);
      styleRef(c, `${path}.style`, b.style);
      return;
    }
    case 'list': {
      if (!obj(c, path, b, ['type', 'when', 'field', 'items', 'split', 'ordered', 'start', 'style', 'indent_mm', 'empty_text', 'markup'])) return;
      if ((b.field === undefined) === (b.items === undefined)) err(c, path, 'needs exactly one of field, items');
      if (b.field !== undefined) fieldRef(c, `${path}.field`, b.field);
      if (b.items !== undefined) {
        if (!Array.isArray(b.items) || b.items.length === 0) err(c, `${path}.items`, 'must be a non-empty list of texts');
        else b.items.forEach((x, i) => text(c, `${path}.items[${i}]`, x, allow));
      }
      oneOf(c, `${path}.split`, b.split, SPLITS);
      bool(c, `${path}.ordered`, b.ordered);
      bool(c, `${path}.markup`, b.markup);
      num(c, `${path}.start`, b.start, 0, 9999, true);
      num(c, `${path}.indent_mm`, b.indent_mm, 0, 50);
      styleRef(c, `${path}.style`, b.style);
      if (b.empty_text !== undefined) text(c, `${path}.empty_text`, b.empty_text, allow);
      return;
    }
    case 'image': {
      if (!obj(c, path, b, ['type', 'when', 'asset', 'width_mm', 'height_mm', 'max_height_mm', 'align'], ['asset'])) return;
      if (typeof b.asset !== 'string' || !c.assets.has(b.asset)) err(c, `${path}.asset`, `unknown asset "${String(b.asset)}" (declare it under assets)`);
      num(c, `${path}.width_mm`, b.width_mm, 1, 500);
      num(c, `${path}.height_mm`, b.height_mm, 1, 500);
      num(c, `${path}.max_height_mm`, b.max_height_mm, 1, 500);
      oneOf(c, `${path}.align`, b.align, ['left', 'center', 'right']);
      return;
    }
    case 'photos': {
      if (!obj(c, path, b, ['type', 'when', 'section', 'columns', 'max_height_mm', 'gap_mm', 'captions', 'caption_style', 'limit', 'border', 'empty_text'], ['section'])) return;
      sectionRef(c, `${path}.section`, b.section);
      num(c, `${path}.columns`, b.columns, 1, 4, true);
      num(c, `${path}.max_height_mm`, b.max_height_mm, 10, 400);
      num(c, `${path}.gap_mm`, b.gap_mm, 0, 20);
      bool(c, `${path}.captions`, b.captions);
      styleRef(c, `${path}.caption_style`, b.caption_style);
      num(c, `${path}.limit`, b.limit, 1, 500, true);
      border(c, `${path}.border`, b.border);
      if (b.empty_text !== undefined) text(c, `${path}.empty_text`, b.empty_text, allow);
      return;
    }
    case 'spacer': {
      if (!obj(c, path, b, ['type', 'when', 'height_mm'], ['height_mm'])) return;
      num(c, `${path}.height_mm`, b.height_mm, 0.5, 200);
      return;
    }
    case 'rule': {
      if (!obj(c, path, b, ['type', 'when', 'color', 'width_pt'])) return;
      color(c, `${path}.color`, b.color);
      num(c, `${path}.width_pt`, b.width_pt, 0.25, 6);
      return;
    }
    case 'page_break': {
      obj(c, path, b, ['type', 'when']);
      return;
    }
    case 'group': {
      if (!obj(c, path, b, ['type', 'when', 'blocks', 'keep_together'], ['blocks'])) return;
      bool(c, `${path}.keep_together`, b.keep_together);
      blocks(c, `${path}.blocks`, b.blocks, where, allowItem, depth + 1);
      return;
    }
    case 'table': {
      table(c, path, b, where, depth);
      return;
    }
  }
}

function cell(c: Ctx, path: string, v: unknown, where: Where, allowItem: boolean, columns: number, depth: number): { colspan: number; rowspan: number } {
  const spans = { colspan: 1, rowspan: 1 };
  if (typeof v === 'string') { text(c, path, v, { page: where === 'header', item: allowItem }); return spans; }
  if (!obj(c, path, v, ['text', 'runs', 'markup', 'blocks', 'colspan', 'rowspan', 'style', 'valign', 'background', 'border'])) return spans;
  const content = ['text', 'runs', 'blocks'].filter((k) => v[k] !== undefined);
  if (content.length > 1) err(c, path, `use one of text, runs, blocks (found ${content.join(', ')})`);
  const allow = { page: where === 'header', item: allowItem };
  if (v.text !== undefined) text(c, `${path}.text`, v.text, allow);
  if (v.runs !== undefined) runs(c, `${path}.runs`, v.runs, allow);
  if (v.blocks !== undefined) blocks(c, `${path}.blocks`, v.blocks, where === 'header' ? 'header_cell' : 'cell', allowItem, depth + 1);
  bool(c, `${path}.markup`, v.markup);
  num(c, `${path}.colspan`, v.colspan, 1, columns, true);
  num(c, `${path}.rowspan`, v.rowspan, 1, 200, true);
  styleRef(c, `${path}.style`, v.style);
  oneOf(c, `${path}.valign`, v.valign, ['top', 'middle', 'bottom']);
  color(c, `${path}.background`, v.background);
  oneOf(c, `${path}.border`, v.border, ['none']);
  if (typeof v.colspan === 'number' && Number.isInteger(v.colspan)) spans.colspan = v.colspan;
  if (typeof v.rowspan === 'number' && Number.isInteger(v.rowspan)) spans.rowspan = v.rowspan;
  return spans;
}

function table(c: Ctx, path: string, b: Record<string, unknown>, where: Where, depth: number): void {
  if (!obj(c, path, b, ['type', 'when', 'columns', 'style', 'rows', 'width_pct'], ['columns', 'rows'])) return;
  const cols = b.columns;
  let n = 0;
  if (!Array.isArray(cols) || cols.length === 0 || cols.length > 12 || cols.some((x) => typeof x !== 'number' || !(x > 0))) {
    err(c, `${path}.columns`, 'must be a list of 1 to 12 positive relative widths');
  } else n = cols.length;
  if (typeof b.style === 'string') { if (!c.tableStyles.has(b.style)) err(c, `${path}.style`, `unknown table style "${b.style}"`); }
  else if (b.style !== undefined) tableStyle(c, `${path}.style`, b.style);
  num(c, `${path}.width_pct`, b.width_pct, 10, 100);
  if (!Array.isArray(b.rows) || b.rows.length === 0) { err(c, `${path}.rows`, 'must be a non-empty list'); return; }
  if (n === 0) return;

  const occ = new Array<number>(n).fill(0); // rows still covered by a rowspan from above, per column
  let headerOpen = true;
  b.rows.forEach((r, i) => {
    const rp = `${path}.rows[${i}]`;
    if (!isObj(r)) { err(c, rp, 'must be an object'); return; }
    const spanned = occ.some((x) => x > 0);
    const placed: Array<{ colspan: number; rowspan: number }> = [];
    let isRepeat = false;
    if (r.when !== undefined) {
      condition(c, `${rp}.when`, r.when);
      if (spanned) err(c, `${rp}.when`, 'not allowed on a row covered by a rowspan (put the condition on the table)');
    }
    const isHeader = r.header === true;
    if (isHeader && !headerOpen) err(c, `${rp}.header`, 'header rows must come first');
    if (!isHeader) headerOpen = false;

    if ('heading' in r) {
      if (!obj(c, rp, r, ['heading', 'style', 'when', 'header'])) return;
      text(c, `${rp}.heading`, r.heading, { page: where === 'header' });
      styleRef(c, `${rp}.style`, r.style);
      bool(c, `${rp}.header`, r.header);
      placed.push({ colspan: n, rowspan: 1 });
    } else if ('field' in r) {
      if (!obj(c, rp, r, ['field', 'label', 'value', 'label_style', 'value_style', 'label_span', 'when', 'markup'])) return;
      fieldRef(c, `${rp}.field`, r.field);
      if (r.label !== undefined) text(c, `${rp}.label`, r.label, {});
      if (r.value !== undefined) text(c, `${rp}.value`, r.value, {});
      styleRef(c, `${rp}.label_style`, r.label_style);
      styleRef(c, `${rp}.value_style`, r.value_style);
      bool(c, `${rp}.markup`, r.markup);
      if (n < 2) { err(c, rp, 'a field row needs a table of at least 2 columns'); return; }
      num(c, `${rp}.label_span`, r.label_span, 1, n - 1, true);
      const ls = typeof r.label_span === 'number' && Number.isInteger(r.label_span) && r.label_span < n ? r.label_span : 1;
      placed.push({ colspan: ls, rowspan: 1 }, { colspan: n - ls, rowspan: 1 });
    } else if ('repeat' in r) {
      isRepeat = true;
      if (!obj(c, rp, r, ['repeat', 'cells', 'when', 'empty'], ['cells'])) return;
      if (obj(c, `${rp}.repeat`, r.repeat, ['field', 'split'], ['field'])) {
        fieldRef(c, `${rp}.repeat.field`, r.repeat.field);
        oneOf(c, `${rp}.repeat.split`, r.repeat.split, SPLITS);
      }
      if (where === 'header') err(c, rp, 'repeat rows are not allowed in the header or footer');
      if (spanned) err(c, rp, 'a repeat row cannot sit beside a rowspan');
      if (!Array.isArray(r.cells) || r.cells.length === 0) { err(c, `${rp}.cells`, 'must be a non-empty list'); return; }
      r.cells.forEach((x, j) => placed.push(cell(c, `${rp}.cells[${j}]`, x, where, true, n, depth)));
      if (r.empty !== undefined) {
        if (!Array.isArray(r.empty) || r.empty.length === 0) err(c, `${rp}.empty`, 'must be a non-empty list of cells');
        else {
          const es = r.empty.map((x, j) => cell(c, `${rp}.empty[${j}]`, x, where, false, n, depth));
          const w = es.reduce((s, x) => s + x.colspan, 0);
          if (w !== n) err(c, `${rp}.empty`, `cells cover ${plural(w, 'column')}, the table has ${n}`);
          if (es.some((x) => x.rowspan > 1)) err(c, `${rp}.empty`, 'rowspan is not allowed here');
        }
      }
    } else if ('cells' in r) {
      if (!obj(c, rp, r, ['cells', 'when', 'header', 'keep_together', 'height_mm'])) return;
      bool(c, `${rp}.header`, r.header);
      bool(c, `${rp}.keep_together`, r.keep_together);
      num(c, `${rp}.height_mm`, r.height_mm, 1, 300);
      if (!Array.isArray(r.cells) || r.cells.length === 0) { err(c, `${rp}.cells`, 'must be a non-empty list'); return; }
      r.cells.forEach((x, j) => placed.push(cell(c, `${rp}.cells[${j}]`, x, where, false, n, depth)));
    } else {
      err(c, rp, 'must have one of cells, heading, field, repeat');
      return;
    }

    if ((r.when !== undefined || isRepeat) && placed.some((p) => p.rowspan > 1)) {
      err(c, rp, 'a conditional or repeat row cannot start a rowspan');
    }
    // place the cells into the free columns, left to right
    let col = 0;
    let ok = true;
    const starts: number[] = [];
    for (const p of placed) {
      while (col < n && occ[col] > 0) col++;
      if (col + p.colspan > n || occ.slice(col, col + p.colspan).some((x) => x > 0)) { ok = false; break; }
      starts.push(col);
      col += p.colspan;
    }
    while (col < n && occ[col] > 0) col++;
    if (!ok || col !== n) {
      const free = occ.filter((x) => x === 0).length;
      const used = placed.reduce((s, p) => s + p.colspan, 0);
      err(c, rp, `cells cover ${plural(used, 'column')} but ${plural(free, 'free column')} remain in this row (table has ${n})`);
      return;
    }
    for (let k = 0; k < n; k++) if (occ[k] > 0) occ[k]--;
    placed.forEach((p, j) => {
      if (p.rowspan > 1) for (let k = starts[j]; k < starts[j] + p.colspan; k++) occ[k] = p.rowspan - 1;
    });
  });
  if (occ.some((x) => x > 0)) err(c, `${path}.rows`, 'a rowspan runs past the last row');
}

function asset(c: Ctx, path: string, v: unknown): void {
  if (isObj(v) && 'file' in v) {
    err(c, path, 'file assets must be embedded by the template loader (npm run templates:load)');
    return;
  }
  if (isObj(v) && 'runtime' in v) {
    if (!obj(c, path, v, ['runtime', 'description'])) return;
    if (v.runtime !== true) err(c, `${path}.runtime`, 'must be true');
    plainString(c, `${path}.description`, v.description);
    return;
  }
  if (!obj(c, path, v, ['mime', 'width', 'height', 'data_base64'], ['mime', 'width', 'height', 'data_base64'])) return;
  oneOf(c, `${path}.mime`, v.mime, ['image/jpeg', 'image/png']);
  num(c, `${path}.width`, v.width, 1, 20000, true);
  num(c, `${path}.height`, v.height, 1, 20000, true);
  if (typeof v.data_base64 !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(v.data_base64)) {
    err(c, `${path}.data_base64`, 'must be base64');
    return;
  }
  if (v.data_base64.length > (MAX_ASSET_BYTES * 4) / 3 + 4) { err(c, `${path}.data_base64`, `image larger than ${MAX_ASSET_BYTES} bytes`); return; }
  try {
    const head = fromBase64(v.data_base64.replace(/\s+/g, '').slice(0, 60));
    if (sniffImage(head) !== v.mime) err(c, `${path}.data_base64`, `does not hold a ${String(v.mime)} image`);
  } catch {
    err(c, `${path}.data_base64`, 'must be base64');
  }
}

/**
 * Validates a layout. Returns `path: message` strings; empty when the layout is valid. With `template`, field and
 * section references are checked against that template version too.
 */
export function validateLayout(input: unknown, template?: LayoutTemplateInfo): string[] {
  const c: Ctx = { errors: [], styles: new Set(), tableStyles: new Set(), assets: new Set(), template };
  const top = ['version', 'name', 'page', 'font', 'paragraph_spacing_pt', 'date_format', 'datetime_format', 'empty_value',
    'styles', 'table_styles', 'assets', 'header', 'footer', 'body'];
  if (!obj(c, '$', input, top, ['version', 'page', 'font', 'body'])) return c.errors;
  const L = input;
  if (L.version !== undefined && L.version !== LAYOUT_VERSION) err(c, '$.version', `must be ${LAYOUT_VERSION}`);
  plainString(c, '$.name', L.name, 200);

  // names first, so references can be checked in any order
  for (const [k, set] of [['styles', c.styles], ['table_styles', c.tableStyles], ['assets', c.assets]] as const) {
    const m = L[k];
    if (m === undefined) continue;
    if (!isObj(m)) { err(c, `$.${k}`, 'must be a map of names'); continue; }
    for (const name of Object.keys(m)) {
      if (!NAME_RE.test(name)) err(c, `$.${k}.${name}`, 'name must start with a letter and use letters, digits, _');
      set.add(name);
    }
  }
  if (isObj(L.styles)) {
    for (const [name, s] of Object.entries(L.styles)) textStyle(c, `$.styles.${name}`, s);
    // cycles through `use`
    for (const name of Object.keys(L.styles)) {
      const seen = new Set<string>();
      let cur: string | undefined = name;
      while (cur !== undefined && isObj(L.styles[cur])) {
        if (seen.has(cur)) { err(c, `$.styles.${name}.use`, 'styles refer to each other in a loop'); break; }
        seen.add(cur);
        const u: unknown = (L.styles[cur] as Record<string, unknown>).use;
        cur = typeof u === 'string' ? u : undefined;
      }
    }
  }
  if (isObj(L.table_styles)) {
    for (const [name, s] of Object.entries(L.table_styles)) tableStyle(c, `$.table_styles.${name}`, s);
    for (const name of Object.keys(L.table_styles)) {
      const seen = new Set<string>();
      let cur: string | undefined = name;
      while (cur !== undefined && isObj(L.table_styles[cur])) {
        if (seen.has(cur)) { err(c, `$.table_styles.${name}.use`, 'table styles refer to each other in a loop'); break; }
        seen.add(cur);
        const u: unknown = (L.table_styles[cur] as Record<string, unknown>).use;
        cur = typeof u === 'string' ? u : undefined;
      }
    }
  }
  if (isObj(L.assets)) for (const [name, a] of Object.entries(L.assets)) asset(c, `$.assets.${name}`, a);

  if (obj(c, '$.page', L.page, ['size', 'orientation', 'margin_mm', 'header_mm', 'footer_mm'], ['size', 'margin_mm'])) {
    const P = L.page;
    oneOf(c, '$.page.size', P.size, ['A4', 'Letter', 'Legal']);
    oneOf(c, '$.page.orientation', P.orientation, ['portrait', 'landscape']);
    if (obj(c, '$.page.margin_mm', P.margin_mm, ['top', 'right', 'bottom', 'left'], ['top', 'right', 'bottom', 'left'])) {
      for (const k of ['top', 'right', 'bottom', 'left']) num(c, `$.page.margin_mm.${k}`, P.margin_mm[k], 0, 80);
    }
    num(c, '$.page.header_mm', P.header_mm, 0, 60);
    num(c, '$.page.footer_mm', P.footer_mm, 0, 60);
  }
  if (obj(c, '$.font', L.font, ['family', 'fallback', 'size_pt', 'color', 'line_height'], ['family', 'size_pt'])) {
    fontName(c, '$.font.family', L.font.family);
    fontList(c, '$.font.fallback', L.font.fallback);
    num(c, '$.font.size_pt', L.font.size_pt, 5, 30);
    color(c, '$.font.color', L.font.color);
    num(c, '$.font.line_height', L.font.line_height, 0.8, 3);
  }
  num(c, '$.paragraph_spacing_pt', L.paragraph_spacing_pt, 0, 48);
  plainString(c, '$.date_format', L.date_format, 60);
  plainString(c, '$.datetime_format', L.datetime_format, 60);
  plainString(c, '$.empty_value', L.empty_value, 60);
  if (L.header !== undefined) blocks(c, '$.header', L.header, 'header', false, 0);
  if (L.footer !== undefined) blocks(c, '$.footer', L.footer, 'header', false, 0);
  if (L.body !== undefined) {
    if (!Array.isArray(L.body) || L.body.length === 0) err(c, '$.body', 'must be a non-empty list of blocks');
    else blocks(c, '$.body', L.body, 'body', false, 0);
  }
  return c.errors;
}

/** Template facts for validateLayout from a template config (YAML / JSON form). */
export function templateInfo(sections: Array<{ key: string; fields?: Array<{ key: string; type?: string }> }>): LayoutTemplateInfo {
  const fields: Record<string, string> = {};
  for (const s of sections) for (const f of s.fields ?? []) fields[f.key] = f.type ?? 'text';
  return { fields, sections: sections.map((s) => s.key) };
}
