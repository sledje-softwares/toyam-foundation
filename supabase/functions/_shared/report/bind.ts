// Layout + case data → resolved document model shared by the HTML and Word writers (D51).
// Pure: every placeholder, condition, style, list split and image size is decided here; the writers only print.
// Values are inserted once and never parsed again, so text typed into a field cannot inject placeholders.
import type {
  Align, Block, BorderSpec, Cell, CellObject, Condition, FieldType, Formatter, ImageBlock, ListBlock, PhotosBlock,
  ReportLayout, Row, Run, SplitMode, StyleRef, TableBlock, TableStyle, TextStyle, VAlign,
} from './spec.ts';
import { parseTemplate } from './spec.ts';
import { formatDate, groupIndian, parseDateish, parseMulti, splitItems, titleCase, yesNo } from './format.ts';
import { fromBase64, type ImageMime, imageSize, sniffImage } from './image.ts';
import { validateLayout } from './validate.ts';

// ---------------------------------------------------------------------------------------------
// Input (the report-generate function maps prepare_report_version() + photo bytes onto this)

export interface CaseFacts {
  case_ref: string;
  insurer_code?: string | null;
  insurer_name?: string | null;
  claim_no?: string | null;
  policy_no?: string | null;
  template_key?: string | null;
  template_name?: string | null;
  template_version?: number | string | null;
  office_owner_name?: string | null;
  /** Timestamps (ISO / Postgres text); shown in India time. */
  received_at?: string | null;
  due_at?: string | null;
  generated_at?: string | null;
  report_version?: number | string | null;
}

export interface ReportFieldValue {
  type: FieldType | string;
  label: string;
  /** As stored in case_field_values: boolean `Yes`/`No`, multi_choice a JSON array of strings, date `yyyy-mm-dd`. */
  value: string | null;
}

export interface ReportImage {
  bytes: Uint8Array;
  mime: ImageMime;
  /** Pixel size; read from the header when absent. */
  width?: number;
  height?: number;
}

export interface ReportPhoto {
  evidence_id?: string;
  caption?: string | null;
  /** null = the derivative could not be fetched; a placeholder box is drawn instead. */
  image: ReportImage | null;
}

export interface ReportData {
  case: CaseFacts;
  /** By template field key. */
  fields: Record<string, ReportFieldValue>;
  /** By template section key, in display order. */
  photos?: Record<string, ReportPhoto[]>;
  /** Run-time assets (`assets.<name>: {runtime: true}` in the layout); also override embedded ones. */
  assets?: Record<string, ReportImage>;
}

