// End-to-end on the LOCAL Supabase stack with the manual stand-in model (no model API, nothing leaves the
// machine). The test plays the person answering the manual requests.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local service_role key> \
//     npm run test:integration -w services/pipeline
//
// Run it under the shared lock (other agents use the same stack); it adds one photo and one PDF to a seeded
// case and lets the worker process every queued job (seeded files do not exist in storage: their jobs fail
// and are re-queued, which is harmless; `db reset` restores the seed).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { createSupabaseDb } from '../../src/db.ts';
import { createObjectStore } from '../../src/storage.ts';
import { createPdfTools, createSharpResizer } from '../../src/media.ts';
import { createManualModel } from '../../src/models.ts';
import { TemplateCache } from '../../src/template-context.ts';
import { createNoneEngine } from '../../src/ocr-engine.ts';
import { createLabelStage } from '../../src/stages/label.ts';
import { createTextExtractStage } from '../../src/stages/text-extract.ts';
import { createOcrStage } from '../../src/stages/ocr.ts';
import { createFieldSuggestStage } from '../../src/stages/field-suggest.ts';
import { Worker } from '../../src/worker.ts';
import { createLogger } from '../../src/log.ts';
import { makePdf } from '../minipdf.ts';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = !URL_ || !KEY || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(URL_) ? 'needs SUPABASE_URL (local stack only) and SUPABASE_SERVICE_ROLE_KEY' : false;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('pipeline on the local stack (manual model)', { skip }, () => {
  let sb: SupabaseClient;
  let worker: Worker;
  let manualDir: string;
  let stopAnswering = false;
  let answering: Promise<void>;
  const photoId = randomUUID();
  const pdfId = randomUUID();
  let caseId = '';

  async function jobsOf(id: string) {
    const { data, error } = await sb.from('processing_jobs').select('stage, status, pipeline_version, last_error').eq('evidence_id', id).order('id');
    if (error) throw error;
    return data ?? [];
  }
  async function settled(ids: string[], timeoutMs = 60_000) {
    const t0 = Date.now();
    for (;;) {
      const jobs = (await Promise.all(ids.map(jobsOf))).flat();
      if (jobs.length && jobs.every((j) => j.status !== 'queued' && j.status !== 'running')) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`jobs not settled: ${JSON.stringify(jobs)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  before(async () => {
    sb = createClient(URL_ as string, KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    // a seeded case whose template has the DL fields
    const { data: fields } = await sb.from('case_template_fields').select('template_id').eq('key', 'dl_number');
    const tpl = [...new Set((fields ?? []).map((f) => f.template_id))];
    const { data: cases, error } = await sb.from('cases').select('id, office_owner_id, template_id').in('template_id', tpl).not('office_owner_id', 'is', null).limit(1);
    if (error || !cases?.length) throw new Error('no seeded case with a template (run supabase db reset)');
    caseId = cases[0].id;

    const photo = new Uint8Array(await sharp({ create: { width: 640 + Math.floor(Math.random() * 300), height: 480, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 90, b: 140 } } }).jpeg().toBuffer());
    const pdf = makePdf([['Union of India Driving Licence', `DL No. MH12 2011${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, 'Transport Department']]);
    for (const [id, bytes, type, ext] of [[photoId, photo, 'image/jpeg', 'jpg'], [pdfId, pdf, 'application/pdf', 'pdf']] as const) {
      const path = `pipeline-it/${id}.${ext}`;
      const up = await sb.storage.from('email-raw').upload(path, bytes, { contentType: type });
      if (up.error) throw up.error;
      const ins = await sb.from('evidence').insert({
        id, case_id: caseId, evidence_type: ext === 'pdf' ? 'document' : 'photo', capture_source: 'web_upload', storage_backend: 'supabase',
        storage_path: path, mime_type: type, sha256: sha(bytes), size_bytes: bytes.byteLength, captured_by: cases[0].office_owner_id,
      });
      if (ins.error) throw ins.error;
    }

    manualDir = await mkdtemp(join(tmpdir(), 'pipeline-manual-'));
    const db = createSupabaseDb(sb);
    const store = createObjectStore({ r2: null, supabase: sb });
    const pdfTools = createPdfTools();
    const templates = new TemplateCache(db);
    const log = createLogger({ level: 'error' });
    const model = createManualModel({ dir: manualDir, name: 'it', pollMs: 100, timeoutMs: 15_000 });
    worker = new Worker(db, {
      text_extract: createTextExtractStage({ db, store, pdf: pdfTools, log, maxBytes: 5e6, maxPages: 5 }),
      label: createLabelStage({ db, store, templates, resizer: createSharpResizer(), pdf: pdfTools, log, primary: model, escalation: null, threshold: 0.7, maxOriginalBytes: 5e6, pdfTextChars: 4000 }),
      ocr: createOcrStage({ db, store, engine: createNoneEngine(), log, maxBytes: 5e6, maxPages: 5, deviceMinConfidence: 0.85 }),
      field_suggest: createFieldSuggestStage({ db, templates, log, minMatchScore: 0.3 }),
    }, log, { workerId: 'it-worker', stages: ['text_extract', 'label', 'ocr', 'field_suggest'], concurrency: 8, pollMs: 100, maxIdleMs: 500, staleMinutes: 30, shutdownGraceMs: 2000 });
    void worker.start();

    // the "person": answers only this test's files
    answering = (async () => {
      while (!stopAnswering) {
        for (const f of await readdir(join(manualDir, 'requests')).catch(() => [] as string[])) {
          if (!f.endsWith('.json')) continue;
          const meta = JSON.parse(await readFile(join(manualDir, 'requests', f), 'utf8'));
          let answer: unknown = null;
          if (meta.evidence_id === photoId) {
            answer = { labels: [{ code: 'odometer_photo', confidence: 0.95 }], fields: meta.fields.includes('odometer_at_entry') ? [{ key: 'odometer_at_entry', confidence: 0.9 }] : [],
                       needs_detail: true, detail_reason: 'odometer reading', description: 'Plain test image.' };
          } else if (meta.evidence_id === pdfId) {
            const text = await readFile(join(manualDir, meta.attachment), 'utf8');
            assert.match(text, /Driving Licence/);
            answer = { model: 'anthropic/claude-opus-5-5', labels: [{ code: 'dl_document', confidence: 0.97 }], fields: [{ key: 'dl_number', confidence: 0.95 }], needs_detail: true, detail_reason: 'DL number', description: null };
          }
          if (answer) await writeFile(join(manualDir, 'answers', `${meta.request_id}.json`), JSON.stringify(answer));
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
  });

  after(async () => {
    stopAnswering = true;
    await answering;
    await worker?.stop();
  });

  test('photo: labelled by the manual model, OCR skipped (no engine), no suggestions without OCR text', async () => {
    await settled([photoId]);
    const jobs = await jobsOf(photoId);
    assert.deepEqual(jobs.map((j) => `${j.stage}:${j.status}`), ['ocr:skipped', 'label:done', 'field_suggest:skipped']);
    assert.equal(jobs.find((j) => j.stage === 'ocr')?.last_error, 'no_ocr_engine_configured');
    assert.equal(jobs.find((j) => j.stage === 'field_suggest')?.last_error, 'no_ocr_text');
    const { data: labels } = await sb.from('evidence_labels').select('source, is_active, model, pipeline_version, needs_detail, description, evidence_categories(code)').eq('evidence_id', photoId);
    assert.equal(labels?.length, 1);
    assert.deepEqual({ ...labels![0], evidence_categories: undefined }, { source: 'llm', is_active: true, model: 'manual/it', pipeline_version: 'v1', needs_detail: true, description: 'Plain test image.', evidence_categories: undefined });
    const { data: state } = await sb.from('v_evidence_processing').select('state').eq('evidence_id', photoId).single();
    assert.equal(state?.state, 'done', 'field app shows the double tick');
  });

  test('PDF: text layer extracted, labelled from its text, OCR skipped, DL number suggested', async () => {
    await settled([pdfId]);
    const jobs = await jobsOf(pdfId);
    assert.deepEqual(jobs.map((j) => `${j.stage}:${j.status}`).sort(), ['field_suggest:done', 'label:done', 'ocr:skipped', 'text_extract:done']);
    const { data: ocr } = await sb.from('evidence_ocr').select('engine, text, is_current').eq('evidence_id', pdfId);
    assert.equal(ocr?.[0].engine, 'pdf_text_layer');
    assert.match(ocr?.[0].text ?? '', /Driving Licence/);
    const { data: lab } = await sb.from('evidence_labels').select('model, evidence_categories(code)').eq('evidence_id', pdfId).eq('is_active', true);
    assert.equal(lab?.[0].model, 'anthropic/claude-opus-5-5', 'the answer names the model that stood in');
    const { data: matches } = await sb.from('evidence_field_matches').select('score, case_template_fields(key)').eq('evidence_id', pdfId);
    assert.equal(matches?.length, 1);
    const { data: sugg } = await sb.from('field_suggestions').select('value, status, source, case_template_fields(key)').eq('evidence_id', pdfId);
    const dl = (sugg ?? []).find((s: any) => s.case_template_fields?.key === 'dl_number');
    assert.match(dl?.value ?? '', /^MH122011\d{7}$/);
    assert.equal(dl?.status, 'pending');
  });

  test('re-running the label stage (new pipeline version) keeps one active LLM answer', async () => {
    const { error } = await sb.rpc('enqueue_reprocessing', { p_evidence_ids: [photoId], p_stages: ['label'], p_pipeline_version: 'v2' });
    assert.equal(error, null);
    worker.poke();
    await settled([photoId]);
    const { data: labels } = await sb.from('evidence_labels').select('is_active, pipeline_version').eq('evidence_id', photoId).order('created_at');
    assert.deepEqual(labels?.map((l) => `${l.pipeline_version}:${l.is_active}`), ['v1:false', 'v2:true']);
  });
});
