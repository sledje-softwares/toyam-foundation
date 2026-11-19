import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTextExtractStage } from '../src/stages/text-extract.ts';
import { createOcrStage } from '../src/stages/ocr.ts';
import { createPdfTools, textItemsToPage } from '../src/media.ts';
import { createHttpEngine, createNoneEngine, parseOcrResponse, OcrHttpError } from '../src/ocr-engine.ts';
import type { OcrEngine } from '../src/ocr-engine.ts';
import { memoryLogger } from '../src/log.ts';
import { makePdf } from './minipdf.ts';
import { FakeDb, FakeStore, evidence, job, sha } from './fakes.ts';

describe('text_extract (real pdf.js)', () => {
  const pdf = createPdfTools();

  function setup(bytes: Uint8Array, over = {}) {
    const db = new FakeDb();
    const store = new FakeStore();
    db.evidence.set('e1', evidence({ evidence_type: 'document', mime_type: 'application/pdf', storage_backend: 'supabase', storage_path: 'emails/m/a.pdf', sha256: sha(bytes), ...over }));
    store.put('supabase', 'emails/m/a.pdf', bytes);
    return { db, store, run: createTextExtractStage({ db, store, pdf, log: memoryLogger(), maxBytes: 1_000_000, maxPages: 2 }) };
  }

  test('one evidence_ocr row per page with text, engine pdf_text_layer, blocks in page coordinates', async () => {
    const s = setup(makePdf([['Registration Certificate', 'Reg No MH12AB1234'], [], ['Third page']]));
    assert.deepEqual(await s.run(job({ stage: 'text_extract' })), { status: 'done' });
    assert.equal(s.db.ocr.length, 1, 'page 2 has no text, page 3 is beyond PDF_MAX_PAGES=2');
    const row = s.db.ocr[0];
    assert.equal(row.engine, 'pdf_text_layer');
    assert.equal(row.page_no, 1);
    assert.equal(row.text, 'Registration Certificate\nReg No MH12AB1234');
    assert.deepEqual(row.blocks[1], { text: 'Reg No MH12AB1234', bbox: [72, 80, 118.7, 12], conf: 1, line: 2 });
    assert.equal(row.mean_confidence, 1);
  });

  test('skipped when the PDF has no text layer, when it is not a PDF, or withdrawn', async () => {
    let s = setup(makePdf([[]]));
    assert.deepEqual(await s.run(job({ stage: 'text_extract' })), { status: 'skipped', reason: 'no_text_layer' });
    s = setup(makePdf([['x']]), { mime_type: 'image/jpeg' });
    assert.deepEqual(await s.run(job({ stage: 'text_extract' })), { status: 'skipped', reason: 'not_pdf' });
    s = setup(makePdf([['x']]), { withdrawn_at: '2026-11-18T00:00:00Z' });
    assert.deepEqual(await s.run(job({ stage: 'text_extract' })), { status: 'skipped', reason: 'withdrawn' });
  });

  test('hash mismatch fails the job', async () => {
    const s = setup(makePdf([['x']]), { sha256: sha('other') });
    await assert.rejects(s.run(job({ stage: 'text_extract' })), /SHA-256/);
  });

  test('renders the first page for scanned PDFs', async () => {
    const img = await pdf.renderFirstPage(makePdf([['Scan']]), 384);
    assert.ok(img);
    assert.equal(Math.max(img.width, img.height), 384);
    assert.equal(img.bytes[0], 0xff, 'JPEG');
    assert.equal(img.bytes[1], 0xd8);
  });

  test('textItemsToPage groups items into lines', () => {
    const p = textItemsToPage([
      { str: 'DL No', transform: [10, 0, 0, 10, 50, 700], width: 30, height: 10 },
      { str: 'MH12 20110012345', transform: [10, 0, 0, 10, 90, 700], width: 80, height: 10 },
      { str: 'Valid till 01-01-2030', transform: [10, 0, 0, 10, 50, 680], width: 90, height: 10 },
    ], 792, 1);
    assert.equal(p.text, 'DL No MH12 20110012345\nValid till 01-01-2030');
    assert.deepEqual(p.blocks.map((b) => b.line), [1, 1, 2]);
  });
});

