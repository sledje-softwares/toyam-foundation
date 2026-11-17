// 7.7 HTML writer: escaping and injection attempts, CSP, data: images only, Chrome header/footer templates.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ReportData } from '../../../supabase/functions/_shared/report/bind.ts';
import { escapeHtml, REPORT_CSP, renderReportHtml } from '../../../supabase/functions/_shared/report/html.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { exampleData, exampleLayout } from './report-helpers.ts';

const EVIL = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(2)>',
  "'><svg onload=alert(3)>",
  '</style><style>body{background:url(https://evil.example/x)}</style>',
  '<a href="javascript:alert(4)">x</a>',
  '<link rel=stylesheet href=https://evil.example/s.css>',
  '{{case.case_ref}}',
  '&lt;already&gt; &amp;',
  'ctl\u0000\u0007\u001b',
].join(' | ');

function evilData(): ReportData {
  const d = exampleData();
  for (const f of Object.values(d.fields)) if (f.type === 'text' || f.type === 'long_text') f.value = EVIL;
  d.case.office_owner_name = EVIL;
  d.case.insurer_name = EVIL;
  d.case.claim_no = EVIL; // printed in the header template
  d.photos!.garage[0].caption = EVIL;
  d.photos!.garage[2].caption = EVIL; // missing photo: caption in the placeholder box
  return d;
}

/** Only known tags and attributes; images only as data: URIs; no url() / @import in styles; no control characters. */
const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'p', 'span', 'br', 'div', 'table', 'colgroup', 'col',
  'thead', 'tbody', 'tr', 'td', 'th', 'img', 'hr']);
const ATTRS = new Set(['style', 'colspan', 'rowspan', 'src', 'alt', 'class', 'lang', 'charset', 'http-equiv', 'content', 'name']);
function assertInert(html: string): void {
  // escaped text never contains "<", so every "<x" is a real tag
  for (const m of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g)) {
    assert.ok(TAGS.has(m[1].toLowerCase()), `unexpected tag <${m[1]}>`);
    for (const a of m[2].matchAll(/([A-Za-z-]+)\s*=\s*"([^"]*)"/g)) {
      assert.ok(ATTRS.has(a[1].toLowerCase()), `unexpected attribute ${a[1]} on <${m[1]}>`);
      if (a[1] === 'src') assert.match(a[2], /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/);
      if (a[1] === 'style') assert.doesNotMatch(a[2], /url\(|expression\(|@import/i);
    }
    const rest = m[2].replace(/([A-Za-z-]+)\s*=\s*"[^"]*"/g, '').trim();
    assert.ok(rest === '' || rest === '/', `unquoted attribute material in <${m[1]}${m[2]}>`);
  }
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) assert.doesNotMatch(m[1], /url\(|@import/i);
  assert.doesNotMatch(html, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
}

describe('HTML writer', () => {
  it('escapes &, <, >, quotes and drops control characters', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&\u0001</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('keeps hostile values inert in the body, the attributes and both templates', () => {
    const d = evilData();
    const out = renderReportHtml(exampleLayout(), d);
    assertInert(out.html);
    assertInert(out.headerTemplate);
    assertInert(out.footerTemplate);
    assert.ok(out.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(out.html.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'));
    assert.ok(out.html.includes('&amp;lt;already&amp;gt; &amp;amp;'));
    assert.ok(out.html.includes('{{case.case_ref}}'), 'a placeholder typed into a value stays literal');
    assert.ok(out.html.includes('Photo not available: &lt;script&gt;'));
    const preview = renderReportHtml(exampleLayout(), d, { mode: 'preview' });
    assertInert(preview.html);
  });

  it('declares a CSP that forbids every fetch and inlines images as data: URIs', () => {
    const out = renderReportHtml(exampleLayout(), exampleData());
    assert.equal(REPORT_CSP, "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    assert.ok(out.html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">'));
    assert.ok(out.html.includes(`<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`));
    assert.doesNotMatch(out.html, /https?:\/\//);
    const srcs = [...out.html.matchAll(/<img alt="" src="(data:[^"]+)"/g)].map((m) => m[1]);
    assert.equal(srcs.length, 2 + 2 + 1 + 1); // garage grid 2 + garage strip 2 + seal + letterhead (missing photo is a box)
    assert.ok(srcs.every((s) => s.startsWith('data:image/jpeg;base64,') || s.startsWith('data:image/png;base64,')));
    const firstPhoto = Buffer.from(srcs[0].split(',')[1], 'base64');
    assert.deepEqual(new Uint8Array(firstPhoto), exampleData().photos!.garage[0].image!.bytes, 'image bytes are not re-encoded');
  });

  it('returns Chrome PDF options with page-number templates', () => {
    const out = renderReportHtml(exampleLayout(), exampleData());
    assert.deepEqual({ ...out.pdfOptions, headerTemplate: '', footerTemplate: '' }, {
      width: '210mm', height: '297mm', margin: { top: '32mm', right: '15mm', bottom: '18mm', left: '15mm' },
      printBackground: true, preferCSSPageSize: false, displayHeaderFooter: true, headerTemplate: '', footerTemplate: '',
    });
    assert.equal(out.pdfOptions.headerTemplate, out.headerTemplate);
    assert.match(out.footerTemplate, /Page <\/span><span style="font-size:8pt"><span class="pageNumber"><\/span><\/span>.* of .*<span class="totalPages"><\/span>/);
    assert.match(out.headerTemplate, /src="data:image\/png;base64,/);
    assert.match(out.headerTemplate, /Case INV-2099-000001/);
    assert.doesNotMatch(out.html, /pageNumber/);
  });

  it('renders tables with spans, header rows, list markers and page breaks', () => {
    const { html } = renderReportHtml(exampleLayout(), exampleData());
    assert.match(html, /<thead><tr><th colspan="3"/);
    assert.equal((html.match(/rowspan="2"/g) ?? []).length, 2);
    assert.match(html, /text-indent:-6mm"><span style="display:inline-block;width:6mm;text-indent:0">1\.<\/span>/);
    assert.match(html, /break-after:page/);
    assert.match(html, /Rs\. 12,34,567/);
    assert.match(html, /<span style="font-weight:bold">garage<\/span>/);
  });

  it('omits header and footer templates when the layout has none', () => {
    const layout: ReportLayout = { ...exampleLayout(), header: undefined, footer: undefined };
    const out = renderReportHtml(layout, exampleData());
    assert.equal(out.pdfOptions.displayHeaderFooter, false);
    assert.equal(out.headerTemplate, '<span></span>');
  });

  it('writes the example to a temporary directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-html-'));
    const out = renderReportHtml(exampleLayout(), exampleData());
    writeFileSync(join(dir, 'example.html'), out.html);
    writeFileSync(join(dir, 'preview.html'), renderReportHtml(exampleLayout(), exampleData(), { mode: 'preview' }).html);
    assert.ok(out.html.length > 5000);
  });
});
