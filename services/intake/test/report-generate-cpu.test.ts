// CPU of the heavy steps of report-generate for a large report: 30 photos of ~500 kB (device copies),
// PDF of ~15 MB. The edge runtime allows 2 s of CPU per request (async I/O excluded); this prints
// the numbers (`--test-reporter=spec` shows them as diagnostics) and fails if the whole request
// (prepare result → images in memory → HTML → /pdf JSON body → DOCX → SHA-256 → upload / record
// with a fake gateway) goes past 1.5 s here. Numbers are from Node; Deno runs the same V8, WebCrypto is native in both.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { bindReport, fieldsFromSections, type ReportData } from '../../../supabase/functions/_shared/report/bind.ts';
import { htmlFromDocument } from '../../../supabase/functions/_shared/report/html.ts';
import { docxFromDocument } from '../../../supabase/functions/_shared/report/docx.ts';
import { hex, pdfRequest } from '../../../supabase/functions/_shared/report-generate/logic.ts';
import type { ReportLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { copyKey, env, fakeGateway, photo, post, prepared } from './report-generate-helpers.ts';
import { photoA } from './report-helpers.ts';

const N = 30;
const SIZE = 500_000;

function bigJpeg(): Uint8Array {
  const head = photoA(); // a real JPEG (header, size), padded with incompressible bytes
  const out = new Uint8Array(SIZE);
  out.set(head);
  out.set(randomBytes(SIZE - head.length), head.length);
  return out;
}

const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
async function measure<T>(fn: () => Promise<T> | T): Promise<{ ms: number; out: T }> {
  const t0 = cpuMs();
  const out = await fn();
  return { ms: Math.round((cpuMs() - t0) * 10) / 10, out };
}

describe('report-generate CPU (30 photos × 500 kB)', () => {
  const photos = Array.from({ length: N }, (_, i) => photo(i + 1, {
    derivatives: [{ width: 1600, storage_path: copyKey(i + 1, 1600), size_bytes: SIZE, pixel_width: 1600, pixel_height: 1200 }],
  }));
  const images = new Map(photos.map((p) => [p.derivatives![0].storage_path, bigJpeg()]));
  const prep = prepared({ photos });
  const pdfBytes = new Uint8Array(15 * 1024 * 1024);
  pdfBytes.set(new TextEncoder().encode('%PDF-1.7\n'));

  it('steps and whole request stay well under 2 s CPU', async (t) => {
    const layout = prep.report_layout as ReportLayout;
    const data: ReportData = {
      case: { case_ref: prep.case.case_ref },
      fields: fieldsFromSections(prep.sections),
      photos: { garage: photos.map((p) => ({ evidence_id: p.evidence_id, caption: p.caption, image: { bytes: images.get(p.derivatives![0].storage_path)!, mime: 'image/jpeg' as const, width: 1600, height: 1200 } })) },
    };
    const results: Record<string, number> = {};
    for (let run = 0; run < 3; run++) {
      const bind = await measure(() => bindReport(layout, data));
      const html = await measure(() => htmlFromDocument(bind.out, 'pdf')); // includes base64 of every photo
      const body = await measure(() => pdfRequest('acct', html.out.html, html.out.pdfOptions).body);
      const docx = await measure(() => docxFromDocument(bind.out)); // includes CRC-32 of every photo
      const shaPdf = await measure(async () => hex(await crypto.subtle.digest('SHA-256', pdfBytes)));
      const shaDocx = await measure(async () => hex(await crypto.subtle.digest('SHA-256', docx.out as Uint8Array<ArrayBuffer>)));
      const { gw } = fakeGateway({ prepared: prep, images, pdf: { ok: true, bytes: pdfBytes } });
      // as index.ts does: JSON body, UTF-8 encoded by fetch()
      gw.renderPdf = async (h, o) => {
        const encoded = new TextEncoder().encode(pdfRequest('acct', h, o).body);
        assert.ok(encoded.length > 0);
        return { ok: true, bytes: pdfBytes };
      };
      const whole = await measure(() => post(gw, { case_id: prep.case.id }));
      assert.equal(whole.out.status, 200, JSON.stringify(whole.out.body).slice(0, 300));
      assert.equal((whole.out.body as { warnings: string[] }).warnings.length, 0);
      Object.assign(results, {
        [`run${run + 1}.bind`]: bind.ms, [`run${run + 1}.html+base64`]: html.ms, [`run${run + 1}.json_body`]: body.ms,
        [`run${run + 1}.docx+crc`]: docx.ms, [`run${run + 1}.sha256_pdf_15MB`]: shaPdf.ms, [`run${run + 1}.sha256_docx`]: shaDocx.ms,
        [`run${run + 1}.whole_request`]: whole.ms,
      });
      if (run === 0) {
        t.diagnostic(`html ${(html.out.html.length / 1e6).toFixed(1)} MB chars, request body ${(body.out.length / 1e6).toFixed(1)} MB, docx ${(docx.out.length / 1e6).toFixed(1)} MB`);
      }
      t.diagnostic(`run ${run + 1}: ${JSON.stringify(results)}`);
      if (run === 2) assert.ok(whole.ms < 1500, `whole request took ${whole.ms} ms CPU`);
    }
    for (const [k, v] of Object.entries(results)) t.diagnostic(`${k}: ${v} ms`);
  });
});
