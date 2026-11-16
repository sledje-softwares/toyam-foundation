// Report layout spec (D51): one structured layout per case template, stored in
// public.case_templates.report_layout (jsonb) and written by config/templates/layouts/*.yaml.
// Pure types and the placeholder parser; no imports, runs in Deno and in Node (type stripping).
// Format reference: docs/13-report-layouts.md.

export const LAYOUT_VERSION = 1;

export type Align = 'left' | 'center' | 'right' | 'justify';
export type VAlign = 'top' | 'middle' | 'bottom';
export type FieldType =
  | 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'datetime' | 'choice' | 'multi_choice' | 'boolean';

/** Text and paragraph style. Colours are `#RRGGBB`. `use` extends a named style from `layout.styles`. */
export interface TextStyle {
  use?: string;
  font?: string;
  size_pt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  caps?: boolean;
  align?: Align;
  /** Paragraph shading; on a cell style it shades the cell. */
  background?: string;
  space_before_pt?: number;
  space_after_pt?: number;
  /** Multiple of the font size, e.g. 1.15. */
  line_height?: number;
  indent_mm?: number;
}
/** A named style (key of `layout.styles`) or an inline style. */
export type StyleRef = string | TextStyle;

export interface BorderSpec {
  width_pt: number;
  color: string;
  style?: 'solid' | 'dashed';
}

export interface TableStyle {
  use?: string;
  /** Grid lines of the table (outer and inner); `none` for a borderless table. */
  border?: BorderSpec | 'none';
  padding_x_mm?: number;
  padding_y_mm?: number;
  /** Default style of every cell. */
  cell_style?: StyleRef;
  /** Label cell of `field` rows. */
  label_style?: StyleRef;
  /** Value cell of `field` rows. */
  value_style?: StyleRef;
  /** `heading` rows. */
  heading_style?: StyleRef;
  /** Gap after the table. */
  space_after_pt?: number;
}

export interface PageSpec {
  size: 'A4' | 'Letter' | 'Legal';
  orientation?: 'portrait' | 'landscape';
  margin_mm: { top: number; right: number; bottom: number; left: number };
  /** Distance from the top edge to the header (Word "header from top"). */
  header_mm?: number;
  /** Distance from the bottom edge to the footer. */
  footer_mm?: number;
}

export interface FontSpec {
  /** Primary family, also used by Word (e.g. `Calibri`). */
  family: string;
  /** CSS fallbacks for the PDF renderer, comma separated (e.g. `Carlito, Arial, sans-serif`). */
  fallback?: string;
  size_pt: number;
  color?: string;
  line_height?: number;
}

/** An image the layout itself carries (letterhead, logo). In YAML `{file: assets/x.png}`; the loader embeds it. */
export interface EmbeddedAsset {
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  data_base64: string;
}
/** An image the generator supplies at run time (`ReportData.assets[name]`), e.g. a seal kept out of git. */
export interface RuntimeAsset {
  runtime: true;
  description?: string;
}
export type AssetSpec = EmbeddedAsset | RuntimeAsset;

