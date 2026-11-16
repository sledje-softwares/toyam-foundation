// Resolved document → Word (.docx, OOXML): real tables (spans, vertical merges, shading), header / footer parts with
// PAGE / NUMPAGES fields, images embedded as media parts (bytes as given, never re-encoded), styles and core
// properties; zipped with STORE by _shared/send/zip.ts. Pure; no npm packages.
import { buildZip, type ZipEntry } from '../send/zip.ts';
import type { ReportData } from './bind.ts';
import { bindReport, type RBlock, type RBorder, type RCell, type ResolvedDocument, type ResolvedImage, type RImage, type RParagraph, type RRun, type RTable } from './bind.ts';
import type { ReportLayout } from './spec.ts';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Characters XML 1.0 cannot carry (C0 controls except tab / LF / CR, lone surrogates, U+FFFE / U+FFFF).
const XML_INVALID = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu;

export function escapeXml(s: string): string {
  return s.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const tw = (mm: number) => Math.max(0, Math.round((mm * 1440) / 25.4)); // twentieths of a point
const emu = (mm: number) => Math.max(1, Math.round(mm * 36000));
const half = (pt: number) => Math.max(2, Math.round(pt * 2));
const hex = (c: string) => c.replace('#', '').toUpperCase();
const bsz = (pt: number) => Math.min(96, Math.max(2, Math.round(pt * 8)));

interface Part {
  rels: Array<{ id: string; type: string; target: string }>;
}
interface Doc {
  media: Map<Uint8Array, string>;
  files: ZipEntry[];
  drawingId: number;
}

function imageRel(d: Doc, part: Part, img: ResolvedImage): string {
  let target = d.media.get(img.bytes);
  if (!target) {
    target = `media/image${d.media.size + 1}.${img.mime === 'image/png' ? 'png' : 'jpg'}`;
    d.media.set(img.bytes, target);
    d.files.push({ name: `word/${target}`, data: img.bytes, deflate: false });
  }
  const existing = part.rels.find((r) => r.target === target);
  if (existing) return existing.id;
  const id = `rId${part.rels.length + 1}`;
  part.rels.push({ id, type: `${REL}/image`, target });
  return id;
}

function rPr(r: { font?: string; size_pt?: number; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; caps?: boolean }): string {
  let x = '';
  if (r.font) { const f = escapeXml(r.font); x += `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`; }
  if (r.bold !== undefined) x += r.bold ? '<w:b/><w:bCs/>' : '<w:b w:val="0"/><w:bCs w:val="0"/>';
  if (r.italic !== undefined) x += r.italic ? '<w:i/><w:iCs/>' : '<w:i w:val="0"/><w:iCs w:val="0"/>';
  if (r.caps) x += '<w:caps/>';
  if (r.color) x += `<w:color w:val="${hex(r.color)}"/>`;
  if (r.size_pt) x += `<w:sz w:val="${half(r.size_pt)}"/><w:szCs w:val="${half(r.size_pt)}"/>`;
  if (r.underline) x += '<w:u w:val="single"/>';
  return x ? `<w:rPr>${x}</w:rPr>` : '';
}

function textRun(text: string, props: string): string {
  const pieces: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) pieces.push('<w:br/>');
    line.split('\t').forEach((seg, j) => {
      if (j > 0) pieces.push('<w:tab/>');
      if (seg !== '') pieces.push(`<w:t xml:space="preserve">${escapeXml(seg)}</w:t>`);
    });
  });
  return pieces.length ? `<w:r>${props}${pieces.join('')}</w:r>` : '';
}

