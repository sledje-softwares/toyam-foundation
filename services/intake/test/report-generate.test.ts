// report-generate edge function: request validation, image choice, rate limits, Browser Rendering
// request / 429 mapping and the request flow against a fake gateway (the caller's JWT client).
// Fictional data only.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRateLimit, imageSources, MAX_IMAGE_BYTES, parseRequest, parseRetryAfter, pdfFailure, pdfRequest, photoSections,
  secondsToUtcMidnight,
} from '../../../supabase/functions/_shared/report-generate/logic.ts';
import { handleReportGenerate } from '../../../supabase/functions/_shared/report-generate/handler.ts';
import { defaultLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import { photoA, readZip } from './report-helpers.ts';
import {
  CASE, copyKey, env, fakeGateway, NOW, originalKey, PDF_BYTES, photo, post, prepared, REPORT, SECTIONS,
} from './report-generate-helpers.ts';

const fns = (calls: { fn: string; args: unknown[] }[], fn: string) => calls.filter((c) => c.fn === fn);
type Body = Record<string, any>;

describe('report-generate validation', () => {
  it('needs a case_id; mode defaults to generate; notes are trimmed and capped', () => {
    const r = parseRequest({ case_id: CASE.toUpperCase(), notes: '  first draft ' });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, { case_id: CASE, mode: 'generate', notes: 'first draft' });
    for (const b of [{}, { case_id: 'x' }, { case_id: CASE, mode: 'print' }, { case_id: CASE, notes: 5 }, { case_id: CASE, notes: 'x'.repeat(2001) }, []]) {
      assert.equal(parseRequest(b).ok, false, JSON.stringify(b).slice(0, 40));
    }
    const p = parseRequest({ case_id: CASE, mode: 'preview', notes: '   ' });
    assert.ok(p.ok && p.value.mode === 'preview' && p.value.notes === null);
  });

  it('405 for GET, 401 without a bearer token or with an invalid session, 400 for bad JSON', async () => {
    const { gw, calls } = fakeGateway();
    assert.equal((await handleReportGenerate('GET', true, '', gw, env())).status, 405);
    const r = await handleReportGenerate('POST', false, JSON.stringify({ case_id: CASE }), gw, env());
    assert.equal(r.status, 401);
    assert.equal((r.body as Body).error.code, 'unauthorized');
    assert.equal(calls.length, 0);
    const bad = await handleReportGenerate('POST', true, '{', gw, env());
    assert.equal(bad.status, 400);
    const { gw: gw2, calls: c2 } = fakeGateway({ uid: null });
    assert.equal((await post(gw2, { case_id: CASE })).status, 401);
    assert.equal(fns(c2, 'prepare').length, 0);
  });
});

describe('report-generate image choice', () => {
  it('generate uses the 1600 copy then the original; preview the 384 copy first', () => {
    const g = imageSources(photo(1), 'generate');
    assert.deepEqual(g.sources.map((s) => s.kind), ['copy1600', 'original']);
    assert.equal(g.sources[0].width, 1600);
    const p = imageSources(photo(1), 'preview');
    assert.deepEqual(p.sources.map((s) => s.kind), ['copy384', 'copy1600', 'original']);
  });
  it('HEIC and oversized originals are skipped unless a device copy exists', () => {
    const heic = imageSources(photo(1, { mime_type: 'image/heic', storage_path: originalKey(1, 'heic'), derivatives: [] }), 'generate');
    assert.deepEqual(heic.sources, []);
    assert.match(heic.skip ?? '', /HEIC/);
    const heicCopy = imageSources(photo(1, { mime_type: 'image/heic', storage_path: originalKey(1, 'heic') }), 'generate');
    assert.deepEqual(heicCopy.sources.map((s) => s.kind), ['copy1600']);
    const big = imageSources(photo(1, { size_bytes: MAX_IMAGE_BYTES + 1, derivatives: [] }), 'generate');
    assert.match(big.skip ?? '', /larger than 3 MB/);
  });
  it('insurer attachments are read from Storage as they are; odd keys are refused', () => {
    const att = imageSources(photo(1, { storage_backend: 'supabase', storage_path: `${CASE}/msg/att-1.jpg`, derivatives: [] }), 'generate');
    assert.deepEqual(att.sources.map((s) => [s.store, s.kind]), [['supabase', 'original']]);
    assert.equal(imageSources(photo(1, { storage_backend: 'supabase', storage_path: '../x.jpg', derivatives: [] }), 'generate').sources.length, 0);
    assert.equal(imageSources(photo(1, { storage_path: 'elsewhere/x.jpg', derivatives: [] }), 'generate').sources.length, 0);
    const odd = imageSources(photo(1, { derivatives: [{ width: 1600, storage_path: 'derived/../x.jpg', size_bytes: 1, pixel_width: 1, pixel_height: 1 }] }), 'generate');
    assert.deepEqual(odd.sources.map((s) => s.kind), ['original']);
  });
  it('finds the sections the layout shows photos for', () => {
    assert.deepEqual([...photoSections(defaultLayout(SECTIONS))].sort(), ['garage', 'insured', 'spot']);
    assert.deepEqual([...photoSections({ body: [{ type: 'paragraph', text: 'x' }] })], []);
  });
});

