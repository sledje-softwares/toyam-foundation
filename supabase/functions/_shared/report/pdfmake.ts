// Resolved document → pdfmake document definition (D51, 7.7: the PDF is built in the office user's browser).
// Pure; no npm imports (pdfmake's types are not resolvable in Deno): the definition is a plain object with a few
// functions (header / footer per page, table line styles, keep-with-next for headings) that pdfmake 0.3 accepts.
// Rendering decisions follow html.ts (the preview the user approves) so the PDF looks like the HTML version:
// same cell padding, border widths / colours, shading, alignment, column widths, line height, placeholders.
import type { ReportData } from './bind.ts';
import { bindReport, type RBlock, type RCell, type ResolvedDocument, type ResolvedImage, type RImage, type RParagraph, type RRun, type RTable } from './bind.ts';
import type { ReportLayout } from './spec.ts';
import { sniffImage, toBase64 } from './image.ts';

// ---------------------------------------------------------------------------------------------
// Fonts

export type PdfFontVariant = 'normal' | 'bold' | 'italics' | 'bolditalics';
export type PdfFontKey = 'Carlito' | 'Caladea' | 'LiberationSans';

/** File names per pdfmake font key, as served from `apps/web/public/fonts/` (metric-compatible open substitutes). */
export const REPORT_FONT_FILES: Readonly<Record<PdfFontKey, Readonly<Record<PdfFontVariant, string>>>> = {
  Carlito: { normal: 'Carlito-Regular.ttf', bold: 'Carlito-Bold.ttf', italics: 'Carlito-Italic.ttf', bolditalics: 'Carlito-BoldItalic.ttf' },
  Caladea: { normal: 'Caladea-Regular.ttf', bold: 'Caladea-Bold.ttf', italics: 'Caladea-Italic.ttf', bolditalics: 'Caladea-BoldItalic.ttf' },
  LiberationSans: {
    normal: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italics: 'LiberationSans-Italic.ttf', bolditalics: 'LiberationSans-BoldItalic.ttf',
  },
};

/**
 * (hhea ascent − descent) / units per em of each file. pdfmake's `lineHeight` multiplies this font box while CSS
 * `line-height` multiplies the font size, so a layout's 1.15 becomes 1.15 / EM for pdfmake.
 */
export const REPORT_FONT_EM_HEIGHT: Readonly<Record<PdfFontKey, number>> = {
  Carlito: 2500 / 2048, // 1950 + 550
  Caladea: 1.15, // 900 + 250 / 1000
  LiberationSans: 2288 / 2048, // 1854 + 434
};

const FONT_ALIASES = new Map<string, PdfFontKey>(Object.entries({
  calibri: 'Carlito', carlito: 'Carlito',
  cambria: 'Caladea', caladea: 'Caladea',
  arial: 'LiberationSans', helvetica: 'LiberationSans', 'sans-serif': 'LiberationSans', 'liberation sans': 'LiberationSans',
  liberationsans: 'LiberationSans', 'arial mt': 'LiberationSans',
  // the only serif face shipped; closer to a serif request than a sans
  serif: 'Caladea', 'times new roman': 'Caladea', times: 'Caladea', 'liberation serif': 'Caladea',
}) as Array<[string, PdfFontKey]>);

const normFamily = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();

/**
 * pdfmake font key for a layout font family (case-insensitive): Calibri → Carlito, Cambria → Caladea,
 * Arial / Helvetica / sans-serif → LiberationSans, the substitutes map to themselves. An unknown family tries
 * `fallback` in order (a CSS-style list or names; pass the layout's default family here), finally Carlito.
 */
export function pdfFontKey(family: string | undefined, fallback?: string | readonly string[]): PdfFontKey {
  const list = typeof fallback === 'string' ? fallback.split(',') : fallback ?? [];
  for (const name of [family ?? '', ...list]) {
    const k = FONT_ALIASES.get(normFamily(name));
    if (k) return k;
  }
  return 'Carlito';
}

// ---------------------------------------------------------------------------------------------
// Minimal pdfmake definition types (only what this writer produces)

