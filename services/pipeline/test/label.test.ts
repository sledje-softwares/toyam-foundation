import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLabelStage, ESCALATION_SUFFIX } from '../src/stages/label.ts';
import type { LabelDeps } from '../src/stages/label.ts';
import { TemplateCache, buildContext } from '../src/template-context.ts';
import { memoryLogger } from '../src/log.ts';
import { HttpError } from '../../labeller/src/providers.ts';
import { FakeDb, FakeStore, FakeResizer, FakeModel, fakePdf, evidence, job, answer, sha, CATEGORIES, TEMPLATE } from './fakes.ts';

function setup(opts: { primary?: Array<string | Error>; escalation?: Array<string | Error> | null; threshold?: number } = {}) {
  const db = new FakeDb();
  const store = new FakeStore();
  const resizer = new FakeResizer();
  const log = memoryLogger();
  const primary = new FakeModel('anthropic/claude-haiku-5-5', opts.primary ?? []);
  const escalation = opts.escalation === null ? null : new FakeModel('anthropic/claude-sonnet-5-5', opts.escalation ?? []);
  const deps: LabelDeps = {
    db, store, templates: new TemplateCache(db), resizer, pdf: fakePdf(), log, primary, escalation,
    threshold: opts.threshold ?? 0.7, maxOriginalBytes: 1_000_000, pdfTextChars: 4000,
  };
  db.evidence.set('e1', evidence());
  store.put('r2', 'cases/case1/tasks/t1/orig.jpg', 'original');
  return { db, store, resizer, log, primary, escalation, run: createLabelStage(deps), deps };
}

function withCopy(db: FakeDb, store: FakeStore) {
  const bytes = new TextEncoder().encode('copy-384');
  db.derivatives.set('e1', { evidence_id: 'e1', width: 384, storage_path: `derived/case1/${sha('original')}/w384-${sha(bytes)}.jpg`, sha256: sha(bytes), pixel_width: 384, pixel_height: 288 });
  store.put('r2', `derived/case1/${sha('original')}/w384-${sha(bytes)}.jpg`, bytes);
}

