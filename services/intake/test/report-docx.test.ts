// 7.7 Word writer: valid zip, every XML part well-formed, content types and relationships consistent, images
// embedded as given, page fields, merges, hostile values escaped. LibreOffice smoke conversion when installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { DOCX_MIME, escapeXml, renderReportDocx } from '../../../supabase/functions/_shared/report/docx.ts';
import { exampleData, exampleLayout, readZip } from './report-helpers.ts';

const NOW = new Date('2099-01-10T06:45:00Z');
const dec = new TextDecoder();
const hasPython = spawnSync('python3', ['-c', 'import xml.dom.minidom, zipfile'], { stdio: 'ignore' }).status === 0;
const soffice = ['soffice', 'libreoffice'].find((c) => spawnSync('which', [c], { stdio: 'ignore' }).status === 0);

/** Parses every .xml / .rels part with python's minidom (a real XML parser); returns the failures. */
function xmlFailures(parts: Map<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'docx-xml-'));
  for (const [name, data] of parts) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  const script = 'import os,sys,xml.dom.minidom\nbad=[]\nfor r,_,fs in os.walk(sys.argv[1]):\n' +
    '  for f in fs:\n    p=os.path.join(r,f)\n    try: xml.dom.minidom.parse(p)\n    except Exception as e: bad.append(p+": "+str(e))\nprint("\\n".join(bad))';
  return execFileSync('python3', ['-I', '-c', script, dir], { encoding: 'utf8' }).trim();
}

async function exampleDocx(mutate?: (d: ReturnType<typeof exampleData>) => void) {
  const d = exampleData();
  mutate?.(d);
  const bytes = await renderReportDocx(exampleLayout(), d, { now: NOW, creator: 'Report tests' });
  return { bytes, parts: readZip(bytes), data: d };
}