// deno-lint-ignore no-explicit-any
export type PdfNode = { [key: string]: any };
export interface PdfPageBreakNode {
  headlineLevel?: number;
  pageNumbers: number[];
  startPosition?: { top: number; pageNumber: number };
}
export interface PdfPageBreakContext {
  getFollowingNodesOnPage(): PdfPageBreakNode[];
  getPreviousNodesOnPage(): PdfPageBreakNode[];
}
export interface PdfDocDefinition {
  pageSize: { width: number; height: number };
  pageOrientation: 'portrait' | 'landscape';
  /** [left, top, right, bottom] in pt. */
  pageMargins: [number, number, number, number];
  info: { title: string; creator?: string; producer?: string; creationDate?: Date };
  defaultStyle: { font: PdfFontKey; fontSize: number; color: string; lineHeight: number };
  /** name → data URL; every image node refers to one of these by name. */
  images: Record<string, string>;
  content: PdfNode[];
  header?: (currentPage: number, pageCount: number) => PdfNode | null;
  footer?: (currentPage: number, pageCount: number) => PdfNode | null;
  pageBreakBefore?: (node: PdfPageBreakNode, ctx: PdfPageBreakContext) => boolean;
}

export interface PdfmakeOptions {
  creator?: string;
  producer?: string;
  /** Creation date in the PDF info (tests pass a fixed date). */
  now?: Date;
}

// ---------------------------------------------------------------------------------------------

const PT_PER_MM = 72 / 25.4;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const pt = (mm: number) => r2(mm * PT_PER_MM);
const DASH = { dash: { length: 3, space: 2 } };
const PLACEHOLDER_BORDER = 0.75; // CSS 1px
const NO_LINES = {
  hLineWidth: () => 0, vLineWidth: () => 0,
  paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
};

type Scope = 'body' | 'cell' | 'band'; // band = header / footer

interface W {
  font: PdfFontKey;
  size: number;
  lineHeight: number;
  imageKeys: Map<Uint8Array, string>;
  images: Record<string, string>;
  /** Nodes whose vertical margins collapse with their siblings' (CSS block margins). */
  collapsible: WeakSet<PdfNode>;
  groups: WeakSet<PdfNode>;
  /** Tallest block (pt) that may be kept on one page; pdfmake drops what does not fit an unbreakable block. */
  keepMax: number;
  page: { current: number; count: number } | null;
  headings: number;
}

const lh = (w: W, line: number, key: PdfFontKey) => r4(line / REPORT_FONT_EM_HEIGHT[key]);

function imageKey(w: W, img: ResolvedImage): string {
  let k = w.imageKeys.get(img.bytes);
  if (!k) {
    k = `img${w.imageKeys.size + 1}`;
    w.imageKeys.set(img.bytes, k);
    w.images[k] = `data:${sniffImage(img.bytes) ?? img.mime};base64,${toBase64(img.bytes)}`;
  }
  return k;
}

function runNode(w: W, r: RRun, line: number): PdfNode {
  let text = r.field ? String(w.page ? (r.field === 'page' ? w.page.current : w.page.count) : 1) : r.text;
  if (r.caps) text = text.toUpperCase();
  text = text.replace(/\t/g, '    ');
  const key = r.font ? pdfFontKey(r.font, [w.font]) : w.font;
  const n: PdfNode = { text, lineHeight: lh(w, line, key) };
  if (r.font) n.font = key;
  if (r.size_pt) n.fontSize = r.size_pt;
  if (r.color) n.color = r.color;
  if (r.bold !== undefined) n.bold = r.bold;
  if (r.italic !== undefined) n.italics = r.italic;
  if (r.underline) n.decoration = 'underline';
  return n;
}

function paragraphNode(w: W, p: RParagraph, scope: Scope): PdfNode {
  const line = p.line_height ?? w.lineHeight;
  const runs = p.runs.map((r) => runNode(w, r, line));
  if (runs.length === 0) runs.push({ text: ' ', lineHeight: lh(w, line, w.font) });
  const indent = p.indent_mm ? pt(p.indent_mm) : 0;
  let inner: PdfNode;
  if (indent && p.marker) {
    // the marker hangs in the indent (html: padding-left + negative text-indent + inline-block marker)
    inner = {
      columns: [
        { width: indent, text: p.marker, lineHeight: lh(w, line, w.font), preserveLeadingSpaces: true },
        { width: '*', text: runs, alignment: p.align, preserveLeadingSpaces: true },
      ],
      columnGap: 0,
    };
  } else {
    inner = { text: runs, alignment: p.align, preserveLeadingSpaces: true };
  }
  let outer: PdfNode;
  if (p.background) {
    // a block background spans the whole width (html <p> background), not only the text
    if (indent && !p.marker) inner.margin = [indent, 0, 0, 0];
    outer = { table: { widths: ['*'], body: [[{ ...inner, fillColor: p.background }]] }, layout: NO_LINES };
    outer.margin = [0, p.space_before_pt, 0, p.space_after_pt];
  } else {
    outer = inner;
    outer.margin = [indent && !p.marker ? indent : 0, p.space_before_pt, 0, p.space_after_pt];
  }
  if (p.keep_with_next && scope === 'body') {
    outer.headlineLevel = 1;
    w.headings++;
  }
  w.collapsible.add(outer);
  return outer;
}

