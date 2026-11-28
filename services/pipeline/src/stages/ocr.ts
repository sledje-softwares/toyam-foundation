// `ocr` stage (6.3, D34): server OCR only where ocr_wanted(); a PDF text layer or good device OCR (ML Kit,
// sent with the file) is used instead. Reads the original at full resolution (OCR needs the detail).
import type { PipelineDb } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { getVerified } from '../storage.ts';
import type { OcrEngine } from '../ocr-engine.ts';
import { OCR_MIME } from '../ocr-engine.ts';
import type { Logger } from '../log.ts';
import type { Job, StageOutcome } from '../types.ts';
import { PDF_TEXT_ENGINE } from './text-extract.ts';

export const DEVICE_OCR_ENGINE = 'mlkit_device';

export function isDeviceEngine(engine: string): boolean {
  return engine === DEVICE_OCR_ENGINE || /device|mlkit/i.test(engine);
}

export function createOcrStage(deps: {
  db: PipelineDb;
  store: ObjectStore;
  engine: OcrEngine;
  log: Logger;
  maxBytes: number;
  maxPages: number;
  deviceMinConfidence: number;         // device OCR at or above this mean confidence is good enough
}) {
  return async function ocr(job: Job, signal?: AbortSignal): Promise<StageOutcome> {
    const ev = await deps.db.getEvidence(job.evidence_id);
    if (!ev) return { status: 'skipped', reason: 'evidence_not_found' };
    if (ev.withdrawn_at) return { status: 'skipped', reason: 'withdrawn' };
    const [wanted, current] = await Promise.all([deps.db.ocrWanted(ev.id), deps.db.getCurrentOcr(ev.id)]);
    if (!wanted) return { status: 'skipped', reason: 'ocr_not_wanted' };
    if (current.some((r) => r.engine === PDF_TEXT_ENGINE && r.text.trim() !== '')) return { status: 'skipped', reason: 'pdf_text_layer' };
    // OCR of field files runs on the phone (ML Kit on the 1600 px copy, engine mlkit_device): a current device
    // row counts as done unless its mean confidence is below the threshold (no confidence reported = done)
    if (current.some((r) => isDeviceEngine(r.engine) && (r.mean_confidence === null || r.mean_confidence >= deps.deviceMinConfidence))) {
      return { status: 'skipped', reason: 'device_ocr_present' };
    }
    if (deps.engine.name === 'none') return { status: 'skipped', reason: deps.engine.reason ?? 'no_ocr_engine_configured' };
    const mime = (ev.mime_type ?? '').toLowerCase();
    if (!OCR_MIME.has(mime)) return { status: 'skipped', reason: 'unsupported_type_for_ocr' };
    if (!ev.storage_path) return { status: 'skipped', reason: 'no_file' };

    const bytes = await getVerified(deps.store, ev.storage_backend, ev.storage_path, ev.sha256, { maxBytes: deps.maxBytes, signal });
    const t0 = Date.now();
    const out = await deps.engine.read(bytes, mime, { maxPages: deps.maxPages, signal });
    if (!out) return { status: 'skipped', reason: deps.engine.reason ?? 'no_ocr_engine_configured' };
    const pages = out.pages.filter((p) => p.text.trim() !== '' || p.blocks.length > 0);
    await deps.db.insertOcr(pages.map((p) => ({
      evidence_id: ev.id, page_no: p.page_no, engine: out.engine, engine_version: out.engine_version, lang: out.lang,
      text: p.text, blocks: p.blocks, mean_confidence: p.mean_confidence,
    })));
    deps.log.log('info', 'ocr_done', { job_id: job.id, evidence_id: ev.id, engine: out.engine, pages: pages.length, blocks: pages.reduce((s, p) => s + p.blocks.length, 0), ms: Date.now() - t0 });
    return pages.length ? { status: 'done' } : { status: 'done', reason: 'no_text_found' };
  };
}
