// 7.7 piece 3 (D51): the report files as the office user's browser builds them — prepare result → photo plan →
// photo bytes (in memory here, the hash-checked file cache there) → ReportData → PDF (the pdfmake BROWSER build, the
// one the web worker loads) + Word → SHA-256 → p_photos. Both insurer layouts, 30 synthetic 1600 px photos
// (27 JPEG device copies, 3 PNG originals as insurer attachments have), fictional data only. Prints the timings.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  formatsFor, loadReportPhotos, placedPhotoRecords, planReportPhotos, preparedProblem, reportDataFrom,
} from '../../../supabase/functions/_shared/report/assemble.ts';
import { createReportRenderer, type PdfMakeLike } from '../../../supabase/functions/_shared/report/files.ts';
import type { PreparedPhoto, PreparedReport, PreparedSection } from '../../../supabase/functions/_shared/report-generate/logic.ts';
import { TEMPLATES_DIR, readYaml, resolveTemplateLayout, type TemplateYaml } from '../src/template-config.ts';
import { photoA, photoB, readZip } from './report-helpers.ts';

const require = createRequire(import.meta.url);
const FONTS_DIR = new URL('../../../apps/web/public/fonts/', import.meta.url).pathname;
const CASE = '7e500000-0000-4000-8000-0000000000aa';
const NOW = new Date('2099-01-10T06:45:00Z');