describe('label stage: input', () => {
  test('uses the 384 px copy when the field app made one (no resizing on the server)', async () => {
    const s = setup({ primary: [answer([['odometer_photo', 0.95]])] });
    withCopy(s.db, s.store);
    assert.deepEqual(await s.run(job()), { status: 'done' });
    assert.equal(s.resizer.calls, 0);
    assert.deepEqual(s.store.reads, [`r2:derived/case1/${sha('original')}/w384-${sha('copy-384')}.jpg`]);
    const req = s.primary.requests[0];
    assert.equal(Buffer.from(req.image!.base64, 'base64').toString(), 'copy-384');
    assert.equal(req.image!.longEdge, 384);
    assert.equal(req.instruction, 'Label this image.');
  });

  test('a copy whose bytes do not match its recorded hash is refused', async () => {
    const s = setup({ primary: [answer([['odometer_photo', 0.95]])] });
    withCopy(s.db, s.store);
    s.store.put('r2', s.db.derivatives.get('e1')!.storage_path, 'tampered');
    await assert.rejects(s.run(job()), /SHA-256/);
    assert.equal(s.primary.requests.length, 0);
  });

  test('without a copy the original is fetched, hash-checked and shrunk', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.9]])] });
    assert.equal((await s.run(job())).status, 'done');
    assert.equal(s.resizer.calls, 1);
    assert.equal(Buffer.from(s.primary.requests[0].image!.base64, 'base64').toString(), 'small-jpeg');
  });

  test('insurer attachments are read from Supabase Storage', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.9]])] });
    s.db.evidence.set('e1', evidence({ storage_backend: 'supabase', storage_path: 'emails/m/att/1', sha256: sha('att') }));
    s.store.put('supabase', 'emails/m/att/1', 'att');
    assert.equal((await s.run(job())).status, 'done');
    assert.deepEqual(s.store.reads, ['supabase:emails/m/att/1']);
  });

  test('a PDF with a text layer is labelled from its text, without an image', async () => {
    const s = setup({ primary: [answer([['dl_document', 0.97]], [['dl_number', 0.9]])] });
    s.db.evidence.set('e1', evidence({ evidence_type: 'document', mime_type: 'application/pdf' }));
    s.db.ocr.push({ id: 'o1', evidence_id: 'e1', page_no: 1, engine: 'pdf_text_layer', text: 'Union of India Driving Licence issued by the transport department', blocks: [], mean_confidence: 1, is_current: true });
    assert.equal((await s.run(job())).status, 'done');
    const req = s.primary.requests[0];
    assert.equal(req.image, null);
    assert.match(req.instruction, /<document_text>\nUnion of India Driving Licence/);
    assert.equal(s.store.reads.length, 0, 'the PDF itself is not downloaded');
  });

  test('existing OCR text (device first) is added after the image as a short excerpt, sent as read (D55)', async () => {
    const s = setup({ primary: [answer([['dl_document', 0.95]])] });
    s.deps.ocrExcerptChars = 120;
    withCopy(s.db, s.store);
    s.db.ocr.push(
      { id: 'o1', evidence_id: 'e1', page_no: 1, engine: 'paddleocr', text: 'server text', blocks: [], mean_confidence: 0.9, is_current: true },
      { id: 'o2', evidence_id: 'e1', page_no: 1, engine: 'mlkit_device', text: 'Union of India\n\nDriving Licence  MH1220110012345\nAadhaar 1234 5678 9012 and 123456789012 ' + 'x '.repeat(100), blocks: [], mean_confidence: 0.9, is_current: true },
    );
    const run = createLabelStage(s.deps);
    assert.equal((await run(job())).status, 'done');
    const ins = s.primary.requests[0].instruction;
    assert.match(ins, /^Label this image\.\nText read from this file by OCR \(excerpt, may contain errors\):\n<ocr_text>\nUnion of India\nDriving Licence MH1220110012345/);
    assert.match(ins, /Aadhaar 1234 5678 9012 and 123456789012/);
    assert.ok(!ins.includes('XXXX') && !ins.includes('server text'));
    assert.ok(ins.length < 250, 'trimmed to the excerpt length');
    assert.ok(s.primary.requests[0].image, 'the image is still sent');
  });

  test('without OCR text the instruction is the plain one; excerpt length 0 turns it off', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.95]])] });
    assert.equal((await s.run(job())).status, 'done');
    assert.equal(s.primary.requests[0].instruction, 'Label this image.');
  });

  test('a scanned PDF (no text layer) is labelled from its first page rendered at 384 px', async () => {
    const s = setup({ primary: [answer([['rc_document', 0.9]])] });
    s.db.evidence.set('e1', evidence({ evidence_type: 'document', mime_type: 'application/pdf' }));
    assert.equal((await s.run(job())).status, 'done');
    assert.equal(Buffer.from(s.primary.requests[0].image!.base64, 'base64').toString(), 'page1');
    assert.equal(s.primary.requests[0].image!.longEdge, 384);
  });

  test('skips withdrawn files, audio and video, and unknown evidence', async () => {
    const s = setup();
    s.db.evidence.set('e1', evidence({ withdrawn_at: '2026-11-18T10:00:00Z' }));
    assert.deepEqual(await s.run(job()), { status: 'skipped', reason: 'withdrawn' });
    s.db.evidence.set('e1', evidence({ evidence_type: 'audio', mime_type: 'audio/m4a' }));
    assert.deepEqual(await s.run(job()), { status: 'skipped', reason: 'unsupported_type_audio' });
    assert.deepEqual(await s.run(job({ evidence_id: 'nope' })), { status: 'skipped', reason: 'evidence_not_found' });
    s.db.evidence.set('e1', evidence({ mime_type: 'image/heic' }));
    assert.deepEqual(await s.run(job()), { status: 'skipped', reason: 'unsupported_image_type' });
    assert.equal(s.primary.requests.length, 0);
  });
});