describe('report-generate limits and Browser Rendering', () => {
  it('rate limit: 1 per 15 s and 10 per hour', () => {
    const l = createRateLimit([{ windowMs: 15_000, max: 1 }, { windowMs: 3_600_000, max: 10 }]);
    assert.equal(l.take('u', 0), null);
    assert.equal(l.take('u', 5_000), 10);
    assert.equal(l.take('v', 5_000), null);
    for (let i = 1; i < 10; i++) assert.equal(l.take('u', i * 20_000), null);
    assert.equal(l.take('u', 10 * 20_000), 3_400); // the first call (t = 0) leaves the hour at 3 600 s
  });
  it('builds the /pdf request with caching off and JavaScript off', () => {
    const r = pdfRequest('acct-1', '<p>x</p>', { width: '210mm' } as never);
    assert.equal(r.url, 'https://api.cloudflare.com/client/v4/accounts/acct-1/browser-rendering/pdf?cacheTTL=0');
    const b = JSON.parse(r.body);
    assert.equal(b.html, '<p>x</p>');
    assert.deepEqual(b.pdfOptions, { width: '210mm' });
    assert.equal(b.setJavaScriptEnabled, false);
  });
  it('maps 429 with Retry-After, the daily limit and other failures', () => {
    assert.equal(parseRetryAfter('7', 0), 7);
    assert.equal(parseRetryAfter(new Date(30_000).toUTCString(), 0), 30);
    assert.equal(parseRetryAfter(null, 0), null);
    const now = NOW.getTime();
    const busy = pdfFailure({ ok: false, status: 429, retryAfter: 8, message: 'Rate limit exceeded' }, now);
    assert.equal(busy.status, 429);
    assert.equal(busy.error.retry_after, 8);
    assert.match(busy.error.message, /8 s/);
    const daily = pdfFailure({ ok: false, status: 429, retryAfter: null, message: 'Browser time limit exceeded for today' }, now);
    assert.equal(daily.error.retry_after, secondsToUtcMidnight(now));
    assert.equal(daily.error.retry_after, 18 * 3600);
    assert.equal(pdfFailure({ ok: false, status: 500, retryAfter: null, message: null }, now).error.code, 'pdf_failed');
  });
});