/** Field map from the `sections` of prepare_report_version(). */
export function fieldsFromSections(
  sections: Array<{ fields: Array<{ key: string; label: string; type: string; value: unknown }> }>,
): Record<string, ReportFieldValue> {
  const out: Record<string, ReportFieldValue> = {};
  for (const s of sections) {
    for (const f of s.fields) {
      const v = f.value;
      out[f.key] = {
        type: f.type, label: f.label,
        value: v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v),
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Resolved model (output)

export interface RunStyle {
  font?: string;
  size_pt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  caps?: boolean;
}
export interface RRun extends RunStyle {
  /** May contain `\n` (line break) and `\t`. */
  text: string;
  /** Page number fields (header / footer only); `text` is then empty. */
  field?: 'page' | 'pages';
}
export interface RParagraph {
  kind: 'paragraph';
  runs: RRun[];
  align: Align;
  space_before_pt: number;
  space_after_pt: number;
  line_height?: number;
  /** Left indent; with `marker` the marker hangs in this indent. */
  indent_mm?: number;
  marker?: string;
  background?: string;
  heading?: 1 | 2 | 3;
  keep_with_next?: boolean;
}
export interface ResolvedImage {
  bytes: Uint8Array;
  mime: ImageMime;
  width: number;
  height: number;
}
export interface RImage {
  kind: 'image';
  /** null → dashed placeholder box of the same size with `missing_text`. */
  image: ResolvedImage | null;
  width_mm: number;
  height_mm: number;
  align: 'left' | 'center' | 'right';
  missing_text?: string;
}
export interface RBorder {
  width_pt: number;
  color: string;
  style: 'solid' | 'dashed';
}
export interface RCell {
  blocks: RBlock[];
  colspan: number;
  rowspan: number;
  /** Width of the cell (all spanned columns) in mm, padding included. */
  width_mm: number;
  background?: string;
  valign: VAlign;
  no_border?: boolean;
}
export interface RRow {
  cells: RCell[];
  header: boolean;
  keep_together: boolean;
  height_mm?: number;
}
export interface RTable {
  kind: 'table';
  width_mm: number;
  columns_mm: number[];
  border: RBorder | null;
  padding_x_mm: number;
  padding_y_mm: number;
  rows: RRow[];
  space_after_pt: number;
}
export interface RGroup {
  kind: 'group';
  blocks: RBlock[];
  keep_together: boolean;
}
export interface RSpacer { kind: 'spacer'; height_mm: number }
export interface RRule { kind: 'rule'; color: string; width_pt: number }
export interface RPageBreak { kind: 'page_break' }
export type RBlock = RParagraph | RImage | RTable | RGroup | RSpacer | RRule | RPageBreak;

export interface ResolvedDocument {
  title: string;
  page: {
    width_mm: number;
    height_mm: number;
    margin_mm: { top: number; right: number; bottom: number; left: number };
    header_mm: number;
    footer_mm: number;
  };
  font: { family: string; fallback: string; size_pt: number; color: string; line_height: number };
  header: RBlock[];
  footer: RBlock[];
  body: RBlock[];
  /** Non-fatal problems (unknown field at run time, unreadable photo…), for logs. */
  warnings: string[];
}

export class LayoutError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Invalid report layout: ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ''}`);
    this.name = 'LayoutError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------------------------

const PAGE_SIZES: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
const PAGE_MARK = '';
const PAGES_MARK = '';
// control characters (except tab / newline) and our two sentinels never survive into the output
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DEFAULT_BORDER: RBorder = { width_pt: 0.5, color: '#000000', style: 'solid' };

interface Ctx {
  layout: ReportLayout;
  data: ReportData;
  warnings: string[];
  warned: Set<string>;
  assets: Map<string, ResolvedImage | null>;
  item?: { text: string; index: number };
  header: boolean;
  gap: number;
}

function warn(c: Ctx, msg: string): void {
  if (c.warned.has(msg)) return;
  c.warned.add(msg);
  c.warnings.push(msg);
}

const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(STRIP_RE, '');

// ---- styles

function merge(...styles: Array<TextStyle | undefined>): TextStyle {
  const out: Record<string, unknown> = {};
  for (const s of styles) {
    if (!s) continue;
    for (const [k, v] of Object.entries(s)) if (v !== undefined && k !== 'use') out[k] = v;
  }
  return out as TextStyle;
}

function style(c: Ctx, ref: StyleRef | undefined, depth = 0): TextStyle {
  if (ref === undefined || depth > 16) return {};
  if (typeof ref === 'string') return style(c, c.layout.styles?.[ref], depth + 1);
  return merge(ref.use ? style(c, ref.use, depth + 1) : undefined, ref);
}

function tableStyle(c: Ctx, ref: string | TableStyle | undefined, depth = 0): TableStyle {
  if (ref === undefined || depth > 16) return {};
  const t = typeof ref === 'string' ? c.layout.table_styles?.[ref] : ref;
  if (!t) return {};
  const base = t.use ? tableStyle(c, t.use, depth + 1) : {};
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(t)) if (v !== undefined && k !== 'use') out[k] = v;
  return out as TableStyle;
}

function runStyle(s: TextStyle): RunStyle {
  const r: RunStyle = {};
  if (s.font !== undefined) r.font = s.font;
  if (s.size_pt !== undefined) r.size_pt = s.size_pt;
  if (s.color !== undefined) r.color = s.color;
  if (s.bold !== undefined) r.bold = s.bold;
  if (s.italic !== undefined) r.italic = s.italic;
  if (s.underline !== undefined) r.underline = s.underline;
  if (s.caps !== undefined) r.caps = s.caps;
  return r;
}

// ---- values and placeholders

function isFilled(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const s = raw.trim();
  return s !== '' && s !== '[]';
}

const TYPED = new Set(['date', 'join', 'number', 'currency']);

function defaultFormat(c: Ctx, raw: string, type: string): string {
  if (raw.trim() === '') return '';
  if (type === 'date' || type === 'datetime') {
    const p = parseDateish(raw);
    if (!p) return raw;
    return formatDate(p, p.hh === null || type === 'date'
      ? c.layout.date_format ?? 'dd.MM.yyyy'
      : c.layout.datetime_format ?? 'dd.MM.yyyy hh:mm a');
  }
  if (type === 'multi_choice') return parseMulti(raw)?.join(', ') ?? raw;
  if (type === 'currency') return groupIndian(raw);
  return raw;
}

function applyFormatters(c: Ctx, raw: string, type: string, fmts: Formatter[]): { text: string; defaulted: boolean } {
  let v = raw;
  let typed = false;
  let defaulted = false;
  const ensureDefault = () => { if (!typed) { v = defaultFormat(c, v, type); typed = true; } };
  for (const f of fmts) {
    const arg = f.args[0];
    if (TYPED.has(f.name) && !typed) {
      typed = true;
      if (f.name === 'date') {
        const p = parseDateish(v);
        if (p) {
          v = formatDate(p, arg ?? (p.hh === null || type === 'date'
            ? c.layout.date_format ?? 'dd.MM.yyyy'
            : c.layout.datetime_format ?? 'dd.MM.yyyy hh:mm a'));
        }
      } else if (f.name === 'join') v = parseMulti(v)?.join(arg ?? ', ') ?? v;
      else if (f.name === 'number') v = groupIndian(v);
      else if (f.name === 'currency') v = v.trim() === '' ? '' : `${arg ?? '₹ '}${groupIndian(v)}`;
      continue;
    }
    ensureDefault();
    switch (f.name) {
      case 'upper': v = v.toUpperCase(); break;
      case 'lower': v = v.toLowerCase(); break;
      case 'title': v = titleCase(v); break;
      case 'yesno': v = yesNo(v, arg); break;
      case 'default': if (v.trim() === '') { v = arg ?? ''; defaulted = true; } break;
      case 'prefix': if (v.trim() !== '') v = `${arg}${v}`; break;
      case 'suffix': if (v.trim() !== '') v = `${v}${arg}`; break;
      case 'first_line': v = v.split('\n')[0] ?? ''; break;
      case 'rest_lines': v = v.split('\n').slice(1).join('\n').replace(/^\s*\n/, ''); break;
      default: break; // typed formatter after the value was already formatted: ignored
    }
  }
  ensureDefault();
  return { text: v, defaulted };
}

/** Resolves placeholders; page fields become sentinel characters (header / footer only). */
function resolve(c: Ctx, template: string): string {
  const { parts } = parseTemplate(template);
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') { out += clean(p); continue; }
    let raw = '';
    let type = 'text';
    switch (p.ns) {
      case 'page': out += c.header ? PAGE_MARK : ''; continue;
      case 'pages': out += c.header ? PAGES_MARK : ''; continue;
      case 'index': raw = c.item ? String(c.item.index) : ''; break;
      case 'item': raw = c.item?.text ?? ''; break;
      case 'case': {
        const v = (c.data.case as unknown as Record<string, unknown>)[p.key];
        raw = v === null || v === undefined ? '' : String(v);
        if (p.key.endsWith('_at')) type = 'datetime';
        break;
      }
      case 'field': {
        const f = c.data.fields[p.key];
        if (!f) warn(c, `field "${p.key}" is not in the case data`);
        raw = f?.value ?? '';
        type = f?.type ?? 'text';
        break;
      }
    }
    const r = applyFormatters(c, clean(raw), type, p.formatters);
    out += r.text.trim() === '' && !r.defaulted ? clean(c.layout.empty_value ?? '') : r.text;
  }
  return out;
}

function test(c: Ctx, cond: Condition | undefined): boolean {
  if (!cond) return true;
  if ('all' in cond) return cond.all.every((x) => test(c, x));
  if ('any' in cond) return cond.any.some((x) => test(c, x));
  if ('not' in cond) return !test(c, cond.not);
  if ('photos' in cond) return (c.data.photos?.[cond.photos]?.length ?? 0) > 0;
  const raw = c.data.fields[cond.field]?.value ?? null;
  const v = (raw ?? '').trim().toLowerCase();
  if (cond.equals !== undefined) return v === cond.equals.trim().toLowerCase();
  if (cond.not_equals !== undefined) return v !== cond.not_equals.trim().toLowerCase();
  if (cond.in !== undefined) return cond.in.some((x) => x.trim().toLowerCase() === v);
  return isFilled(raw) === (cond.filled ?? true);
}

// ---- text → paragraphs

function toRuns(text: string, rs: RunStyle, markup: boolean): RRun[] {
  const runs: RRun[] = [];
  const push = (t: string, bold: boolean) => {
    const parts = t.split(/([])/);
    for (const part of parts) {
      if (part === '') continue;
      const base: RunStyle = bold ? { ...rs, bold: true } : { ...rs };
      if (part === PAGE_MARK) runs.push({ ...base, text: '', field: 'page' });
      else if (part === PAGES_MARK) runs.push({ ...base, text: '', field: 'pages' });
      else runs.push({ ...base, text: part });
    }
  };
  if (!markup) { push(text, false); return runs; }
  const pieces = text.split('**');
  const pairs = pieces.length - 1 - ((pieces.length - 1) % 2); // unmatched last ** stays literal
  pieces.forEach((piece, i) => {
    if (i > pairs) { push(`**${piece}`, false); return; }
    push(piece, i % 2 === 1);
  });
  return runs;
}

function paragraphProps(s: TextStyle, inCell: boolean): Omit<RParagraph, 'kind' | 'runs'> {
  const p: Omit<RParagraph, 'kind' | 'runs'> = {
    align: s.align ?? 'left',
    space_before_pt: s.space_before_pt ?? 0,
    space_after_pt: s.space_after_pt ?? 0,
  };
  if (s.line_height !== undefined) p.line_height = s.line_height;
  if (s.indent_mm !== undefined) p.indent_mm = s.indent_mm;
  if (s.background !== undefined && !inCell) p.background = s.background;
  return p;
}

/** Splits resolved text into paragraphs at blank lines; single line breaks stay inside a paragraph. */
function paragraphs(c: Ctx, text: string, s: TextStyle, markup: boolean, inCell: boolean): RParagraph[] {
  const body = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  if (body === '') return [];
  const chunks = body.split(/\n[ \t]*(?:\n[ \t]*)+/);
  const props = paragraphProps(s, inCell);
  const rs = runStyle(s);
  return chunks.map((chunk, i) => ({
    kind: 'paragraph' as const,
    runs: toRuns(chunk, rs, markup),
    ...props,
    space_after_pt: i < chunks.length - 1 ? Math.max(props.space_after_pt, c.gap) : props.space_after_pt,
  }));
}

function runsParagraph(c: Ctx, runs: Run[], s: TextStyle, inCell: boolean): RParagraph[] {
  const out: RRun[] = [];
  for (const r of runs) {
    const t = resolve(c, r.text);
    if (t === '') continue;
    out.push(...toRuns(t, runStyle(merge(s, style(c, r.style))), false));
  }
  if (out.length === 0) return [];
  return [{ kind: 'paragraph', runs: out, ...paragraphProps(s, inCell) }];
}

function listParagraphs(c: Ctx, items: string[], b: ListBlock, s: TextStyle, inCell: boolean): RParagraph[] {
  const indent = b.indent_mm ?? 6;
  const start = b.start ?? 1;
  const out: RParagraph[] = [];
  items.forEach((item, i) => {
    const ps = paragraphs(c, item, s, b.markup === true, inCell);
    ps.forEach((p, j) => {
      p.indent_mm = (p.indent_mm ?? 0) + indent;
      if (j === 0) p.marker = b.ordered ? `${start + i}.` : '•';
      if (j === ps.length - 1 && i < items.length - 1) p.space_after_pt = Math.max(p.space_after_pt, 2);
      out.push(p);
    });
  });
  return out;
}

// ---- images

function resolvedImage(c: Ctx, img: ReportImage | null | undefined, what: string): ResolvedImage | null {
  if (!img || !(img.bytes instanceof Uint8Array) || img.bytes.length === 0) return null;
  const mime = sniffImage(img.bytes);
  if (!mime) { warn(c, `${what} is not a JPEG or PNG`); return null; }
  const size = img.width && img.height ? { width: img.width, height: img.height } : imageSize(img.bytes);
  if (!size) { warn(c, `${what}: size unreadable`); return null; }
  return { bytes: img.bytes, mime, width: size.width, height: size.height };
}

function asset(c: Ctx, name: string): ResolvedImage | null {
  if (c.assets.has(name)) return c.assets.get(name)!;
  let img: ResolvedImage | null = null;
  const runtime = c.data.assets?.[name];
  const spec = c.layout.assets?.[name];
  if (runtime) img = resolvedImage(c, runtime, `asset ${name}`);
  else if (spec && 'data_base64' in spec) {
    img = resolvedImage(c, { bytes: fromBase64(spec.data_base64), mime: spec.mime, width: spec.width, height: spec.height }, `asset ${name}`);
  } else warn(c, `asset "${name}" was not supplied`);
  c.assets.set(name, img);
  return img;
}

function fit(img: ResolvedImage | null, maxW: number, opts: { width?: number; height?: number; maxH?: number; fill?: boolean }): { w: number; h: number } {
  const ratio = img ? img.height / img.width : 0.75;
  let w: number;
  let h: number;
  if (opts.width !== undefined && opts.height !== undefined) { w = opts.width; h = opts.height; }
  else if (opts.width !== undefined) { w = opts.width; h = w * ratio; }
  else if (opts.height !== undefined) { h = opts.height; w = h / ratio; }
  else if (opts.fill || !img) { w = maxW; h = w * ratio; }
  else { w = Math.min(maxW, (img.width * 25.4) / 96); h = w * ratio; }
  if (w > maxW) { h = (h * maxW) / w; w = maxW; }
  if (opts.maxH !== undefined && h > opts.maxH) { w = (w * opts.maxH) / h; h = opts.maxH; }
  return { w: Math.max(1, round2(w)), h: Math.max(1, round2(h)) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function imageBlock(c: Ctx, b: ImageBlock, avail: number): RImage {
  const img = asset(c, b.asset);
  const { w, h } = fit(img, avail, { width: b.width_mm, height: b.height_mm, maxH: b.max_height_mm });
  return { kind: 'image', image: img, width_mm: w, height_mm: h, align: b.align ?? 'left', ...(img ? {} : { missing_text: 'Image not available' }) };
}

function photosBlock(c: Ctx, b: PhotosBlock, avail: number, base: TextStyle, inCell: boolean): RBlock[] {
  let photos = c.data.photos?.[b.section] ?? [];
  if (b.limit !== undefined) photos = photos.slice(0, b.limit);
  if (photos.length === 0) return b.empty_text ? paragraphs(c, resolve(c, b.empty_text), base, false, inCell) : [];
  const n = b.columns ?? 2;
  const gap = b.gap_mm ?? 3;
  const colW = avail / n;
  const inner = Math.max(5, colW - gap);
  const capStyle = merge({ italic: true, align: 'center', size_pt: Math.max(6, (c.layout.font.size_pt ?? 10) - 1) }, style(c, b.caption_style));
  const rows: RRow[] = [];
  for (let i = 0; i < photos.length; i += n) {
    const cells: RCell[] = [];
    for (let j = 0; j < n; j++) {
      const ph = photos[i + j];
      const blocks: RBlock[] = [];
      if (ph) {
        const img = resolvedImage(c, ph.image, `photo ${ph.evidence_id ?? i + j + 1} of section ${b.section}`);
        const caption = clean(ph.caption ?? '').trim();
        const { w, h } = fit(img, inner, { fill: true, maxH: b.max_height_mm ?? (img ? undefined : inner * 0.75) });
        blocks.push({
          kind: 'image', image: img, width_mm: w, height_mm: img ? h : Math.min(h, inner * 0.75), align: 'center',
          ...(img ? {} : { missing_text: caption ? `Photo not available: ${caption}` : 'Photo not available' }),
        });
        if (b.captions && caption) {
          blocks.push({ kind: 'paragraph', runs: toRuns(caption, runStyle(capStyle), false), ...paragraphProps(capStyle, true), space_before_pt: 2 });
        }
      }
      cells.push({ blocks, colspan: 1, rowspan: 1, width_mm: colW, valign: 'top' });
    }
    rows.push({ cells, header: false, keep_together: true });
  }
  const border = b.border === undefined || b.border === 'none' ? null : rBorder(b.border);
  return [{
    kind: 'table', width_mm: avail, columns_mm: new Array(n).fill(colW), border,
    padding_x_mm: gap / 2, padding_y_mm: gap / 2, rows, space_after_pt: 0,
  }];
}

const rBorder = (b: BorderSpec): RBorder => ({ width_pt: b.width_pt, color: b.color, style: b.style ?? 'solid' });

// ---- tables

interface CellPlan {
  spec: CellObject;
  colspan: number;
  rowspan: number;
  role: 'cell' | 'label' | 'value' | 'heading';
  text?: string; // overrides spec text (field rows)
  extraStyle?: StyleRef;
  markup?: boolean;
}

const asCell = (x: Cell): CellObject => (typeof x === 'string' ? { text: x } : x);

function tableBlock(c: Ctx, t: TableBlock, avail: number): RTable {
  const ts = tableStyle(c, t.style);
  const n = t.columns.length;
  const width = round2((avail * (t.width_pct ?? 100)) / 100);
  const total = t.columns.reduce((s, x) => s + x, 0);
  const cols = t.columns.map((x) => (width * x) / total);
  const border = ts.border === 'none' ? null : ts.border ? rBorder(ts.border) : DEFAULT_BORDER;
  const padX = ts.padding_x_mm ?? 1.5;
  const padY = ts.padding_y_mm ?? 0.5;
  const occ = new Array<number>(n).fill(0);
  const rows: RRow[] = [];

  const emit = (plans: CellPlan[], row: Partial<RRow>) => {
    const cells: RCell[] = [];
    let col = 0;
    for (const p of plans) {
      while (col < n && occ[col] > 0) col++;
      const span = Math.min(p.colspan, n - col);
      const w = cols.slice(col, col + span).reduce((s, x) => s + x, 0);
      cells.push(bindCell(c, p, ts, w, padX, span));
      if (p.rowspan > 1) for (let k = col; k < col + span; k++) occ[k] = p.rowspan; // decremented below
      col += span;
    }
    for (let k = 0; k < n; k++) if (occ[k] > 0) occ[k]--;
    rows.push({ cells, header: row.header ?? false, keep_together: row.keep_together ?? false, ...(row.height_mm ? { height_mm: row.height_mm } : {}) });
  };

  for (const r of t.rows as Row[]) {
    if (!test(c, r.when)) continue;
    if ('heading' in r) {
      emit([{ spec: { text: r.heading }, colspan: n, rowspan: 1, role: 'heading', extraStyle: r.style }], { header: r.header });
    } else if ('field' in r) {
      const ls = r.label_span && r.label_span < n ? r.label_span : 1;
      const label = r.label ?? c.data.fields[r.field]?.label ?? r.field;
      emit([
        { spec: { text: label }, colspan: ls, rowspan: 1, role: 'label', extraStyle: r.label_style },
        { spec: { text: r.value ?? `{{field.${r.field}}}` }, colspan: n - ls, rowspan: 1, role: 'value', extraStyle: r.value_style, markup: r.markup },
      ], {});
    } else if ('repeat' in r) {
      const raw = c.data.fields[r.repeat.field]?.value ?? '';
      const items = splitItems(clean(raw), r.repeat.split as SplitMode | undefined);
      if (items.length === 0 && r.empty) emit(r.empty.map((x) => plan(asCell(x))), {});
      items.forEach((text, i) => {
        c.item = { text, index: i + 1 };
        emit(r.cells.map((x) => plan(asCell(x))), {});
        c.item = undefined;
      });
    } else {
      emit(r.cells.map((x) => plan(asCell(x))), { header: r.header, keep_together: r.keep_together, height_mm: r.height_mm });
    }
  }
  return { kind: 'table', width_mm: width, columns_mm: cols.map(round2), border, padding_x_mm: padX, padding_y_mm: padY, rows, space_after_pt: ts.space_after_pt ?? 6 };
}

function plan(spec: CellObject): CellPlan {
  return { spec, colspan: spec.colspan ?? 1, rowspan: spec.rowspan ?? 1, role: 'cell', markup: spec.markup };
}

function bindCell(c: Ctx, p: CellPlan, ts: TableStyle, width: number, padX: number, span: number): RCell {
  const roleStyle = p.role === 'label' ? style(c, ts.label_style)
    : p.role === 'value' ? style(c, ts.value_style)
    : p.role === 'heading' ? merge({ bold: true, align: 'center' }, style(c, ts.heading_style))
    : {};
  const s = merge(style(c, ts.cell_style), roleStyle, style(c, p.extraStyle), style(c, p.spec.style));
  const inner = Math.max(1, width - 2 * padX);
  let blocks: RBlock[] = [];
  if (p.spec.text !== undefined) blocks = paragraphs(c, resolve(c, p.spec.text), s, p.markup === true, true);
  else if (p.spec.runs !== undefined) blocks = runsParagraph(c, p.spec.runs, s, true);
  else if (p.spec.blocks !== undefined) blocks = bindBlocks(c, p.spec.blocks, inner, s, true);
  const background = p.spec.background ?? s.background;
  return {
    blocks, colspan: span, rowspan: p.rowspan, width_mm: round2(width), valign: p.spec.valign ?? 'top',
    ...(background ? { background } : {}), ...(p.spec.border === 'none' ? { no_border: true } : {}),
  };
}

// ---- blocks

function headingStyle(c: Ctx, level: number): TextStyle {
  const size = c.layout.font.size_pt;
  return merge(
    { bold: true, size_pt: size + (level === 1 ? 4 : level === 2 ? 2 : 1), space_before_pt: 6, space_after_pt: 4 },
    style(c, c.layout.styles?.[`heading${level}`] ? `heading${level}` : undefined),
  );
}

function bindBlocks(c: Ctx, blocks: Block[], avail: number, base: TextStyle, inCell: boolean): RBlock[] {
  const out: RBlock[] = [];
  for (const b of blocks) {
    if (!test(c, b.when)) continue;
    switch (b.type) {
      case 'paragraph': {
        const s = merge(base, style(c, b.style));
        if (b.runs) out.push(...runsParagraph(c, b.runs, s, inCell));
        else out.push(...paragraphs(c, resolve(c, b.text ?? ''), s, b.markup === true, inCell));
        break;
      }
      case 'heading': {
        const level = b.level ?? 1;
        const s = merge(base, headingStyle(c, level), style(c, b.style));
        for (const p of paragraphs(c, resolve(c, b.text), s, false, inCell)) out.push({ ...p, heading: level, keep_with_next: true });
        break;
      }
      case 'list': {
        const s = merge(base, style(c, b.style));
        let items: string[];
        if (b.field !== undefined) {
          const f = c.data.fields[b.field];
          if (!f) warn(c, `field "${b.field}" is not in the case data`);
          items = splitItems(clean(f?.value ?? ''), b.split);
        } else items = (b.items ?? []).map((x) => resolve(c, x)).filter((x) => x.trim() !== '');
        if (items.length === 0) {
          if (b.empty_text) out.push(...paragraphs(c, resolve(c, b.empty_text), s, false, inCell));
        } else out.push(...listParagraphs(c, items, b, s, inCell));
        break;
      }
      case 'table': out.push(tableBlock(c, b, avail)); break;
      case 'image': out.push(imageBlock(c, b, avail)); break;
      case 'photos': out.push(...photosBlock(c, b, avail, base, inCell)); break;
      case 'spacer': out.push({ kind: 'spacer', height_mm: b.height_mm }); break;
      case 'rule': out.push({ kind: 'rule', color: b.color ?? '#000000', width_pt: b.width_pt ?? 0.75 }); break;
      case 'page_break': out.push({ kind: 'page_break' }); break;
      case 'group': {
        const inner = bindBlocks(c, b.blocks, avail, base, inCell);
        if (inner.length) out.push({ kind: 'group', blocks: inner, keep_together: b.keep_together ?? false });
        break;
      }
    }
  }
  return out;
}

/** Binds a layout to case data. Throws LayoutError when the layout is invalid. */
export function bindReport(layout: ReportLayout, data: ReportData, opts: { title?: string } = {}): ResolvedDocument {
  const issues = validateLayout(layout);
  if (issues.length) throw new LayoutError(issues);
  const [w0, h0] = PAGE_SIZES[layout.page.size];
  const landscape = layout.page.orientation === 'landscape';
  const page = {
    width_mm: landscape ? h0 : w0,
    height_mm: landscape ? w0 : h0,
    margin_mm: { ...layout.page.margin_mm },
    header_mm: layout.page.header_mm ?? Math.min(10, layout.page.margin_mm.top / 2),
    footer_mm: layout.page.footer_mm ?? Math.min(10, layout.page.margin_mm.bottom / 2),
  };
  const avail = page.width_mm - page.margin_mm.left - page.margin_mm.right;
  const c: Ctx = {
    layout, data, warnings: [], warned: new Set(), assets: new Map(), header: false, gap: layout.paragraph_spacing_pt ?? 6,
  };
  const body = bindBlocks(c, layout.body, avail, {}, false);
  c.header = true;
  const header = bindBlocks(c, layout.header ?? [], avail, {}, false);
  const footer = bindBlocks(c, layout.footer ?? [], avail, {}, false);
  const title = clean(opts.title ?? [layout.name, data.case.case_ref].filter(Boolean).join(' — ')).trim() || 'Report';
  return {
    title,
    page,
    font: {
      family: layout.font.family,
      fallback: layout.font.fallback ?? 'sans-serif',
      size_pt: layout.font.size_pt,
      color: layout.font.color ?? '#000000',
      line_height: layout.font.line_height ?? 1.15,
    },
    header, footer, body, warnings: c.warnings,
  };
}