function runXml(r: RRun): string {
  const props = rPr(r);
  if (r.field) {
    const instr = r.field === 'page' ? 'PAGE' : 'NUMPAGES';
    return `<w:r>${props}<w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r>${props}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
      `<w:r>${props}<w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${props}<w:t>1</w:t></w:r>` +
      `<w:r>${props}<w:fldChar w:fldCharType="end"/></w:r>`;
  }
  return textRun(r.text, props);
}

const JC: Record<string, string> = { left: 'left', center: 'center', right: 'right', justify: 'both' };

/** Word stretches a justified line that ends in a manual line break; such paragraphs become one per line. */
function splitJustified(p: RParagraph): RParagraph[] {
  if (p.align !== 'justify' || !p.runs.some((r) => r.text.includes('\n'))) return [p];
  const lines: RRun[][] = [[]];
  for (const r of p.runs) {
    r.text.split('\n').forEach((t, i) => {
      if (i > 0) lines.push([]);
      if (t !== '' || r.field) lines[lines.length - 1].push({ ...r, text: t });
    });
  }
  return lines.map((runs, i) => {
    const q: RParagraph = { ...p, runs, space_before_pt: i === 0 ? p.space_before_pt : 0, space_after_pt: i === lines.length - 1 ? p.space_after_pt : 0 };
    if (i > 0) delete q.marker;
    return q;
  });
}

function paragraphXml(p: RParagraph, keepNext: boolean): string {
  const parts = splitJustified(p);
  if (parts.length > 1) return parts.map((q) => paragraphXml(q, keepNext)).join('');
  let pPr = '';
  if (p.heading) pPr += `<w:pStyle w:val="Heading${p.heading}"/>`;
  if (p.keep_with_next || keepNext) pPr += '<w:keepNext/>';
  if (p.background) pPr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(p.background)}"/>`;
  const ind = p.indent_mm ? tw(p.indent_mm) : 0;
  if (p.marker && ind) pPr += `<w:tabs><w:tab w:val="left" w:pos="${ind}"/></w:tabs>`;
  const line = p.line_height ? ` w:line="${Math.round(p.line_height * 240)}" w:lineRule="auto"` : '';
  pPr += `<w:spacing w:before="${Math.round(p.space_before_pt * 20)}" w:after="${Math.round(p.space_after_pt * 20)}"${line}/>`;
  if (ind) pPr += `<w:ind w:left="${ind}"${p.marker ? ` w:hanging="${ind}"` : ''}/>`;
  pPr += `<w:jc w:val="${JC[p.align] ?? 'left'}"/>`;
  let body = '';
  if (p.marker) {
    const first = p.runs.find((r) => !r.field) ?? {};
    body += `<w:r>${rPr(first)}<w:t xml:space="preserve">${escapeXml(p.marker)}</w:t>${ind ? '<w:tab/>' : '<w:t xml:space="preserve"> </w:t>'}</w:r>`;
  }
  body += p.runs.map(runXml).join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${body}</w:p>`;
}

/** A paragraph that only takes `pt` of height (separates tables, ends cells). */
function thinParagraph(pt: number): string {
  const line = Math.max(20, Math.round(pt * 20));
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/>` +
    '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';
}

function imageXml(d: Doc, part: Part, r: RImage): string {
  const jc = JC[r.align] ?? 'left';
  if (!r.image) {
    const w = tw(r.width_mm);
    const b = '<w:top w:val="dashed" w:sz="4" w:space="0" w:color="888888"/><w:left w:val="dashed" w:sz="4" w:space="0" w:color="888888"/>' +
      '<w:bottom w:val="dashed" w:sz="4" w:space="0" w:color="888888"/><w:right w:val="dashed" w:sz="4" w:space="0" w:color="888888"/>';
    const text = textRun(r.missing_text ?? 'Image not available', '<w:rPr><w:color w:val="666666"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>');
    return `<w:tbl><w:tblPr><w:tblW w:w="${w}" w:type="dxa"/><w:jc w:val="${jc === 'both' ? 'left' : jc}"/><w:tblBorders>${b}</w:tblBorders>` +
      '<w:tblLayout w:type="fixed"/></w:tblPr>' +
      `<w:tblGrid><w:gridCol w:w="${w}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(r.height_mm)}" w:hRule="exact"/></w:trPr>` +
      `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>` +
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr>${text}</w:p></w:tc></w:tr></w:tbl>` +
      thinParagraph(1);
  }
  const id = imageRel(d, part, r.image);
  const n = ++d.drawingId;
  const cx = emu(r.width_mm);
  const cy = emu(r.height_mm);
  const name = `Picture ${n}`;
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="${jc}"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${n}" name="${name}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}

function borderEl(tag: string, b: RBorder | null): string {
  return b ? `<w:${tag} w:val="${b.style === 'dashed' ? 'dashed' : 'single'}" w:sz="${bsz(b.width_pt)}" w:space="0" w:color="${hex(b.color)}"/>`
    : `<w:${tag} w:val="nil"/>`;
}

function tcXml(d: Doc, part: Part, c: RCell, merge: 'restart' | 'continue' | null): string {
  let pr = `<w:tcW w:w="${tw(c.width_mm)}" w:type="dxa"/>`;
  if (c.colspan > 1) pr += `<w:gridSpan w:val="${c.colspan}"/>`;
  if (merge === 'restart') pr += '<w:vMerge w:val="restart"/>';
  if (merge === 'continue') pr += '<w:vMerge/>';
  if (c.no_border) pr += `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map((s) => borderEl(s, null)).join('')}</w:tcBorders>`;
  if (c.background) pr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.background)}"/>`;
  pr += `<w:vAlign w:val="${c.valign === 'middle' ? 'center' : c.valign}"/>`;
  const content = merge === 'continue' ? '<w:p/>' : blocksXml(d, part, c.blocks, true);
  return `<w:tc><w:tcPr>${pr}</w:tcPr>${content}</w:tc>`;
}

function tableXml(d: Doc, part: Part, t: RTable): string {
  const n = t.columns_mm.length;
  const grid = t.columns_mm.map((x) => `<w:gridCol w:w="${tw(x)}"/>`).join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => borderEl(s, t.border)).join('');
  const px = tw(t.padding_x_mm);
  const py = tw(t.padding_y_mm);
  let x = `<w:tbl><w:tblPr><w:tblW w:w="${tw(t.width_mm)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    `<w:tblCellMar><w:top w:w="${py}" w:type="dxa"/><w:left w:w="${px}" w:type="dxa"/><w:bottom w:w="${py}" w:type="dxa"/><w:right w:w="${px}" w:type="dxa"/></w:tblCellMar>` +
    `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>`;
  // vertical merges: per start column, the cell still covering rows below
  const open: Array<{ cell: RCell; left: number } | null> = new Array(n).fill(null);
  for (const r of t.rows) {
    let trPr = '';
    if (r.keep_together) trPr += '<w:cantSplit/>';
    if (r.height_mm) trPr += `<w:trHeight w:val="${tw(r.height_mm)}" w:hRule="atLeast"/>`;
    if (r.header) trPr += '<w:tblHeader/>';
    let cells = '';
    let col = 0;
    let i = 0;
    while (col < n) {
      const o = open[col];
      if (o && o.left > 0) {
        cells += tcXml(d, part, o.cell, 'continue');
        o.left--;
        if (o.left === 0) open[col] = null;
        col += o.cell.colspan;
        continue;
      }
      const c = r.cells[i++];
      if (!c) break; // bind and validate keep rows complete; never emit a malformed row
      const merge = c.rowspan > 1 ? 'restart' : null;
      cells += tcXml(d, part, c, merge);
      if (c.rowspan > 1) open[col] = { cell: c, left: c.rowspan - 1 };
      col += c.colspan;
    }
    x += `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;
  }
  return `${x}</w:tbl>${thinParagraph(t.space_after_pt)}`;
}