function placeholderNode(w: W, text: string, width: number, height: number, align: string): PdfNode {
  const pad = pt(2);
  const b = PLACEHOLDER_BORDER;
  return {
    table: {
      widths: [Math.max(1, r2(width - 2 * pad - 2 * b))],
      heights: [Math.max(1, r2(height - 2 * pad - 2 * b))],
      body: [[{ text, fontSize: 8, color: '#666666', alignment: 'center', verticalAlignment: 'middle', lineHeight: lh(w, w.lineHeight, w.font) }]],
      dontBreakRows: true, // a fixed-height row must never be split (see tableNode)
    },
    layout: {
      hLineWidth: () => b, vLineWidth: () => b, hLineColor: () => '#888888', vLineColor: () => '#888888',
      hLineStyle: () => DASH, vLineStyle: () => DASH,
      paddingLeft: () => pad, paddingRight: () => pad, paddingTop: () => pad, paddingBottom: () => pad,
    },
    tableAlignment: align,
  };
}

function imageNode(w: W, r: RImage, avail: number): PdfNode {
  let width = pt(r.width_mm);
  let height = pt(r.height_mm);
  if (width > avail + 0.01 && avail > 0) { // padding / borders taken in pt: never overflow the cell
    height = r2((height * avail) / width);
    width = r2(avail);
  }
  if (!r.image) return placeholderNode(w, r.missing_text ?? 'Image not available', width, height, r.align);
  return { image: imageKey(w, r.image), width, height, alignment: r.align };
}

function cellNode(w: W, c: RCell, avail: number): PdfNode {
  const blocks = blocksNodes(w, c.blocks, avail, 'cell');
  const n: PdfNode = blocks.length ? { stack: blocks } : { text: '' };
  if (c.colspan > 1) n.colSpan = c.colspan;
  if (c.rowspan > 1) n.rowSpan = c.rowspan;
  if (c.background) n.fillColor = c.background;
  if (c.valign !== 'top') n.verticalAlignment = c.valign;
  if (c.no_border) n.border = [false, false, false, false];
  return n;
}

function tableNode(w: W, t: RTable, scope: Scope): PdfNode | null {
  if (t.rows.length === 0) return null;
  const n = t.columns_mm.length;
  const lw = t.border ? t.border.width_pt : 0;
  const px = pt(t.padding_x_mm);
  const py = pt(t.padding_y_mm);
  // pdfmake column = padding left + right + left line + content width
  const widths = t.columns_mm.map((c) => Math.max(1, r2(pt(c) - 2 * px - lw)));
  const covered = new Array<number>(n).fill(0); // rows still covered by a rowspan from above, per column
  const body: PdfNode[][] = [];
  const heights: Array<number | 'auto'> = [];
  for (const row of t.rows) {
    const out: PdfNode[] = [];
    let col = 0;
    let i = 0;
    while (col < n) {
      if (covered[col] > 0) { out.push({}); covered[col]--; col++; continue; }
      const c = row.cells[i++];
      if (!c) { out.push({}); col++; continue; } // bind and validate keep rows complete; never emit a short row
      const span = Math.max(1, Math.min(c.colspan, n - col));
      const inner = widths.slice(col, col + span).reduce((s, x) => s + x, 0) + (span - 1) * (2 * px + lw);
      out.push(cellNode(w, c, inner));
      for (let k = 1; k < span; k++) out.push({});
      if (c.rowspan > 1) for (let k = col; k < col + span; k++) covered[k] = c.rowspan - 1;
      col += span;
    }
    body.push(out);
    heights.push(row.height_mm ? Math.max(0, r2(pt(row.height_mm) - 2 * py - lw)) : 'auto');
  }
  let headerRows = 0;
  while (headerRows < t.rows.length && t.rows[headerRows].header) headerRows++;
  const table: PdfNode = { widths, body };
  if (headerRows > 0 && headerRows < t.rows.length) table.headerRows = headerRows;
  const rest = t.rows.slice(headerRows);
  const fixed = heights.some((h) => h !== 'auto');
  if (scope === 'band') {
    if (fixed) table.heights = heights; // header / footer: one unbreakable box, never split
  } else {
    // pdfmake drops what does not fit an unbreakable row, so rows are kept whole only when each surely fits a page
    const fits = t.rows.every((r) => Math.max(r.height_mm ? pt(r.height_mm) : 0, rowEstimate(w, t, r.cells)) <= w.keepMax);
    const keepRows = rest.length > 0 && rest.every((r) => r.keep_together);
    // pdfmake 0.3.13 corrupts the rest of the page when a row with a fixed height is split at a page end
    // (content on one page, the height again on the next, later tables' lines drawn to the page bottom):
    // minimum row heights are only given to tables whose rows are kept whole, otherwise they are dropped.
    if (fits && (keepRows || fixed)) {
      table.dontBreakRows = true;
      if (fixed) table.heights = heights;
    }
  }
  const color = t.border?.color ?? '#000000';
  const style = t.border?.style === 'dashed' ? () => DASH : () => null;
  const node: PdfNode = {
    table,
    layout: {
      hLineWidth: () => lw, vLineWidth: () => lw, hLineColor: () => color, vLineColor: () => color,
      hLineStyle: style, vLineStyle: style,
      paddingLeft: () => px, paddingRight: () => px, paddingTop: () => py, paddingBottom: () => py,
    },
    margin: [0, 0, 0, t.space_after_pt],
  };
  w.collapsible.add(node);
  return node;
}

