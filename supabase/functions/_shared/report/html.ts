// Resolved document → HTML for the PDF renderer (Cloudflare Browser Rendering `/pdf`, Chrome print) and for the
// web preview. Every value is escaped; images are inlined as data: URIs and a CSP forbids any fetch, so rendering
// never leaves the document. Pure; no imports beyond the model.
import type { ReportData } from './bind.ts';
import { bindReport, type RBlock, type RBorder, type RCell, type ResolvedDocument, type RImage, type RParagraph, type RRun, type RTable } from './bind.ts';
import type { ReportLayout } from './spec.ts';
import { toBase64 } from './image.ts';

export const REPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** Chrome / Puppeteer `page.pdf()` options, as accepted by Browser Rendering's `pdfOptions`. */
export interface PdfOptions {
  width: string;
  height: string;
  margin: { top: string; right: string; bottom: string; left: string };
  printBackground: true;
  preferCSSPageSize: false;
  displayHeaderFooter: boolean;
  headerTemplate: string;
  footerTemplate: string;
}

export interface ReportHtml {
  /** Complete document (doctype, CSP, styles, body). */
  html: string;
  headerTemplate: string;
  footerTemplate: string;
  pdfOptions: PdfOptions;
  warnings: string[];
}

type Mode = 'pdf' | 'preview';