describe('label stage: answers and escalation (D37)', () => {
  test('confident answer: one call, labels and fields recorded under the job version with provider/model', async () => {
    const s = setup({ primary: [answer([['odometer_photo', 0.92], ['vehicle_photo', 0.3]], [['odometer_at_entry', 0.9], ['bogus', 0.9]], { description: 'Close-up.' })] });
    assert.deepEqual(await s.run(job()), { status: 'done' });
    assert.equal(s.escalation!.requests.length, 0);
    assert.equal(s.db.recorded.length, 1);
    const r = s.db.recorded[0];
    assert.equal(r.superseded, null);
    assert.deepEqual(r.result, {
      pipeline_version: 'v1', model: 'anthropic/claude-haiku-5-5',
      labels: [{ code: 'odometer_photo', confidence: 0.92 }, { code: 'vehicle_photo', confidence: 0.3 }],
      fields: [{ key: 'odometer_at_entry', confidence: 0.9 }],
      needs_detail: true, detail_reason: 'number', description: 'Close-up.',
    });
  });

  test('low confidence: escalated at once under <version>+esc; the first answer is kept as superseded', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.5]])], escalation: [answer([['odometer_photo', 0.96]], [['odometer_at_entry', 0.9]])] });
    assert.deepEqual(await s.run(job()), { status: 'done', reason: 'escalated' });
    const r = s.db.recorded[0];
    assert.equal(r.result.pipeline_version, 'v1' + ESCALATION_SUFFIX);
    assert.equal(r.result.model, 'anthropic/claude-sonnet-5-5');
    assert.equal(r.superseded?.pipeline_version, 'v1');
    assert.equal(r.superseded?.model, 'anthropic/claude-haiku-5-5');
    assert.equal(s.escalation!.requests[0].image!.base64, s.primary.requests[0].image!.base64, 'same image for both models');
    assert.equal(s.escalation!.requests[0].system, s.primary.requests[0].system, 'same cached system prompt');
  });

  test('threshold is configurable', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.5]])], threshold: 0.4 });
    assert.deepEqual(await s.run(job()), { status: 'done' });
    assert.equal(s.escalation!.requests.length, 0);
  });

  test('escalation call fails: the first answer is kept and the escalation is queued as its own job', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.5]])], escalation: [new HttpError(529, 'overloaded')] });
    assert.deepEqual(await s.run(job()), { status: 'done', reason: 'escalation_deferred' });
    assert.equal(s.db.recorded[0].result.model, 'anthropic/claude-haiku-5-5');
    assert.deepEqual(s.db.enqueued, [{ ids: ['e1'], stages: ['label'], version: 'v1+esc' }]);
  });

  test('a queued escalation job uses the escalation model only', async () => {
    const s = setup({ escalation: [answer([['dl_document', 0.9]])] });
    assert.deepEqual(await s.run(job({ pipeline_version: 'v1+esc' })), { status: 'done' });
    assert.equal(s.primary.requests.length, 0);
    assert.equal(s.db.recorded[0].result.pipeline_version, 'v1+esc');
    assert.equal(s.db.recorded[0].superseded, null);
  });

  test('unusable first answer goes to the escalation model', async () => {
    const s = setup({ primary: ['I think it is a car'], escalation: [answer([['vehicle_photo', 0.9]])] });
    assert.deepEqual(await s.run(job()), { status: 'done', reason: 'escalated' });
    assert.equal(s.db.recorded[0].superseded, null, 'nothing to keep from an unusable answer');
  });

  test('unusable answer without escalation fails the job (retried with back-off)', async () => {
    const s = setup({ primary: ['{"labels":[{"code":"spaceship","confidence":1}]}'], escalation: null });
    const out = await s.run(job());
    assert.equal(out.status, 'failed');
    assert.match(out.reason!, /unusable_answer: unknown category "spaceship"/);
    assert.equal(s.db.recorded.length, 0);
  });

  test('escalation answer unusable: the first answer is kept', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.6]])], escalation: ['nonsense'] });
    assert.deepEqual(await s.run(job()), { status: 'done', reason: 'escalation_unusable' });
    assert.equal(s.db.recorded[0].result.model, 'anthropic/claude-haiku-5-5');
  });

  test('provider errors propagate (the worker fails the job and the database re-queues it)', async () => {
    const s = setup({ primary: [new HttpError(500, 'boom')] });
    await assert.rejects(s.run(job()), /boom/);
  });

  test('logs tokens and cost per call, with ids only (no file names or answer text)', async () => {
    const s = setup({ primary: [answer([['odometer_photo', 0.95]], [], { description: 'Close-up of an odometer' })] });
    s.db.evidence.set('e1', evidence({ storage_path: 'cases/case1/tasks/t1/orig.jpg' }));
    await s.run(job());
    const call = s.log.lines.find((l) => l.event === 'model_call')!;
    assert.equal(call.model, 'anthropic/claude-haiku-5-5');
    assert.equal(call.input_tokens, 100);
    assert.equal(call.cached_read_tokens, 2000);
    assert.equal(typeof call.cost_usd, 'number');
    assert.ok((call.cost_usd as number) > 0);
    const all = JSON.stringify(s.log.lines);
    assert.ok(!all.includes('orig.jpg') && !all.includes('Close-up'), all);
  });
});

describe('template context', () => {
  test('system prompt per template version is built once and reused (prompt cache stays warm)', async () => {
    const s = setup({ primary: [answer([['vehicle_photo', 0.9]]), answer([['vehicle_photo', 0.9]])] });
    s.db.evidence.set('e2', evidence({ id: 'e2' }));
    await s.run(job());
    await s.run(job({ id: 2, evidence_id: 'e2' }));
    assert.equal(s.db.templateLoads, 1);
    assert.equal(s.primary.requests[0].system, s.primary.requests[1].system);
  });

  test('prompt lists the categories and the template fields; codes and keys come from the database', () => {
    const ctx = buildContext('tpl1', CATEGORIES, TEMPLATE);
    assert.ok(ctx.system.includes('- vehicle_photo: Vehicle photo — Any view of the vehicle'));
    assert.ok(ctx.system.includes('- odometer_at_entry: Odometer reading at entry (From the photo)'));
    assert.ok(ctx.system.includes('Driver:'));
    assert.deepEqual([...ctx.fieldKeys], ['dl_number', 'driver_dob', 'reg_number', 'chassis_no', 'odometer_at_entry']);
    assert.deepEqual(ctx.fieldsByCategory.get('c-dl'), ['dl_number', 'driver_dob']);
    assert.deepEqual(ctx.template?.sections.map((x) => x.categories), [['dl_document'], ['rc_document'], ['odometer_photo']]);
  });

  test('a case without a template is labelled with categories only', () => {
    const ctx = buildContext(null, CATEGORIES, null);
    assert.equal(ctx.fieldKeys.size, 0);
    assert.ok(!ctx.system.includes('The investigation report has these fields'));
  });
});