function blockNode(w: W, b: RBlock, avail: number, scope: Scope): PdfNode | null {
  switch (b.kind) {
    case 'paragraph': return paragraphNode(w, b, scope);
    case 'image': return imageNode(w, b, avail);
    case 'table': return tableNode(w, b, scope);
    case 'group': {
      const inner = blocksNodes(w, b.blocks, avail, scope);
      if (inner.length === 0) return null;
      const node: PdfNode = { stack: inner };
      // only outside tables: an unbreakable block inside a table cell is not supported by pdfmake
      if (b.keep_together && scope === 'body' && blocksEstimate(w, b.blocks, avail) <= w.keepMax) node.unbreakable = true;
      w.groups.add(node);
      return node;
    }
    case 'spacer': return { text: '', margin: [0, pt(b.height_mm), 0, 0] };
    case 'rule': {
      const node: PdfNode = {
        canvas: [{ type: 'line', x1: 0, y1: r2(b.width_pt / 2), x2: r2(avail), y2: r2(b.width_pt / 2), lineWidth: b.width_pt, lineColor: b.color }],
        margin: [0, 2, 0, r2(2 + b.width_pt / 2)],
      };
      w.collapsible.add(node);
      return node;
    }
    case 'page_break': return null; // handled by blocksNodes
  }
}

// CSS margins of adjacent blocks collapse (gap = the larger one), also through a group's <div>; pdfmake adds them.
function leading(w: W, n: PdfNode): PdfNode | null {
  if (w.groups.has(n)) return n.stack.length ? leading(w, n.stack[0]) : null;
  return w.collapsible.has(n) ? n : null;
}
function trailing(w: W, n: PdfNode): PdfNode | null {
  if (w.groups.has(n)) return n.stack.length ? trailing(w, n.stack[n.stack.length - 1]) : null;
  return w.collapsible.has(n) ? n : null;
}
function collapse(w: W, prev: PdfNode, cur: PdfNode): void {
  const a = trailing(w, prev);
  const b = leading(w, cur);
  if (!a || !b) return;
  const c = Math.min(a.margin[3], b.margin[1]);
  if (c > 0) b.margin = [b.margin[0], r2(b.margin[1] - c), b.margin[2], b.margin[3]];
}

function blocksNodes(w: W, blocks: RBlock[], avail: number, scope: Scope): PdfNode[] {
  const out: PdfNode[] = [];
  let breakNext = false;
  for (const b of blocks) {
    if (b.kind === 'page_break') { if (out.length) breakNext = true; continue; } // leading / repeated breaks: one page
    const node = blockNode(w, b, avail, scope);
    if (!node) continue;
    if (breakNext) { node.pageBreak = 'before'; breakNext = false; }
    else if (out.length) collapse(w, out[out.length - 1], node);
    out.push(node);
  }
  return out;
}

// ---- height estimate (pt), deliberately high: only blocks that surely fit a page are made unbreakable