describe('ocr stage', () => {
  function setup(engine: OcrEngine, over = {}) {
    const db = new FakeDb();
    const store = new FakeStore();
    db.evidence.set('e1', evidence(over));
    store.put('r2', 'cases/case1/tasks/t1/orig.jpg', 'original');
    return { db, store, run: createOcrStage({ db, store, engine, log: memoryLogger(), maxBytes: 1_000_000, maxPages: 5, deviceMinConfidence: 0.85 }) };
  }

  test('respects ocr_wanted(), the PDF text layer and good device OCR', async () => {
    let s = setup(createNoneEngine());
    s.db.wanted.set('e1', false);
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'skipped', reason: 'ocr_not_wanted' });
    s = setup(createNoneEngine());
    s.db.ocr.push({ id: 'o', evidence_id: 'e1', page_no: 1, engine: 'pdf_text_layer', text: 'text', blocks: [], mean_confidence: 1, is_current: true });
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'skipped', reason: 'pdf_text_layer' });
    s = setup(createNoneEngine());
    s.db.ocr.push({ id: 'o', evidence_id: 'e1', page_no: 1, engine: 'mlkit_device', text: 'MH12AB1234', blocks: [], mean_confidence: 0.9, is_current: true });
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'skipped', reason: 'device_ocr_present' });
    s = setup(createNoneEngine());
    s.db.ocr.push({ id: 'o', evidence_id: 'e1', page_no: 1, engine: 'mlkit_device', text: 'MH12AB1234', blocks: [], mean_confidence: null, is_current: true });
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'skipped', reason: 'device_ocr_present' }, 'no confidence reported = present');
  });

  test('device OCR below the confidence threshold: server OCR runs', async () => {
    const posted: string[] = [];
    const engine = createHttpEngine({ url: 'http://ocr', fetch: async (url) => {
      posted.push(url);
      return new Response(JSON.stringify({ engine: 'paddleocr', pages: [{ page_no: 1, text: 'X', blocks: [{ text: 'X', bbox: [0, 0, 1, 1], conf: 0.9 }] }] }));
    } });
    const s = setup(engine);
    s.db.ocr.push({ id: 'o', evidence_id: 'e1', page_no: 1, engine: 'mlkit_device', text: 'blurred', blocks: [], mean_confidence: 0.2, is_current: true });
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'done' });
    assert.deepEqual(posted, ['http://ocr/ocr']);
  });

  test('engine none: skipped with a clear reason (current behaviour until the sidecar runs)', async () => {
    const s = setup(createNoneEngine());
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'skipped', reason: 'no_ocr_engine_configured' });
    assert.equal(s.store.reads.length, 0);
  });

  test('http engine: posts the original at full resolution and stores one row per page', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const engine = createHttpEngine({
      url: 'http://ocr:8866/', token: 'tok',
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, body: Buffer.from(init.body).toString() });
        return new Response(JSON.stringify({
          engine: 'paddleocr', engine_version: '3.2.0', lang: 'en',
          pages: [{ page_no: 1, text: 'MH 12 AB 1234', mean_confidence: 0.91,
                    blocks: [{ text: 'MH 12 AB 1234', bbox: [10, 20, 200, 40], conf: 0.91, line: 1 }, { text: '', bbox: [0, 0, 1, 1], conf: 1 }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const s = setup(engine);
    assert.deepEqual(await s.run(job({ stage: 'ocr' })), { status: 'done' });
    assert.equal(calls[0].url, 'http://ocr:8866/ocr');
    assert.equal(calls[0].headers.authorization, 'Bearer tok');
    assert.equal(calls[0].headers['content-type'], 'image/jpeg');
    assert.equal(calls[0].body, 'original');
    assert.equal(s.db.ocr.length, 1);
    assert.equal(s.db.ocr[0].engine, 'paddleocr');
    assert.equal(s.db.ocr[0].blocks.length, 1, 'empty block dropped');
  });

  test('sidecar errors: 5xx and unreachable are retryable, 4xx not', async () => {
    const e500 = createHttpEngine({ url: 'http://ocr', fetch: async () => new Response('{"error":"oom"}', { status: 500 }) });
    await assert.rejects(e500.read(new Uint8Array(1), 'image/jpeg', { maxPages: 1 }), (err: unknown) => err instanceof OcrHttpError && err.retryable);
    const e415 = createHttpEngine({ url: 'http://ocr', fetch: async () => new Response('{"error":"type"}', { status: 415 }) });
    await assert.rejects(e415.read(new Uint8Array(1), 'image/jpeg', { maxPages: 1 }), (err: unknown) => err instanceof OcrHttpError && !err.retryable);
    const down = createHttpEngine({ url: 'http://ocr', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(down.read(new Uint8Array(1), 'image/jpeg', { maxPages: 1 }), /unreachable/);
  });

  test('parseOcrResponse validates pages and blocks', () => {
    assert.throws(() => parseOcrResponse({}), /no pages/);
    const out = parseOcrResponse({ pages: [{ page_no: 0 }, { page_no: 2, blocks: [{ text: 'A', bbox: [1, 2, 3, 4], conf: 2 }] }] });
    assert.equal(out.pages.length, 1);
    assert.equal(out.pages[0].text, 'A');
    assert.equal(out.pages[0].blocks[0].conf, 1);
    assert.equal(out.pages[0].mean_confidence, 1);
    assert.equal(out.engine, 'paddleocr');
  });
});