function blockXml(d: Doc, part: Part, b: RBlock, keepNext: boolean): string {
  switch (b.kind) {
    case 'paragraph': return paragraphXml(b, keepNext);
    case 'image': return imageXml(d, part, b);
    case 'table': return tableXml(d, part, b);
    case 'group': {
      return b.blocks.map((x, i) => blockXml(d, part, x, keepNext || (b.keep_together && i < b.blocks.length - 1))).join('');
    }
    case 'spacer': return thinParagraph(b.height_mm * 72 / 25.4);
    case 'rule':
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="${bsz(b.width_pt)}" w:space="1" w:color="${hex(b.color)}"/></w:pBdr>` +
        '<w:spacing w:before="0" w:after="60" w:line="40" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';
    case 'page_break': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }
}

/** Blocks of a body, cell, header or footer; always ends with a paragraph (Word requires it in cells). */
function blocksXml(d: Doc, part: Part, blocks: RBlock[], inCell: boolean): string {
  const x = blocks.map((b) => blockXml(d, part, b, false)).join('');
  if (x === '') return '<w:p/>';
  return inCell && !x.endsWith('</w:p>') ? `${x}<w:p/>` : x;
}

function relsXml(rels: Part['rels']): string {
  return `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeXml(r.target)}"/>`).join('') +
    '</Relationships>';
}