function paragraphEstimate(w: W, p: RParagraph, avail: number): number {
  const size = Math.max(w.size, ...p.runs.map((r) => r.size_pt ?? 0));
  const width = Math.max(10, avail - (p.indent_mm ? pt(p.indent_mm) : 0));
  const perLine = Math.max(1, Math.floor((width / (size * 0.6)) * 0.9));
  const text = p.runs.map((r) => (r.field ? '999' : r.text)).join('');
  const lines = text.split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return lines * size * (p.line_height ?? w.lineHeight) * 1.1 + p.space_before_pt + p.space_after_pt;
}

function rowEstimate(w: W, t: RTable, cells: RCell[]): number {
  const lw = t.border ? t.border.width_pt : 0;
  const px = pt(t.padding_x_mm);
  let h = 0;
  for (const c of cells) h = Math.max(h, blocksEstimate(w, c.blocks, pt(c.width_mm) - 2 * px - lw));
  return h + 2 * pt(t.padding_y_mm) + lw;
}

function blockEstimate(w: W, b: RBlock, avail: number): number {
  switch (b.kind) {
    case 'paragraph': return paragraphEstimate(w, b, avail);
    case 'image': return pt(b.height_mm);
    case 'table': {
      let h = b.space_after_pt + (b.border ? b.border.width_pt : 0);
      for (const r of b.rows) h += Math.max(r.height_mm ? pt(r.height_mm) : 0, rowEstimate(w, b, r.cells));
      return h;
    }
    case 'group': return blocksEstimate(w, b.blocks, avail);
    case 'spacer': return pt(b.height_mm);
    case 'rule': return 4 + b.width_pt;
    case 'page_break': return Infinity;
  }
}

function blocksEstimate(w: W, blocks: RBlock[], avail: number): number {
  return blocks.reduce((s, b) => s + blockEstimate(w, b, avail), 0);
}

// ---------------------------------------------------------------------------------------------

/** pdfmake document definition from a resolved document. Images are data URLs in `images`, sizes in pt. */
export function pdfmakeFromDocument(doc: ResolvedDocument, opts: PdfmakeOptions = {}): PdfDocDefinition {
  const p = doc.page;
  const margins: [number, number, number, number] = [pt(p.margin_mm.left), pt(p.margin_mm.top), pt(p.margin_mm.right), pt(p.margin_mm.bottom)];
  const pageW = pt(p.width_mm);
  const pageH = pt(p.height_mm);
  const font = pdfFontKey(doc.font.family, doc.font.fallback);
  const w: W = {
    font, size: doc.font.size_pt, lineHeight: doc.font.line_height,
    imageKeys: new Map(), images: {}, collapsible: new WeakSet(), groups: new WeakSet(),
    keepMax: (pageH - margins[1] - margins[3]) * 0.95, page: null, headings: 0,
  };
  const avail = r2(pageW - margins[0] - margins[2]);
  const content = blocksNodes(w, doc.body, avail, 'body');

  const band = (blocks: RBlock[], where: 'header' | 'footer') => {
    if (blocks.length === 0) return undefined;
    const build = (current: number, count: number): PdfNode => {
      w.page = { current, count };
      try {
        const nodes = blocksNodes(w, blocks, avail, 'band');
        if (where === 'header') return { stack: nodes, margin: [margins[0], pt(p.header_mm), margins[2], 0] };
        // footer: bottom-aligned, footer_mm above the page edge (html: flex-end box as tall as the margin)
        const h = Math.max(1, r2(margins[3] - pt(p.footer_mm) - 1));
        return {
          table: { widths: [avail], heights: [h], body: [[{ stack: nodes, verticalAlignment: 'bottom' }]] },
          layout: NO_LINES, margin: [margins[0], 0, margins[2], 0],
        };
      } finally {
        w.page = null;
      }
    };
    build(1, 1); // registers the band's images before pdfmake reads `images`
    return build;
  };
  const header = band(doc.header, 'header');
  const footer = band(doc.footer, 'footer');

  const info: PdfDocDefinition['info'] = { title: doc.title };
  if (opts.creator) info.creator = opts.creator;
  if (opts.producer) info.producer = opts.producer;
  if (opts.now) info.creationDate = opts.now;
  const def: PdfDocDefinition = {
    pageSize: { width: pageW, height: pageH },
    pageOrientation: pageW > pageH ? 'landscape' : 'portrait',
    pageMargins: margins,
    info,
    defaultStyle: { font, fontSize: doc.font.size_pt, color: doc.font.color, lineHeight: lh(w, doc.font.line_height, font) },
    images: w.images,
    content,
  };
  if (header) def.header = header;
  if (footer) def.footer = footer;
  if (w.headings > 0) {
    // headings stay with the next block: a heading with nothing after it on its page moves to the next page
    const top = margins[1] - 1;
    const bottom = pageH - margins[3];
    const inBody = (n: PdfPageBreakNode) => !!n.startPosition && n.startPosition.top >= top && n.startPosition.top < bottom;
    def.pageBreakBefore = (node, ctx) => node.headlineLevel === 1 && node.pageNumbers.length === 1 &&
      !ctx.getFollowingNodesOnPage().some(inBody);
  }
  return def;
}