describe('report-generate flow', () => {
  it('generate: prepares, renders PDF and DOCX, uploads both and records the version', async () => {
    const { gw, calls, logs } = fakeGateway();
    const r = await post(gw, { case_id: CASE, notes: 'v3 for review' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as Body;
    assert.equal(b.ok, true);
    assert.equal(b.report_id, REPORT);
    assert.equal(b.version, 3);
    assert.deepEqual(b.warnings, []);
    assert.deepEqual(b.files.map((f: Body) => [f.format, f.storage_path]), [
      ['pdf', `${CASE}/${REPORT}/report.pdf`], ['docx', `${CASE}/${REPORT}/report.docx`]]);
    for (const f of b.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.files[0].size_bytes, PDF_BYTES.length);
    // images: the 1600 copies only
    assert.deepEqual(fns(calls, 'fetchImage').map((c) => c.args[1]), [copyKey(1, 1600), copyKey(2, 1600)]);
    const [html, opts] = fns(calls, 'renderPdf')[0].args as [string, Body];
    assert.match(html, /data:image\/jpeg;base64,/);
    assert.match(html, /INV-2026-000042/);
    assert.equal(opts.width, '210mm');
    assert.deepEqual(fns(calls, 'upload').map((c) => [c.args[0], c.args[2]]), [
      [`${CASE}/${REPORT}/report.pdf`, 'application/pdf'],
      [`${CASE}/${REPORT}/report.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]);
    const args = fns(calls, 'createVersion')[0].args[0] as Body;
    assert.equal(args.p_case_id, CASE);
    assert.equal(args.p_report_id, REPORT);
    assert.equal(args.p_values_token, 'v1:abc');
    assert.equal(args.p_notes, 'v3 for review');
    assert.deepEqual(args.p_files, b.files);
    assert.deepEqual(args.p_photos, [
      { evidence_id: photo(1).evidence_id, section_key: 'garage', position: 1, caption: 'Photo 1' },
      { evidence_id: photo(2).evidence_id, section_key: 'garage', position: 2, caption: 'Photo 2' }]);
    assert.deepEqual(logs, []);
    // order: prepare → render → upload → create
    assert.deepEqual(calls.map((c) => c.fn).filter((f) => f !== 'fetchImage'),
      ['prepare', 'renderPdf', 'upload', 'upload', 'createVersion']);
  });

  it('the DOCX holds the photos and the case facts', async () => {
    let docx: Uint8Array | null = null;
    const { gw } = fakeGateway();
    const up = gw.upload;
    gw.upload = async (path, bytes, ct) => { if (path.endsWith('.docx')) docx = bytes; return up(path, bytes, ct); };
    assert.equal((await post(gw, { case_id: CASE })).status, 200);
    const z = readZip(docx!);
    assert.equal([...z.keys()].filter((k) => k.startsWith('word/media/')).length, 2);
    assert.match(new TextDecoder().decode(z.get('word/document.xml')), /Example Motors/);
  });

  it('preview: 384 copies, HTML back, nothing rendered, stored or recorded', async () => {
    const { gw, calls } = fakeGateway();
    const r = await post(gw, { case_id: CASE, mode: 'preview' });
    assert.equal(r.status, 200);
    const b = r.body as Body;
    assert.equal(b.ok, true);
    assert.match(b.html, /class="sheet"/);
    assert.match(b.html, /Content-Security-Policy/);
    assert.deepEqual(fns(calls, 'fetchImage').map((c) => c.args[1]), [copyKey(1, 384), copyKey(2, 384)]);
    assert.equal(fns(calls, 'renderPdf').length + fns(calls, 'upload').length + fns(calls, 'createVersion').length, 0);
    // the preview asks the database for the preview variant (no editable-status check); generate does not
    assert.deepEqual(fns(calls, 'prepare').map((c) => c.args), [[CASE, 'preview']]);
    // preview does not need Browser Rendering
    const { gw: gw2 } = fakeGateway();
    assert.equal((await post(gw2, { case_id: CASE, mode: 'preview' }, env({ pdfConfigured: false }))).status, 200);
  });

  it('photo fallbacks: device copy → original → placeholder; placeholders are not recorded', async () => {
    const a = photoA();
    const images = new Map([
      [originalKey(1), a], // photo 1: copy missing on R2 → original
      [originalKey(3), a], // photo 3: no copy recorded → original
      // photo 2: copy and original both missing → placeholder
    ]);
    const p = prepared({ photos: [photo(1), photo(2), photo(3, { derivatives: [] })] });
    const { gw, calls } = fakeGateway({ prepared: p, images });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 200);
    const b = r.body as Body;
    assert.deepEqual(fns(calls, 'fetchImage').map((c) => c.args[1]).sort(),
      [copyKey(1, 1600), copyKey(2, 1600), originalKey(1), originalKey(2), originalKey(3)].sort());
    assert.equal(fns(calls, 'fetchImage').length, 5);
    assert.equal(b.warnings.length, 1);
    assert.match(b.warnings[0], /^Photo "Photo 2" \(Garage visit\): the file could not be read; an empty box/);
    const html = fns(calls, 'renderPdf')[0].args[0] as string;
    assert.match(html, /Photo not available: Photo 2/);
    const args = fns(calls, 'createVersion')[0].args[0] as Body;
    assert.deepEqual(args.p_photos.map((x: Body) => x.position), [1, 3]);
  });

  it('HEIC without a device copy → placeholder, never fetched; a non-image body → placeholder', async () => {
    const heic = photo(1, { mime_type: 'image/heic', storage_path: originalKey(1, 'heic'), derivatives: [] });
    const images = new Map([[copyKey(2, 1600), new TextEncoder().encode('<html>not an image</html>')], [originalKey(2), new Uint8Array([1, 2, 3])]]);
    const { gw, calls } = fakeGateway({ prepared: prepared({ photos: [heic, photo(2)] }), images });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 200);
    const b = r.body as Body;
    assert.ok(!fns(calls, 'fetchImage').some((c) => c.args[1] === originalKey(1, 'heic')));
    assert.match(b.warnings[0], /HEIC images cannot be placed in a report/);
    assert.match(b.warnings[1], /not a JPEG or PNG/);
    assert.deepEqual((fns(calls, 'createVersion')[0].args[0] as Body).p_photos, []);
  });

  it('only fetches photos of sections the layout shows, within the byte budget', async () => {
    const layout = { ...defaultLayout(SECTIONS), body: [{ type: 'photos', section: 'spot' }] };
    const p = prepared({ report_layout: layout, photos: [photo(1), photo(2, { section_key: 'spot', position: 1 })] });
    const { gw, calls } = fakeGateway({ prepared: p });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 200);
    assert.deepEqual(fns(calls, 'fetchImage').map((c) => c.args[1]), [copyKey(2, 1600)]);
    // budget: 100 copies of 300 kB → 80 fit into 24 MB
    const many = Array.from({ length: 100 }, (_, i) => photo(i + 1));
    const { gw: gw2, calls: c2 } = fakeGateway({ prepared: prepared({ photos: many }), images: new Map() });
    const r2 = await post(gw2, { case_id: CASE, mode: 'generate' });
    assert.equal(fns(c2, 'fetchImage').filter((c) => String(c.args[1]).startsWith('derived/')).length, 83);
    assert.equal((r2.body as Body).warnings.filter((w: string) => /as many image bytes/.test(w)).length, 17);
  });

  it('only the template formats are generated', async () => {
    const { gw, calls } = fakeGateway({ prepared: prepared({ template: { id: 't-1', output_formats: ['docx'] } }) });
    const r = await post(gw, { case_id: CASE }, env({ pdfConfigured: false }));
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as Body).files.map((f: Body) => f.format), ['docx']);
    assert.equal(fns(calls, 'renderPdf').length, 0);
    const { gw: gw2, calls: c2 } = fakeGateway({ prepared: prepared({ template: { id: 't-1', output_formats: ['pdf'] } }) });
    const r2 = await post(gw2, { case_id: CASE });
    assert.deepEqual((r2.body as Body).files.map((f: Body) => f.format), ['pdf']);
    assert.deepEqual(fns(c2, 'upload').map((c) => c.args[0]), [`${CASE}/${REPORT}/report.pdf`]);
    const { gw: gw3 } = fakeGateway({ prepared: prepared({ template: { id: 't-1', output_formats: [] } }) });
    assert.equal(((await post(gw3, { case_id: CASE })).body as Body).error.code, 'no_formats');
  });

  it('Browser Rendering 429 passes through with retry_after; nothing is stored', async () => {
    const { gw, calls } = fakeGateway({ pdf: { ok: false, status: 429, retryAfter: 9, message: 'Rate limit exceeded' } });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, 9);
    assert.deepEqual((r.body as Body).error, { code: 'rate_limited', message: 'The PDF service is busy. Try again in 9 s.', retry_after: 9 });
    assert.equal(fns(calls, 'upload').length, 0);
    const { gw: gw2 } = fakeGateway({ pdf: { ok: false, status: 403, retryAfter: null, message: 'Authentication error' } });
    const r2 = await post(gw2, { case_id: CASE });
    assert.equal(r2.status, 502);
    assert.equal((r2.body as Body).error.code, 'pdf_failed');
    const { gw: gw3 } = fakeGateway({ pdf: { ok: true, bytes: new TextEncoder().encode('<html>') } });
    assert.equal((await post(gw3, { case_id: CASE })).status, 502);
  });

  it('own per-isolate PDF spacing answers 429 before any image is fetched', async () => {
    const pdfLimit = createRateLimit([{ windowMs: 10_000, max: 1 }]);
    const e = env({ pdfLimit });
    assert.equal((await post(fakeGateway().gw, { case_id: CASE }, e)).status, 200);
    const { gw, calls } = fakeGateway();
    const r = await post(gw, { case_id: CASE }, e);
    assert.equal(r.status, 429);
    assert.equal((r.body as Body).error.retry_after, 10);
    assert.equal(fns(calls, 'fetchImage').length, 0);
  });

  it('per-user limit: a second generate within 15 s is refused, preview counts separately', async () => {
    const limit = createRateLimit([{ windowMs: 15_000, max: 1 }]);
    const e = env({ limit });
    assert.equal((await post(fakeGateway().gw, { case_id: CASE }, e)).status, 200);
    const r = await post(fakeGateway().gw, { case_id: CASE }, e);
    assert.equal(r.status, 429);
    assert.equal(r.retryAfter, 15);
    assert.equal((await post(fakeGateway().gw, { case_id: CASE, mode: 'preview' }, e)).status, 200);
  });

  it('RV409 → 409 values_changed after the upload (objects stay, logged)', async () => {
    const { gw, calls, logs } = fakeGateway({ createError: { code: 'RV409', message: 'The report values changed since this version was prepared. Generate it again' } });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 409);
    assert.equal((r.body as Body).error.code, 'values_changed');
    assert.match((r.body as Body).error.message, /changed the report while it was generating/);
    assert.equal(fns(calls, 'upload').length, 2);
    assert.match(logs[0], /create_report_version failed: RV409 report 7e900000/);
  });

  it('prepare errors: 42501 → 403, P0002 → 404, 55000 → 409 with the DB message, 22023 → 422', async () => {
    const cases: [string, number, string][] = [['42501', 403, 'forbidden'], ['P0002', 404, 'not_found'], ['55000', 409, 'not_editable'],
      ['22023', 422, 'invalid_case'], ['PGRST301', 401, 'unauthorized'], ['XX000', 502, 'upstream_error']];
    for (const [code, status, ec] of cases) {
      const msg = code === '55000' ? 'The report is waiting for approval or approved, so no new version can be made' : 'x';
      const { gw, calls } = fakeGateway({ prepareError: { code, message: msg } });
      const r = await post(gw, { case_id: CASE });
      assert.equal(r.status, status, code);
      assert.equal((r.body as Body).error.code, ec);
      if (code === '55000') assert.equal((r.body as Body).error.message, msg);
      assert.equal(fns(calls, 'fetchImage').length, 0);
    }
  });

  it('no layout → 422 no_layout; an invalid layout → 422 invalid_layout with issues', async () => {
    const { gw, calls } = fakeGateway({ prepared: prepared({ report_layout: null }) });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 422);
    assert.equal((r.body as Body).error.code, 'no_layout');
    assert.match((r.body as Body).error.message, /no report layout/);
    assert.equal(fns(calls, 'fetchImage').length, 0);
    const { gw: gw2 } = fakeGateway({ prepared: prepared({ report_layout: { version: 1, body: 'x' } }) });
    const r2 = await post(gw2, { case_id: CASE, mode: 'preview' });
    assert.equal(r2.status, 422);
    assert.equal((r2.body as Body).error.code, 'invalid_layout');
    assert.ok(((r2.body as Body).error.issues as string[]).length > 0);
  });

  it('upload refused → 403 / 502, nothing recorded', async () => {
    const { gw, calls } = fakeGateway({ uploadError: { statusCode: '403', message: 'new row violates row-level security policy' } });
    const r = await post(gw, { case_id: CASE });
    assert.equal(r.status, 403);
    assert.equal(fns(calls, 'createVersion').length, 0);
    const { gw: gw2 } = fakeGateway({ uploadError: { statusCode: '500' } });
    assert.equal(((await post(gw2, { case_id: CASE })).body as Body).error.code, 'upload_failed');
  });

  it('missing configuration: 503 for PDF without Browser Rendering, R2 photos without R2', async () => {
    const r = await post(fakeGateway().gw, { case_id: CASE }, env({ pdfConfigured: false }));
    assert.equal(r.status, 503);
    assert.equal((r.body as Body).error.code, 'pdf_not_configured');
    const r2 = await post(fakeGateway().gw, { case_id: CASE }, env({ r2Configured: false }));
    assert.equal((r2.body as Body).error.code, 'storage_not_configured');
    // a case with only Storage attachments still works without R2
    const att = photo(1, { storage_backend: 'supabase', storage_path: `${CASE}/m/a.jpg`, derivatives: [] });
    const images = new Map([[`${CASE}/m/a.jpg`, photoA()]]);
    const r3 = await post(fakeGateway({ prepared: prepared({ photos: [att] }), images }).gw, { case_id: CASE }, env({ r2Configured: false }));
    assert.equal(r3.status, 200);
  });

  it('a concurrent version gets a warning when the printed number differs', async () => {
    const { gw } = fakeGateway({ createdVersion: 4 });
    const r = await post(gw, { case_id: CASE });
    assert.equal((r.body as Body).version, 4);
    assert.match((r.body as Body).warnings[0], /this one is version 4/);
  });
});