function stylesXml(doc: ResolvedDocument): string {
  const f = escapeXml(doc.font.family);
  const sz = half(doc.font.size_pt);
  const headings = [1, 2, 3].map((l) =>
    `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${l - 1}"/></w:pPr></w:style>`).join('');
  return `${DECL}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/><w:color w:val="${hex(doc.font.color)}"/>` +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-IN" w:eastAsia="en-IN" w:bidi="hi-IN"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.round(doc.font.line_height * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr>' +
    '<w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    `${headings}</w:styles>`;
}

const SETTINGS = `${DECL}<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';

export interface DocxOptions {
  /** Creation time for the zip entries and core properties (tests pass a fixed date). */
  now?: Date;
  creator?: string;
}

/** Word document from a resolved document. */
export async function docxFromDocument(doc: ResolvedDocument, opts: DocxOptions = {}): Promise<Uint8Array> {
  const now = opts.now ?? new Date();
  const d: Doc = { media: new Map(), files: [], drawingId: 0 };
  const docPart: Part = { rels: [] };
  const rel = (part: Part, type: string, target: string) => {
    const id = `rId${part.rels.length + 1}`;
    part.rels.push({ id, type: `${REL}/${type}`, target });
    return id;
  };
  rel(docPart, 'styles', 'styles.xml');
  rel(docPart, 'settings', 'settings.xml');
  const parts: ZipEntry[] = [];
  const enc = new TextEncoder();
  const overrides: string[] = [];
  let sectRefs = '';
  for (const kind of ['header', 'footer'] as const) {
    const blocks = kind === 'header' ? doc.header : doc.footer;
    if (blocks.length === 0) continue;
    const part: Part = { rels: [] };
    const tag = kind === 'header' ? 'w:hdr' : 'w:ftr';
    const xml = `${DECL}<${tag} ${NS}>${blocksXml(d, part, blocks, true)}</${tag}>`;
    parts.push({ name: `word/${kind}1.xml`, data: enc.encode(xml), deflate: false });
    if (part.rels.length) parts.push({ name: `word/_rels/${kind}1.xml.rels`, data: enc.encode(relsXml(part.rels)), deflate: false });
    const id = rel(docPart, kind, `${kind}1.xml`);
    sectRefs += `<w:${kind}Reference w:type="default" r:id="${id}"/>`;
    overrides.push(`<Override PartName="/word/${kind}1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
  }
  const body = blocksXml(d, docPart, doc.body, true);
  const p = doc.page;
  const landscape = p.width_mm > p.height_mm;
  const sectPr = `<w:sectPr>${sectRefs}<w:pgSz w:w="${tw(p.width_mm)}" w:h="${tw(p.height_mm)}"${landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${tw(p.margin_mm.top)}" w:right="${tw(p.margin_mm.right)}" w:bottom="${tw(p.margin_mm.bottom)}" ` +
    `w:left="${tw(p.margin_mm.left)}" w:header="${tw(p.header_mm)}" w:footer="${tw(p.footer_mm)}" w:gutter="0"/></w:sectPr>`;
  const documentXml = `${DECL}<w:document ${NS}><w:body>${body}${sectPr}</w:body></w:document>`;

  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(doc.title)}</dc:title>${opts.creator ? `<dc:creator>${escapeXml(opts.creator)}</dc:creator>` : ''}` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    '</cp:coreProperties>';
  const contentTypes = `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    `${overrides.join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = relsXml([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
  ]);
  const files: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes), deflate: false },
    { name: '_rels/.rels', data: enc.encode(rootRels), deflate: false },
    { name: 'docProps/core.xml', data: enc.encode(core), deflate: false },
    { name: 'word/document.xml', data: enc.encode(documentXml), deflate: false },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(relsXml(docPart.rels)), deflate: false },
    { name: 'word/styles.xml', data: enc.encode(stylesXml(doc)), deflate: false },
    { name: 'word/settings.xml', data: enc.encode(SETTINGS), deflate: false },
    ...parts,
    ...d.files,
  ];
  return buildZip(files, now);
}

/** Layout + data → .docx bytes. Throws LayoutError for an invalid layout. */
export async function renderReportDocx(layout: ReportLayout, data: ReportData, opts: DocxOptions & { title?: string } = {}): Promise<Uint8Array> {
  return docxFromDocument(bindReport(layout, data, { title: opts.title }), opts);
}