/** A fresh pdfmake browser build per renderer (it is a singleton with global fonts / vfs). */
function browserPdfmake(): PdfMakeLike {
  const path = require.resolve('pdfmake/build/pdfmake.js');
  delete require.cache[path];
  return require(path) as PdfMakeLike;
}
const renderer = () => createReportRenderer({
  pdfmake: browserPdfmake(),
  loadFont: async (f) => new Uint8Array(readFileSync(join(FONTS_DIR, f))),
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A real JPEG header padded with incompressible bytes to the size of a phone's 1600 px copy. */
function jpegCopy(n: number, size: number): Uint8Array {
  const head = n % 2 ? photoB() : photoA();
  const out = new Uint8Array(size);
  out.set(head);
  out.set(randomBytes(size - head.length), head.length);
  return out;
}

/** A real 1600 × 1200 RGB PNG (gradient + noise, ~1–2 MB: an insurer's PNG attachment). */
function pngPhoto(seed: number): Uint8Array {
  const w = 1600, h = 1200;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const noise = randomBytes(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 1; // filter "sub"
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      const v = (noise[y * w + x] & 0x1f) - 16;
      raw[i] = x === 0 ? (seed * 40 + y) & 255 : v & 255;
      raw[i + 1] = x === 0 ? (y >> 2) & 255 : (v >> 1) & 255;
      raw[i + 2] = x === 0 ? 128 : 1;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const LONG = 'Invented narrative sentence for the browser build test. A second invented sentence follows so that the justified text wraps over a few lines.';
function value(f: { key: string; label: string; type?: string; options?: string[] }): string {
  switch (f.type) {
    case 'date': return '2099-01-02';
    case 'datetime': return '2099-01-02T10:30';
    case 'number': return '3';
    case 'choice': return f.options?.[0] ?? 'Yes';
    case 'long_text': return `${LONG}\n\n${LONG}`;
    default: return `Invented ${f.label.toLowerCase()}`;
  }
}

const evId = (n: number) => `7e700000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** prepare_report_version() for a template, 30 photos split over sections; `bytes` maps storage path → file. */
function preparedFor(template: TemplateYaml, layout: unknown, split: Record<string, number>, bytes: Map<string, Uint8Array>): PreparedReport {
  const sections: PreparedSection[] = template.sections.map((s, i) => ({
    key: s.key, title: s.title, position: i + 1,
    fields: (s.fields ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type ?? 'text', value: value(f as never) })),
  }));
  const photos: PreparedPhoto[] = [];
  let n = 0;
  for (const [section, count] of Object.entries(split)) {
    for (let p = 1; p <= count; p++) {
      n++;
      const png = n % 10 === 0; // 3 of 30: an insurer attachment (PNG original, no device copy)
      const file = png ? pngPhoto(n) : jpegCopy(n, 250_000 + (n % 7) * 25_000);
      const original = `cases/${CASE}/files/${sha(file)}.${png ? 'png' : 'jpg'}`;
      const copy = `derived/${CASE}/${'ab'.repeat(32)}/w1600.jpg`.replace('ab'.repeat(32), sha(file));
      bytes.set(png ? original : copy, file);
      photos.push({
        evidence_id: evId(n), section_key: section, position: p, caption: `Invented photo ${n}`, category_name: 'Vehicle',
        evidence_type: 'photo', mime_type: png ? 'image/png' : 'image/jpeg', storage_backend: 'r2', storage_path: original,
        sha256: sha(file), size_bytes: file.length,
        derivatives: png ? [] : [{ width: 1600, storage_path: copy, sha256: sha(file), size_bytes: file.length, pixel_width: 1600, pixel_height: 1200 }],
      });
    }
  }
  return {
    case: {
      id: CASE, case_ref: 'INV-2099-000001', insurer_claim_no: 'EX/CLM/0001', policy_no: 'EX-POL-0001',
      received_at: '2099-01-02T04:30:00Z', due_at: '2099-01-17T04:30:00Z',
      insurer: { code: 'EXM', name: 'Example Insurance Ltd' }, office_owner: { id: 'u', name: 'Asha Example' },
    },
    template: { id: 't', key: 'x', name: 'x', version: 2, output_formats: ['pdf', 'docx'] },
    report_layout: layout, values_token: 'v1:test', next_version: 1, sections, photos,
  };
}

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

const LAYOUTS = [
  ['icl-motor-od.yaml', 'ICICI Lombard Motor OD', { garage: 24, driver: 1, statement: 3, timeline: 2 }],
  ['igi-motor-od.yaml', 'IndusInd / Reliance Motor OD', { garage: 24, spot: 4, driver: 2 }],
] as const;

describe('report files built as in the browser (pdfmake browser build)', () => {
  for (const [file, name, split] of LAYOUTS) {
    it(`${name}: 30 photos → PDF + Word, every photo placed and recorded`, async (t) => {
      const path = `${TEMPLATES_DIR}${file}`;
      const { config, errors } = resolveTemplateLayout(readYaml<TemplateYaml>(path), path);
      assert.deepEqual(errors, []);
      const store = new Map<string, Uint8Array>();
      const prepared = preparedFor(config, config.report_layout, split, store);
      assert.equal(preparedProblem(prepared, 'generate'), null);
      const r = renderer();

      const wall0 = performance.now();
      const cpu0 = cpuMs();
      const warnings: string[] = [];
      const plans = planReportPhotos(prepared, 'generate');
      assert.equal(plans.length, 30);
      let progress = 0;
      const loaded = await loadReportPhotos(plans, async (src) => store.get(src.path) ?? null, { poolSize: 4, warnings, onProgress: (d) => { progress = d; } });
      assert.equal(progress, 30);
      const data = reportDataFrom(prepared, loaded, NOW.toISOString());
      const tData = performance.now();
      const steps: string[] = [];
      const out = await r.render({ layout: config.report_layout as never, data, formats: formatsFor(prepared, 'generate'), now: NOW, creator: 'Tests' }, (s) => steps.push(s));
      const tFiles = performance.now();
      const hashes = await Promise.all(out.files.map(async (f) => Buffer.from(await crypto.subtle.digest('SHA-256', f.bytes as Uint8Array<ArrayBuffer>)).toString('hex')));
      const photos = placedPhotoRecords(loaded, out.placedKeys);
      const wall = performance.now() - wall0;
      const cpu = cpuMs() - cpu0;

      assert.deepEqual(steps, ['pdf', 'docx']);
      assert.deepEqual(out.files.map((f) => f.format), ['pdf', 'docx']);
      const [pdf, docx] = out.files;
      assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
      assert.ok(readZip(docx.bytes).has('word/document.xml'));
      for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
      assert.equal(photos.length, 30, 'every photo with bytes is recorded as placed');
      assert.deepEqual(new Set(photos.map((p) => p.evidence_id)).size, 30);
      assert.deepEqual(warnings, []);
      // letterhead / seal assets are embedded in the layouts
      assert.ok(out.warnings.every((w) => /asset|runtime/i.test(w)), out.warnings.join('\n'));
      const pngs = [...store.values()].filter((b) => b[0] === 0x89).reduce((s, b) => s + b.length, 0);
      t.diagnostic(`${name}: PDF ${(pdf.bytes.length / 1e6).toFixed(2)} MB, Word ${(docx.bytes.length / 1e6).toFixed(2)} MB ` +
        `(photos ${([...store.values()].reduce((s, b) => s + b.length, 0) / 1e6).toFixed(2)} MB, of which 3 PNG ${(pngs / 1e6).toFixed(2)} MB); ` +
        `wall ${Math.round(wall)} ms (plan + photos + data ${Math.round(tData - wall0)} ms, PDF + Word ${Math.round(tFiles - tData)} ms), CPU ${Math.round(cpu)} ms`);
    });
  }

  it('a photo whose bytes fail (e.g. the hash check) is a placeholder, warned about and not recorded', async () => {
    const path = `${TEMPLATES_DIR}igi-motor-od.yaml`;
    const { config } = resolveTemplateLayout(readYaml<TemplateYaml>(path), path);
    const store = new Map<string, Uint8Array>();
    const prepared = preparedFor(config, config.report_layout, { garage: 2, spot: 1 }, store);
    const warnings: string[] = [];
    const bad = prepared.photos[1].evidence_id;
    const loaded = await loadReportPhotos(planReportPhotos(prepared, 'generate'),
      async (src, p) => (p.evidence_id === bad ? { reason: 'the file failed its integrity check' } : store.get(src.path) ?? null),
      { poolSize: 4, warnings });
    const data = reportDataFrom(prepared, loaded, NOW.toISOString());
    const out = await renderer().render({ layout: config.report_layout as never, data, formats: ['pdf'], now: NOW });
    const photos = placedPhotoRecords(loaded, out.placedKeys);
    assert.deepEqual(photos.map((p) => p.evidence_id), [prepared.photos[0].evidence_id, prepared.photos[2].evidence_id]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Invented photo 2.*integrity check; an empty box/);
  });

  it('loads each font file once per renderer, only the ones the report uses, and never by URL', async () => {
    const loads: string[] = [];
    const pm = browserPdfmake();
    const r = createReportRenderer({ pdfmake: pm, loadFont: async (f) => { loads.push(f); return new Uint8Array(readFileSync(join(FONTS_DIR, f))); } });
    const path = `${TEMPLATES_DIR}igi-motor-od.yaml`;
    const { config } = resolveTemplateLayout(readYaml<TemplateYaml>(path), path);
    const prepared = preparedFor(config, config.report_layout, {}, new Map());
    const data = reportDataFrom(prepared, [], NOW.toISOString());
    await r.render({ layout: config.report_layout as never, data, formats: ['pdf'], now: NOW });
    const first = [...loads];
    await r.render({ layout: config.report_layout as never, data, formats: ['pdf'], now: NOW });
    assert.deepEqual(loads, first, 'second render loads nothing');
    assert.ok(first.length >= 1 && first.length <= 4, first.join()); // of 12 files
    assert.ok(first.includes('Carlito-Regular.ttf'), first.join()); // Calibri layout
    assert.equal(pm.localAccessPolicy?.('/etc/passwd'), false);
    // a URL in the definition is refused by pdfmake's own policy (set by the renderer)
    await assert.rejects(pm.createPdf({ content: [{ image: 'https://example.invalid/x.png' }] } as never).getBuffer());
  });
});