/** Show the block / row only when the condition holds. Exactly one test per object. */
export type Condition =
  | { field: string; filled?: boolean; equals?: string; not_equals?: string; in?: string[] }
  | { photos: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

/**
 * How a value becomes list items or repeated rows.
 * - `auto`: items start at lines beginning with `1.` `1)` `•` `-` `*` (markers stripped; following lines stay in
 *   the item); without markers every non-empty line is an item.
 * - `lines`: every non-empty line. `paragraphs`: blocks separated by blank lines. `sections`: blocks separated by a
 *   line of `---`.
 * multi_choice values (JSON arrays) always give one item per element.
 */
export type SplitMode = 'auto' | 'lines' | 'paragraphs' | 'sections';

interface BlockBase {
  when?: Condition;
}

export interface Run {
  text: string;
  style?: StyleRef;
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  /** Text with placeholders; blank lines start new paragraphs, single line breaks stay line breaks. */
  text?: string;
  /** Differently styled pieces of one paragraph (no paragraph breaks). */
  runs?: Run[];
  style?: StyleRef;
  /** `**bold**` inside the resolved text (values included) becomes bold. */
  markup?: boolean;
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  text: string;
  level?: 1 | 2 | 3;
  style?: StyleRef;
}

export interface ListBlock extends BlockBase {
  type: 'list';
  /** Items from a field value (split by `split`; multi_choice by element). */
  field?: string;
  /** Static items with placeholders; empty results are dropped. */
  items?: string[];
  split?: SplitMode;
  ordered?: boolean;
  start?: number;
  style?: StyleRef;
  indent_mm?: number;
  /** Shown as a plain paragraph when there are no items (default: nothing). */
  empty_text?: string;
  markup?: boolean;
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  asset: string;
  width_mm?: number;
  height_mm?: number;
  max_height_mm?: number;
  align?: 'left' | 'center' | 'right';
}

export interface PhotosBlock extends BlockBase {
  type: 'photos';
  /** Template section key; the photos selected for that section, in order. */
  section: string;
  columns?: number;
  max_height_mm?: number;
  gap_mm?: number;
  captions?: boolean;
  caption_style?: StyleRef;
  limit?: number;
  border?: BorderSpec | 'none';
  /** Shown when the section has no photos (default: nothing). */
  empty_text?: string;
}

export interface SpacerBlock extends BlockBase {
  type: 'spacer';
  height_mm: number;
}

export interface RuleBlock extends BlockBase {
  type: 'rule';
  color?: string;
  width_pt?: number;
}

export interface PageBreakBlock extends BlockBase {
  type: 'page_break';
}

export interface GroupBlock extends BlockBase {
  type: 'group';
  blocks: Block[];
  keep_together?: boolean;
}

export interface CellObject {
  text?: string;
  runs?: Run[];
  markup?: boolean;
  blocks?: Block[];
  colspan?: number;
  rowspan?: number;
  style?: StyleRef;
  valign?: VAlign;
  background?: string;
  /** Drop this cell's borders. */
  border?: 'none';
}
/** A string cell is `{text: "..."}`. */
export type Cell = string | CellObject;

export interface CellsRow {
  cells: Cell[];
  when?: Condition;
  /** Repeated at the top of every page the table spans (must be the first rows). */
  header?: boolean;
  keep_together?: boolean;
  height_mm?: number;
}
/** One cell across all columns. */
export interface HeadingRow {
  heading: string;
  style?: StyleRef;
  when?: Condition;
  header?: boolean;
}
/** Label cell (template label unless `label` is given) and a value cell across the remaining columns. */
export interface FieldRow {
  field: string;
  label?: string;
  /** Value text with placeholders instead of `{{field.<field>}}`, e.g. with formatters. */
  value?: string;
  label_style?: StyleRef;
  value_style?: StyleRef;
  label_span?: number;
  when?: Condition;
  markup?: boolean;
}
/** One row per item of a field value; cells may use `{{item}}` and `{{index}}`. */
export interface RepeatRow {
  repeat: { field: string; split?: SplitMode };
  cells: Cell[];
  when?: Condition;
  /** Cells of a single row shown when there are no items (default: no row). */
  empty?: Cell[];
}
export type Row = CellsRow | HeadingRow | FieldRow | RepeatRow;

export interface TableBlock extends BlockBase {
  type: 'table';
  /** Relative column widths (e.g. `[40, 60]`). */
  columns: number[];
  /** Named table style (key of `layout.table_styles`) or inline. */
  style?: string | TableStyle;
  rows: Row[];
  /** Table width as a percentage of the available width (default 100). */
  width_pct?: number;
}

export type Block =
  | ParagraphBlock | HeadingBlock | ListBlock | TableBlock | ImageBlock | PhotosBlock
  | SpacerBlock | RuleBlock | PageBreakBlock | GroupBlock;

export interface ReportLayout {
  version: 1;
  name?: string;
  page: PageSpec;
  font: FontSpec;
  /** Gap between paragraphs of one text (blank line in a value). Default 6. */
  paragraph_spacing_pt?: number;
  /** Default patterns for date and datetime values (see formatDate). */
  date_format?: string;
  datetime_format?: string;
  /** Text for an empty `{{field.x}}` without `|default:`. Default empty. */
  empty_value?: string;
  styles?: Record<string, TextStyle>;
  table_styles?: Record<string, TableStyle>;
  assets?: Record<string, AssetSpec>;
  /** Repeated on every page; may use `{{page}}` / `{{pages}}`. No photos, lists from fields or repeat rows. */
  header?: Block[];
  footer?: Block[];
  body: Block[];
}

// ---------------------------------------------------------------------------------------------
// Placeholders: {{case.claim_no}}, {{field.key|date:"dd.MM.yyyy"|default:"NA"}}, {{item}}, {{index}},
// {{page}}, {{pages}}.

/** Case facts a layout may reference as `{{case.<key>}}`; the generator fills them from prepare_report_version. */
export const CASE_KEYS = [
  'case_ref', 'insurer_code', 'insurer_name', 'claim_no', 'policy_no', 'template_key', 'template_name',
  'template_version', 'office_owner_name', 'received_at', 'due_at', 'generated_at', 'report_version',
] as const;
export type CaseKey = typeof CASE_KEYS[number];

/** Formatter name → allowed argument counts. */
export const FORMATTERS: Record<string, number[]> = {
  date: [0, 1],        // date / datetime pattern; default from the layout by field type
  upper: [0],
  lower: [0],
  title: [0],          // Title Case Each Word
  yesno: [0, 1],       // "Yes|No" → maps Yes/No/true/false
  join: [0, 1],        // multi_choice separator, default ", "
  number: [0],         // Indian digit grouping 12,34,567
  currency: [0, 1],    // prefix (default "₹ ") + Indian grouping
  default: [1],        // text when empty
  prefix: [1],         // added when not empty
  suffix: [1],
  first_line: [0],
  rest_lines: [0],
};

export interface Formatter {
  name: string;
  args: string[];
}
export interface Placeholder {
  /** `case`, `field`, `item`, `index`, `page`, `pages`. */
  ns: 'case' | 'field' | 'item' | 'index' | 'page' | 'pages';
  key: string;
  formatters: Formatter[];
  raw: string;
}
export type TemplatePart = string | Placeholder;

const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

function splitPipes(s: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted && ch === '\\' && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === '|' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (quoted) return null;
  out.push(cur);
  return out;
}

function parseFormatter(s: string): Formatter | string {
  const m = /^([a-z_]+)\s*(?::\s*(.*))?$/s.exec(s.trim());
  if (!m) return `bad formatter "${s.trim()}"`;
  const name = m[1];
  const args: string[] = [];
  if (m[2] !== undefined) {
    const a = m[2].trim();
    const q = /^"((?:[^"\\]|\\.)*)"$/s.exec(a);
    if (q) args.push(q[1].replace(/\\(.)/g, '$1'));
    else if (/^-?\d+(\.\d+)?$/.test(a)) args.push(a);
    else return `formatter ${name}: argument must be "quoted" or a number`;
  }
  return { name, args };
}

