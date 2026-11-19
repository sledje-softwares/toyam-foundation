// `text_extract` stage (6.2): the PDF text layer into evidence_ocr (engine pdf_text_layer), one row per page
// that has text. `skipped` when the file is not a PDF or has no text layer (a scan: OCR handles it).
import type { PipelineDb } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { getVerified } from '../storage.ts';
import type { PdfTools } from '../media.ts';
import { isPdf } from '../media.ts';
import type { Logger } from '../log.ts';
import type { Job, StageOutcome } from '../types.ts';

export const PDF_TEXT_ENGINE = 'pdf_text_layer';

export function createTextExtractStage(deps: { db: PipelineDb; store: ObjectStore; pdf: PdfTools; log: Logger; maxBytes: number; maxPages: number }) {
  return async function textExtract(job: Job, signal?: AbortSignal): Promise<StageOutcome> {
    const ev = await deps.db.getEvidence(job.evidence_id);
    if (!ev) return { status: 'skipped', reason: 'evidence_not_found' };
    if (ev.withdrawn_at) return { status: 'skipped', reason: 'withdrawn' };
    if (!isPdf(ev.mime_type)) return { status: 'skipped', reason: 'not_pdf' };
    if (!ev.storage_path) return { status: 'skipped', reason: 'no_file' };
    const bytes = await getVerified(deps.store, ev.storage_backend, ev.storage_path, ev.sha256, { maxBytes: deps.maxBytes, signal });
    const { pages, pageCount } = await deps.pdf.textPages(bytes, deps.maxPages);
    const withText = pages.filter((p) => p.text.trim().length > 0);
    if (withText.length === 0) return { status: 'skipped', reason: 'no_text_layer' };
    await deps.db.insertOcr(withText.map((p) => ({
      evidence_id: ev.id,
      page_no: p.page_no,
      engine: PDF_TEXT_ENGINE,
      engine_version: deps.pdf.version,
      lang: null,
      text: p.text,
      blocks: p.blocks,
      mean_confidence: 1,
    })));
    deps.log.log('info', 'text_extracted', { job_id: job.id, evidence_id: ev.id, pages: withText.length, page_count: pageCount, truncated: pageCount > deps.maxPages });
    return { status: 'done' };
  };
}