const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeHtml(s: string): string {
  return s.replace(CTRL_RE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const n2 = (x: number) => String(Math.round(x * 100) / 100);
const attr = (css: string[]) => (css.length ? ` style="${escapeHtml(css.join(';'))}"` : '');

function fontStack(family: string, fallback: string): string {
  const names = [family, ...fallback.split(',')].map((s) => s.trim()).filter(Boolean);
  return names.map((n) => (['serif', 'sans-serif', 'monospace'].includes(n) ? n : `'${n.replace(/[^A-Za-z0-9 -]/g, '')}'`)).join(', ');
}

interface W {
  mode: Mode;
  inTemplate: boolean;
  fallback: string;
}

function runHtml(w: W, r: RRun): string {
  const css: string[] = [];
  if (r.font) css.push(`font-family:${fontStack(r.font, w.fallback)}`);
  if (r.size_pt) css.push(`font-size:${n2(r.size_pt)}pt`);
  if (r.color) css.push(`color:${r.color}`);
  if (r.bold !== undefined) css.push(`font-weight:${r.bold ? 'bold' : 'normal'}`);
  if (r.italic !== undefined) css.push(`font-style:${r.italic ? 'italic' : 'normal'}`);
  if (r.underline) css.push('text-decoration:underline');
  if (r.caps) css.push('text-transform:uppercase');
  let inner: string;
  if (r.field) {
    inner = w.mode === 'pdf' && w.inTemplate
      ? `<span class="${r.field === 'page' ? 'pageNumber' : 'totalPages'}"></span>`
      : '1'; // preview: no pagination
  } else {
    inner = escapeHtml(r.text).replace(/\n/g, '<br>');
  }
  return css.length ? `<span${attr(css)}>${inner}</span>` : inner;
}

function paragraphHtml(w: W, p: RParagraph): string {
  const css = [`margin:${n2(p.space_before_pt)}pt 0 ${n2(p.space_after_pt)}pt 0`, `text-align:${p.align}`];
  if (p.line_height) css.push(`line-height:${n2(p.line_height)}`);
  if (p.background) css.push(`background:${p.background}`);
  if (p.keep_with_next) css.push('break-after:avoid');
  const body = p.runs.map((r) => runHtml(w, r)).join('') || '&#8203;';
  if (p.indent_mm) {
    css.push(`padding-left:${n2(p.indent_mm)}mm`);
    if (p.marker) {
      css.push(`text-indent:-${n2(p.indent_mm)}mm`);
      const m = `<span style="display:inline-block;width:${n2(p.indent_mm)}mm;text-indent:0">${escapeHtml(p.marker)}</span>`;
      return `<p${attr(css)}>${m}${body}</p>`;
    }
  }
  return `<p${attr(css)}>${body}</p>`;
}

function imageHtml(r: RImage): string {
  const box = [`width:${n2(r.width_mm)}mm`, `height:${n2(r.height_mm)}mm`];
  const wrap = `text-align:${r.align};margin:0`;
  if (!r.image) {
    const css = [...box, 'display:inline-flex', 'align-items:center', 'justify-content:center', 'box-sizing:border-box',
      'border:1px dashed #888888', 'color:#666666', 'font-size:8pt', 'text-align:center', 'padding:2mm', 'overflow:hidden'];
    return `<div style="${wrap}"><div${attr(css)}>${escapeHtml(r.missing_text ?? 'Image not available')}</div></div>`;
  }
  const src = `data:${r.image.mime};base64,${toBase64(r.image.bytes)}`;
  return `<div style="${wrap}"><img alt="" src="${src}"${attr([...box, 'display:inline-block', 'vertical-align:top'])}></div>`;
}

const borderCss = (b: RBorder | null) => (b ? `${n2(b.width_pt)}pt ${b.style} ${b.color}` : 'none');

function cellHtml(w: W, t: RTable, c: RCell, header: boolean): string {
  const tag = header ? 'th' : 'td';
  const css = [
    `border:${c.no_border ? 'none' : borderCss(t.border)}`,
    `padding:${n2(t.padding_y_mm)}mm ${n2(t.padding_x_mm)}mm`,
    `vertical-align:${c.valign}`,
    'font-weight:inherit', 'text-align:left',
  ];
  if (c.background) css.push(`background:${c.background}`);
  const spans = `${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}`;
  return `<${tag}${spans}${attr(css)}>${blocksHtml(w, c.blocks)}</${tag}>`;
}

function tableHtml(w: W, t: RTable): string {
  const cols = t.columns_mm.map((x) => `<col style="width:${n2(x)}mm">`).join('');
  const head: string[] = [];
  const body: string[] = [];
  for (const r of t.rows) {
    const css: string[] = [];
    if (r.keep_together) css.push('break-inside:avoid');
    if (r.height_mm) css.push(`height:${n2(r.height_mm)}mm`);
    const tr = `<tr${attr(css)}>${r.cells.map((c) => cellHtml(w, t, c, r.header)).join('')}</tr>`;
    (r.header ? head : body).push(tr);
  }
  const css = [`width:${n2(t.width_mm)}mm`, 'border-collapse:collapse', 'table-layout:fixed', `margin:0 0 ${n2(t.space_after_pt)}pt 0`];
  return `<table${attr(css)}><colgroup>${cols}</colgroup>${head.length ? `<thead>${head.join('')}</thead>` : ''}<tbody>${body.join('')}</tbody></table>`;
}

function blockHtml(w: W, b: RBlock): string {
  switch (b.kind) {
    case 'paragraph': return paragraphHtml(w, b);
    case 'image': return imageHtml(b);
    case 'table': return tableHtml(w, b);
    case 'group': return `<div${b.keep_together ? ' style="break-inside:avoid"' : ''}>${blocksHtml(w, b.blocks)}</div>`;
    case 'spacer': return `<div style="height:${n2(b.height_mm)}mm"></div>`;
    case 'rule': return `<div style="border-top:${n2(b.width_pt)}pt solid ${b.color};margin:2pt 0;height:0"></div>`;
    case 'page_break': return w.mode === 'pdf' ? '<div style="break-after:page"></div>' : '<hr class="page-break">';
  }
}

function blocksHtml(w: W, blocks: RBlock[]): string {
  return blocks.map((b) => blockHtml(w, b)).join('');
}

function baseCss(doc: ResolvedDocument): string {
  const f = doc.font;
  return [
    `font-family:${fontStack(f.family, f.fallback)}`, `font-size:${n2(f.size_pt)}pt`, `color:${f.color}`,
    `line-height:${n2(f.line_height)}`, '-webkit-print-color-adjust:exact', 'print-color-adjust:exact',
  ].join(';');
}

function template(doc: ResolvedDocument, blocks: RBlock[], where: 'header' | 'footer'): string {
  if (blocks.length === 0) return '<span></span>';
  const p = doc.page;
  const w: W = { mode: 'pdf', inTemplate: true, fallback: doc.font.fallback };
  // Chrome renders each template in a box as tall as the page margin; place the content header_mm / footer_mm
  // from the page edge and inside the left / right margins.
  const height = where === 'header' ? p.margin_mm.top : p.margin_mm.bottom;
  const css = [
    'width:100%', `height:${n2(height)}mm`, 'box-sizing:border-box', 'display:flex', 'flex-direction:column',
    `justify-content:${where === 'header' ? 'flex-start' : 'flex-end'}`,
    where === 'header'
      ? `padding:${n2(p.header_mm)}mm ${n2(p.margin_mm.right)}mm 0 ${n2(p.margin_mm.left)}mm`
      : `padding:0 ${n2(p.margin_mm.right)}mm ${n2(p.footer_mm)}mm ${n2(p.margin_mm.left)}mm`,
    baseCss(doc), 'overflow:hidden',
  ];
  return `<style>p{margin:0;white-space:pre-wrap}table{border-collapse:collapse}</style><div style="${escapeHtml(css.join(';'))}"><div>${blocksHtml(w, blocks)}</div></div>`;
}

/** HTML from a resolved document. `preview` lays out one page-wide sheet with the header and footer inline. */
export function htmlFromDocument(doc: ResolvedDocument, mode: Mode = 'pdf'): ReportHtml {
  const w: W = { mode, inTemplate: false, fallback: doc.font.fallback };
  const p = doc.page;
  const body = blocksHtml(w, doc.body);
  const css = [
    `html{${baseCss(doc)}}`,
    'body{margin:0}',
    'p{margin:0;white-space:pre-wrap;overflow-wrap:break-word}',
    'table{border-collapse:collapse;table-layout:fixed}',
    'thead{display:table-header-group}',
    'img{border:0}',
  ];
  let content: string;
  if (mode === 'preview') {
    const wp: W = { mode, inTemplate: false, fallback: doc.font.fallback };
    css.push(
      'body{background:#e5e5e5;padding:16px 0}',
      `.sheet{background:#ffffff;width:${n2(p.width_mm)}mm;min-height:${n2(p.height_mm)}mm;margin:0 auto;box-sizing:border-box;` +
        `padding:${n2(p.header_mm)}mm ${n2(p.margin_mm.right)}mm ${n2(p.footer_mm)}mm ${n2(p.margin_mm.left)}mm;` +
        'box-shadow:0 1px 4px rgba(0,0,0,.2);display:flex;flex-direction:column}',
      '.sheet>.main{flex:1;padding:4mm 0}',
      'hr.page-break{border:0;border-top:1px dashed #999999;margin:6mm 0}',
      '@media (max-width:860px){.sheet{width:auto;min-height:0;margin:0 8px}}',
    );
    content = `<div class="sheet"><div class="hdr">${blocksHtml(wp, doc.header)}</div><div class="main">${body}</div>` +
      `<div class="ftr">${blocksHtml(wp, doc.footer)}</div></div>`;
  } else {
    content = body;
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(doc.title)}</title><style>${css.join('\n')}</style></head><body>${content}</body></html>`;
  const headerTemplate = template(doc, doc.header, 'header');
  const footerTemplate = template(doc, doc.footer, 'footer');
  return {
    html,
    headerTemplate,
    footerTemplate,
    pdfOptions: {
      width: `${n2(p.width_mm)}mm`,
      height: `${n2(p.height_mm)}mm`,
      margin: {
        top: `${n2(p.margin_mm.top)}mm`, right: `${n2(p.margin_mm.right)}mm`,
        bottom: `${n2(p.margin_mm.bottom)}mm`, left: `${n2(p.margin_mm.left)}mm`,
      },
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: doc.header.length > 0 || doc.footer.length > 0,
      headerTemplate,
      footerTemplate,
    },
    warnings: doc.warnings,
  };
}

/** Layout + data → HTML and PDF options. Throws LayoutError for an invalid layout. */
export function renderReportHtml(layout: ReportLayout, data: ReportData, opts: { mode?: Mode; title?: string } = {}): ReportHtml {
  return htmlFromDocument(bindReport(layout, data, { title: opts.title }), opts.mode ?? 'pdf');
}