// ---- fonts a definition needs (the browser fetches only these files)

export type PdfFontUse = Partial<Record<PdfFontKey, PdfFontVariant[]>>;

/** Font keys and variants the definition's text uses (header and footer included), sorted. */
export function pdfFontsUsed(def: PdfDocDefinition): PdfFontUse {
  const used = new Map<PdfFontKey, Set<PdfFontVariant>>();
  const add = (font: PdfFontKey, bold: boolean, italics: boolean) => {
    const v: PdfFontVariant = bold ? (italics ? 'bolditalics' : 'bold') : italics ? 'italics' : 'normal';
    if (!used.has(font)) used.set(font, new Set());
    used.get(font)!.add(v);
  };
  interface Inh { font: PdfFontKey; bold: boolean; italics: boolean }
  const walk = (n: unknown, inh: Inh): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') { add(inh.font, inh.bold, inh.italics); return; }
    if (Array.isArray(n)) { for (const x of n) walk(x, inh); return; }
    if (typeof n !== 'object') return;
    const o = n as PdfNode;
    const s: Inh = {
      font: (o.font as PdfFontKey) ?? inh.font,
      bold: typeof o.bold === 'boolean' ? o.bold : inh.bold,
      italics: typeof o.italics === 'boolean' ? o.italics : inh.italics,
    };
    if (o.text !== undefined) {
      if (typeof o.text === 'string' || typeof o.text === 'number') add(s.font, s.bold, s.italics);
      else walk(o.text, s);
    }
    if (o.stack) walk(o.stack, s);
    if (o.columns) walk(o.columns, s);
    if (o.table) walk(o.table.body, s);
  };
  const base: Inh = { font: def.defaultStyle.font, bold: false, italics: false };
  add(base.font, false, false);
  walk(def.content, base);
  if (def.header) walk(def.header(1, 1), base);
  if (def.footer) walk(def.footer(1, 1), base);
  const out: PdfFontUse = {};
  const order: PdfFontVariant[] = ['normal', 'bold', 'italics', 'bolditalics'];
  for (const k of [...used.keys()].sort()) out[k] = order.filter((v) => used.get(k)!.has(v));
  return out;
}

/** The font keys of `pdfFontsUsed`. */
export function pdfFontKeysUsed(def: PdfDocDefinition): PdfFontKey[] {
  return Object.keys(pdfFontsUsed(def)) as PdfFontKey[];
}

/** pdfmake font descriptors for the used variants only; `source` maps a file name to a URL, path or vfs name. */
export function pdfmakeFonts(used: PdfFontUse, source: (file: string) => string): Record<string, Partial<Record<PdfFontVariant, string>>> {
  const out: Record<string, Partial<Record<PdfFontVariant, string>>> = {};
  for (const [k, variants] of Object.entries(used) as Array<[PdfFontKey, PdfFontVariant[]]>) {
    out[k] = {};
    for (const v of variants) out[k][v] = source(REPORT_FONT_FILES[k][v]);
  }
  return out;
}

export interface ReportPdfDefinition {
  definition: PdfDocDefinition;
  fonts: PdfFontUse;
  warnings: string[];
}

/** Layout + data → pdfmake definition, the fonts it needs and the binding warnings. Throws LayoutError. */
export function renderReportPdfDefinition(layout: ReportLayout, data: ReportData, opts: PdfmakeOptions & { title?: string } = {}): ReportPdfDefinition {
  const doc = bindReport(layout, data, { title: opts.title });
  const definition = pdfmakeFromDocument(doc, opts);
  return { definition, fonts: pdfFontsUsed(definition), warnings: doc.warnings };
}