describe('Word writer', () => {
  it('escapes XML and drops characters XML cannot carry', () => {
    assert.equal(escapeXml(`<a b="c">'&'</a>`), '&lt;a b=&quot;c&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
    assert.equal(escapeXml('a\u0000b\u0008c\u000Bd￾e\uD800f\tg\nh😀'), 'abcdef\tg\nh😀');
    assert.equal(DOCX_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('is a stored zip with consistent content types and relationships', async () => {
    const { bytes, parts } = await exampleDocx();
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.equal([...parts.keys()][0], '[Content_Types].xml');
    const ct = dec.decode(parts.get('[Content_Types].xml')!);
    // every part is covered by an Override or a Default extension
    for (const name of parts.keys()) {
      if (name === '[Content_Types].xml') continue;
      const ext = name.split('.').pop()!;
      const ok = ct.includes(`PartName="/${name}"`) || ct.includes(`Default Extension="${ext}"`);
      assert.ok(ok, `no content type for ${name}`);
    }
    // every Override names an existing part
    for (const m of ct.matchAll(/PartName="\/([^"]+)"/g)) assert.ok(parts.has(m[1]), `override for missing part ${m[1]}`);
    // every relationship target exists; rel ids unique per part
    for (const [name, data] of parts) {
      if (!name.endsWith('.rels')) continue;
      const xml = dec.decode(data);
      const base = name === '_rels/.rels' ? '' : name.replace(/_rels\/([^/]+)\.rels$/, '');
      const ids = new Set<string>();
      for (const m of xml.matchAll(/Id="([^"]+)" Type="[^"]+" Target="([^"]+)"/g)) {
        assert.ok(!ids.has(m[1]), `duplicate ${m[1]} in ${name}`);
        ids.add(m[1]);
        assert.ok(parts.has(base + m[2]), `${name}: target ${m[2]} missing`);
      }
      // every r:id / r:embed used by the owning part is declared
      const owner = name === '_rels/.rels' ? null : base + name.replace(/^.*_rels\/(.+)\.rels$/, '$1');
      if (owner) {
        const ownerXml = dec.decode(parts.get(owner)!);
        for (const m of ownerXml.matchAll(/r:(?:id|embed)="([^"]+)"/g)) assert.ok(ids.has(m[1]), `${owner}: ${m[1]} not declared`);
      }
    }
    const doc = dec.decode(parts.get('word/document.xml')!);
    assert.ok(doc.includes('<w:pgSz w:w="11906" w:h="16838"/>'));
    assert.ok(doc.includes('w:top="1814"'), 'top margin 32 mm');
    assert.match(dec.decode(parts.get('docProps/core.xml')!), /<dc:title>Example investigation report — INV-2099-000001<\/dc:title>/);
  });

  it('parses every XML part with a real parser', { skip: !hasPython && 'python3 not installed' }, async () => {
    const { parts } = await exampleDocx();
    assert.equal(xmlFailures(parts), '');
  });

  it('embeds images byte for byte with EMU sizes, header logo in the header part', async () => {
    const { parts, data } = await exampleDocx();
    const media = [...parts.keys()].filter((n) => n.startsWith('word/media/'));
    assert.deepEqual(media.sort(), ['word/media/image1.png', 'word/media/image2.jpg', 'word/media/image3.jpg']);
    const jpgs = media.filter((n) => n.endsWith('.jpg')).map((n) => parts.get(n)!);
    const garage = data.photos!.garage;
    assert.ok(jpgs.some((b) => Buffer.from(b).equals(Buffer.from(garage[0].image!.bytes))));
    assert.ok(jpgs.some((b) => Buffer.from(b).equals(Buffer.from(garage[1].image!.bytes))));
    const hdrRels = dec.decode(parts.get('word/_rels/header1.xml.rels')!);
    assert.match(hdrRels, /Target="media\/image1\.png"/);
    const doc = dec.decode(parts.get('word/document.xml')!);
    // letterhead 60 mm wide in the body: 60 x 8 mm
    assert.ok(doc.includes('<wp:extent cx="2160000" cy="288000"/>'));
    const ids = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'drawing ids are unique');
    assert.ok(doc.includes('Photo not available: Odometer'));
  });

  it('writes PAGE / NUMPAGES fields, merges, spans, header rows and page breaks', async () => {
    const { parts } = await exampleDocx();
    const ftr = dec.decode(parts.get('word/footer1.xml')!);
    assert.match(ftr, /<w:instrText xml:space="preserve"> PAGE <\/w:instrText>/);
    assert.match(ftr, /<w:instrText xml:space="preserve"> NUMPAGES <\/w:instrText>/);
    const doc = dec.decode(parts.get('word/document.xml')!);
    assert.equal((doc.match(/<w:vMerge w:val="restart"\/>/g) ?? []).length, 2);
    assert.equal((doc.match(/<w:vMerge\/>/g) ?? []).length, 2);
    assert.ok(doc.includes('<w:gridSpan w:val="3"/>'));
    assert.ok(doc.includes('<w:tblHeader/>'));
    assert.ok(doc.includes('<w:br w:type="page"/>'));
    assert.ok(doc.includes('<w:shd w:val="clear" w:color="auto" w:fill="DCE6F2"/>'));
    assert.ok(doc.includes('<w:tab w:val="left" w:pos="340"/>'), 'list markers hang in a 6 mm indent');
    assert.ok(doc.includes('<w:t xml:space="preserve">Rs. 12,34,567</w:t>'));
    // every table cell ends with a paragraph
    for (const m of doc.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)) assert.match(m[1], /(<\/w:p>|<w:p\/>)$/);
  });

  it('keeps hostile values as text', { skip: !hasPython && 'python3 not installed' }, async () => {
    const evil = '<w:p>]]></w:t><script>&amp; "q" \'a\' \u0001\u0002 ￿ \uDC00 {{case.case_ref}}';
    const { parts } = await exampleDocx((d) => {
      for (const f of Object.values(d.fields)) if (f.type === 'text' || f.type === 'long_text') f.value = evil;
      d.case.claim_no = evil;
      d.photos!.garage[2].caption = evil;
    });
    assert.equal(xmlFailures(parts), '');
    const doc = dec.decode(parts.get('word/document.xml')!);
    assert.ok(doc.includes('&lt;w:p&gt;]]&gt;&lt;/w:t&gt;&lt;script&gt;&amp;amp; &quot;q&quot; &apos;a&apos;'));
    assert.ok(doc.includes('{{case.case_ref}}'));
    assert.ok(dec.decode(parts.get('word/header1.xml')!).includes('&lt;w:p&gt;'));
  });

  it('justified text with line breaks becomes one paragraph per line (Word would stretch the line)', async () => {
    const { parts } = await exampleDocx((d) => { d.fields.conclusion.value = 'line one\nline two'; });
    const doc = dec.decode(parts.get('word/document.xml')!);
    const i = doc.indexOf('line one');
    const between = doc.slice(i, doc.indexOf('line two'));
    assert.ok(between.includes('</w:p>') && !between.includes('<w:br/>'));
  });

  it('writes the example to a temporary directory and converts it with LibreOffice when installed', { timeout: 180_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'report-docx-'));
    const { bytes } = await exampleDocx();
    const file = join(dir, 'example.docx');
    writeFileSync(file, bytes);
    if (!soffice) { t.skip('LibreOffice not installed'); return; }
    const profile = `file://${join(dir, 'lo-profile')}`;
    const r = spawnSync(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, file],
      { encoding: 'utf8', timeout: 150_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'example.pdf')), `no PDF: ${r.stdout} ${r.stderr}`);
  });
});