/** Parses one placeholder body (between the braces). Returns an error string when invalid. */
export function parsePlaceholder(body: string): Placeholder | string {
  const pieces = splitPipes(body);
  if (!pieces) return `unterminated quote in {{${body}}}`;
  const head = pieces[0].trim();
  let ns: Placeholder['ns'];
  let key = '';
  if (head === 'item' || head === 'index' || head === 'page' || head === 'pages') ns = head;
  else {
    const m = /^(case|field)\.([a-z0-9_]+)$/.exec(head);
    if (!m) return `unknown placeholder "${head}" (use case.<key>, field.<key>, item, index, page, pages)`;
    ns = m[1] as 'case' | 'field';
    key = m[2];
    if (!KEY_RE.test(key)) return `bad key "${key}"`;
    if (ns === 'case' && !(CASE_KEYS as readonly string[]).includes(key)) {
      return `unknown case fact "${key}" (known: ${CASE_KEYS.join(', ')})`;
    }
  }
  const formatters: Formatter[] = [];
  for (const p of pieces.slice(1)) {
    const f = parseFormatter(p);
    if (typeof f === 'string') return f;
    const arity = FORMATTERS[f.name];
    if (!arity) return `unknown formatter "${f.name}" (known: ${Object.keys(FORMATTERS).join(', ')})`;
    if (!arity.includes(f.args.length)) return `formatter ${f.name} takes ${arity.join(' or ')} argument(s)`;
    formatters.push(f);
  }
  return { ns, key, formatters, raw: body };
}

/** Splits text into literal pieces and placeholders. `errors` lists every bad placeholder. */
export function parseTemplate(text: string): { parts: TemplatePart[]; errors: string[] } {
  const parts: TemplatePart[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) { parts.push(text.slice(i)); break; }
    if (open > i) parts.push(text.slice(i, open));
    const close = text.indexOf('}}', open + 2);
    if (close < 0) { errors.push('"{{" without "}}"'); parts.push(text.slice(open)); break; }
    const body = text.slice(open + 2, close);
    const p = parsePlaceholder(body);
    if (typeof p === 'string') { errors.push(p); parts.push(''); } else parts.push(p);
    i = close + 2;
  }
  return { parts, errors };
}

// ---------------------------------------------------------------------------------------------
// A plain layout built from the template sections, used when a template has no report_layout yet.

export interface TemplateSectionInfo {
  key: string;
  title: string;
  fields: Array<{ key: string; label?: string; type?: string }>;
}

export function defaultLayout(sections: TemplateSectionInfo[], title = 'Investigation Report'): ReportLayout {
  const rows: Row[] = [];
  for (const s of sections) {
    rows.push({ heading: s.title });
    for (const f of s.fields) rows.push({ field: f.key });
    rows.push({
      when: { photos: s.key },
      cells: [{ colspan: 2, blocks: [{ type: 'photos', section: s.key, columns: 2, max_height_mm: 80, captions: true }] }],
    });
  }
  return {
    version: 1,
    page: { size: 'A4', margin_mm: { top: 20, right: 18, bottom: 20, left: 18 }, header_mm: 8, footer_mm: 8 },
    font: { family: 'Arial', fallback: 'Liberation Sans, sans-serif', size_pt: 10 },
    date_format: 'dd.MM.yyyy',
    datetime_format: "dd.MM.yyyy 'at' hh:mm a",
    table_styles: {
      grid: {
        border: { width_pt: 0.5, color: '#000000' },
        label_style: { bold: true },
        heading_style: { bold: true, align: 'center', background: '#D9D9D9' },
      },
    },
    footer: [{ type: 'paragraph', text: 'Page {{page}} of {{pages}}', style: { align: 'center', size_pt: 8 } }],
    body: [
      { type: 'heading', text: title, style: { align: 'center' } },
      { type: 'table', columns: [40, 60], style: 'grid', rows },
    ],
  };
}
