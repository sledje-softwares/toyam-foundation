// `label` stage (D30, D34, D35, D37): one vision call per file at ~384 px with the per-template prompt;
// labels + field matches + needs_detail + a description only where useful. Low confidence goes straight to
// the escalation model under `<version>+esc`; the first model's labels are kept inactive.
import { parseLabelAnswer, USER_INSTRUCTION } from '../../../labeller/src/prompt.ts';
import type { LabelAnswer } from '../../../labeller/src/prompt.ts';
import type { ImageInput } from '../../../labeller/src/providers.ts';
import { costOf } from '../../../labeller/src/prices.ts';
import type { PipelineDb } from '../db.ts';
import type { ObjectStore } from '../storage.ts';
import { getVerified } from '../storage.ts';
import type { ImageResizer, PdfTools } from '../media.ts';
import { isPdf, RESIZABLE_MIME } from '../media.ts';
import type { LabelModel, LabelReply } from '../models.ts';
import type { TemplateCache, TemplateContext } from '../template-context.ts';
import type { Logger } from '../log.ts';
import { errorText } from '../log.ts';
import type { Evidence, Job, LabelResult, OcrRow, StageOutcome } from '../types.ts';

export const ESCALATION_SUFFIX = '+esc';
export const LABEL_EDGE = 384;
/** PDFs with at least this much text are labelled from their text layer instead of a rendered page. */
export const MIN_PDF_TEXT = 40;

export interface LabelDeps {
  db: PipelineDb;
  store: ObjectStore;
  templates: TemplateCache;
  resizer: ImageResizer;
  pdf: PdfTools;
  log: Logger;
  primary: LabelModel;
  escalation: LabelModel | null;
  threshold: number;                   // escalate when the top confidence is below this (D37)
  maxOriginalBytes: number;            // originals fetched for resizing / PDF text
  pdfTextChars: number;                // PDF text sent to the model, at most
  ocrExcerptChars?: number;            // OCR excerpt added after the image (default 600; 0 = off)
}

export function isEscalationVersion(v: string): boolean {
  return v.endsWith(ESCALATION_SUFFIX);
}

interface Input {
  image: ImageInput | null;
  instruction: string;
  source: 'copy' | 'resized_original' | 'pdf_text' | 'pdf_render';
}

/** Trim to `max` characters at a word boundary, collapsing runs of spaces and blank lines. */
export function excerpt(text: string, max: number): string {
  const t = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + ' …';
}

/**
 * OCR text the file already has (device OCR from the phone, server OCR or the PDF text layer), as an excerpt for
 * the label request: it lets a 384 px screenshot of a document be labelled correctly. Device OCR first.
 */
export function ocrExcerpt(rows: OcrRow[], max: number): string | null {
  if (max <= 0) return null;
  const rank = (e: string) => (/device|mlkit/i.test(e) ? 0 : e === 'pdf_text_layer' ? 2 : 1);
  const best = [...rows].filter((r) => r.text.trim() !== '').sort((a, b) => rank(a.engine) - rank(b.engine) || a.page_no - b.page_no);
  if (best.length === 0) return null;
  const engine = best[0].engine;
  const text = best.filter((r) => r.engine === engine).map((r) => r.text).join('\n');
  return excerpt(text, max);
}

// Operator comments on the file (D54) are never sent here: they are for the office and the report drafting step.
function withOcr(instruction: string, rows: OcrRow[], max: number): string {
  const ex = ocrExcerpt(rows, max);
  return ex ? `${instruction}\nText read from this file by OCR (excerpt, may contain errors):\n<ocr_text>\n${ex}\n</ocr_text>` : instruction;
}

/** Choose what the model sees: the field app's 384 px copy, else the original shrunk here, else PDF text / page 1. */
export async function prepareInput(ev: Evidence, deps: Pick<LabelDeps, 'db' | 'store' | 'resizer' | 'pdf' | 'maxOriginalBytes' | 'pdfTextChars' | 'ocrExcerptChars'>,
                                   signal?: AbortSignal): Promise<Input | { skip: string }> {
  if (!ev.storage_path) return { skip: 'no_file' };
  // whatever OCR exists now (device OCR may arrive after this job was claimed: then it is simply not used)
  const [ocr, copy] = await Promise.all([
    deps.db.getCurrentOcr(ev.id),
    isPdf(ev.mime_type) ? Promise.resolve(null) : deps.db.getDerivative(ev.id, LABEL_EDGE),
  ]);
  const excerptChars = deps.ocrExcerptChars ?? 600;
  if (isPdf(ev.mime_type)) {
    const text = ocr.filter((r) => r.engine === 'pdf_text_layer').map((r) => r.text).join('\n\n').trim();
    if (text.length >= MIN_PDF_TEXT) {
      return {
        image: null,
        source: 'pdf_text',
        instruction: [
          'This file is a PDF document; instead of an image, here is the text of its first pages.',
          'Label it with the same rules and answer format.',
          '<document_text>',
          text.slice(0, deps.pdfTextChars),
          '</document_text>',
        ].join('\n'),
      };
    }
    const bytes = await getVerified(deps.store, ev.storage_backend, ev.storage_path, ev.sha256, { maxBytes: deps.maxOriginalBytes, signal });
    const page = await deps.pdf.renderFirstPage(bytes, LABEL_EDGE);
    if (!page) return { skip: 'pdf_without_text_layer_no_renderer' };
    return { image: { base64: b64(page.bytes), mimeType: 'image/jpeg', longEdge: Math.max(page.width, page.height) }, instruction: withOcr(USER_INSTRUCTION, ocr, excerptChars), source: 'pdf_render' };
  }
  if (copy) {
    // copies sit next to the field files (R2 today; D53 adds a backend column when evidence moves)
    const bytes = await getVerified(deps.store, 'r2', copy.storage_path, copy.sha256, { maxBytes: 2_000_000, signal });
    const edge = Math.max(copy.pixel_width ?? LABEL_EDGE, copy.pixel_height ?? 0) || LABEL_EDGE;
    return { image: { base64: b64(bytes), mimeType: 'image/jpeg', longEdge: edge }, instruction: withOcr(USER_INSTRUCTION, ocr, excerptChars), source: 'copy' };
  }
  if (!RESIZABLE_MIME.has((ev.mime_type ?? '').toLowerCase())) return { skip: 'unsupported_image_type' };
  const bytes = await getVerified(deps.store, ev.storage_backend, ev.storage_path, ev.sha256, { maxBytes: deps.maxOriginalBytes, signal });
  const small = await deps.resizer.toJpeg(bytes, LABEL_EDGE);
  return { image: { base64: b64(small.bytes), mimeType: 'image/jpeg', longEdge: Math.max(small.width, small.height) }, instruction: withOcr(USER_INSTRUCTION, ocr, excerptChars), source: 'resized_original' };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function toResult(a: LabelAnswer, model: string, version: string): LabelResult {
  return {
    pipeline_version: version,
    model,
    labels: a.labels.map((l) => ({ code: l.code, confidence: l.confidence })),
    fields: a.fields.map((f) => ({ key: f.key, confidence: f.confidence })),
    needs_detail: a.needs_detail,
    detail_reason: a.detail_reason,
    description: a.description,
  };
}

export function createLabelStage(deps: LabelDeps) {
  async function ask(model: LabelModel, role: 'primary' | 'escalation', job: Job, ev: Evidence, ctx: TemplateContext, input: Input,
                     version: string, signal?: AbortSignal): Promise<{ reply: LabelReply; answer: LabelAnswer }> {
    let reply: LabelReply;
    try {
      reply = await model.label({
        requestId: `${ev.id}.${version}`,
        system: ctx.system,
        instruction: input.instruction,
        image: input.image,
        meta: { evidence_id: ev.id, template_id: ctx.templateId, pipeline_version: version, categories: [...ctx.codes], fields: [...ctx.fieldKeys] },
        signal,
      });
    } catch (err) {
      deps.log.log('warn', 'model_call', { job_id: job.id, evidence_id: ev.id, stage: 'label', role, model: model.key, ok: false, error: errorText(err) });
      throw err;
    }
    const answer = parseLabelAnswer(reply.text, ctx.codes, ctx.fieldKeys);
    const u = reply.usage;
    deps.log.log('info', 'model_call', {
      job_id: job.id, evidence_id: ev.id, stage: 'label', role, model: reply.model, input_source: input.source,
      ok: answer.ok, parse_error: answer.error ? answer.error.slice(0, 200) : undefined,
      top_confidence: answer.labels[0]?.confidence ?? null,
      input_tokens: u?.input, cached_read_tokens: u?.cachedRead, cache_write_tokens: u?.cacheWrite, output_tokens: u?.output,
      cost_usd: u ? costOf(reply.model, u) : null, latency_ms: reply.latencyMs,
    });
    return { reply, answer };
  }

  return async function label(job: Job, signal?: AbortSignal): Promise<StageOutcome> {
    const ev = await deps.db.getEvidence(job.evidence_id);
    if (!ev) return { status: 'skipped', reason: 'evidence_not_found' };
    if (ev.withdrawn_at) return { status: 'skipped', reason: 'withdrawn' };
    if (ev.evidence_type !== 'photo' && ev.evidence_type !== 'document') return { status: 'skipped', reason: `unsupported_type_${ev.evidence_type}` };

    const [ctx, input] = await Promise.all([deps.templates.get(ev.template_id), prepareInput(ev, deps, signal)]);
    if ('skip' in input) return { status: 'skipped', reason: input.skip };

    const v = job.pipeline_version;
    // a queued escalation (the immediate one failed earlier): the escalation model only
    if (isEscalationVersion(v)) {
      const model = deps.escalation ?? deps.primary;
      const { reply, answer } = await ask(model, 'escalation', job, ev, ctx, input, v, signal);
      if (!answer.ok) return { status: 'failed', reason: `unusable_answer: ${answer.error ?? ''}`.slice(0, 300) };
      const out = await deps.db.recordLlmLabels(ev.id, toResult(answer, reply.model, v));
      deps.log.log('info', 'labels_recorded', { job_id: job.id, evidence_id: ev.id, version: v, labels: out.labels, field_matches: out.field_matches, held_for_review: out.held_for_review });
      return { status: 'done' };
    }

    const first = await ask(deps.primary, 'primary', job, ev, ctx, input, v, signal);
    const top = first.answer.labels[0]?.confidence ?? 0;
    const wantEscalation = deps.escalation !== null && (!first.answer.ok || top < deps.threshold);

    if (!wantEscalation) {
      if (!first.answer.ok) return { status: 'failed', reason: `unusable_answer: ${first.answer.error ?? ''}`.slice(0, 300) };
      const out = await deps.db.recordLlmLabels(ev.id, toResult(first.answer, first.reply.model, v));
      deps.log.log('info', 'labels_recorded', { job_id: job.id, evidence_id: ev.id, version: v, labels: out.labels, field_matches: out.field_matches, held_for_review: out.held_for_review });
      return { status: 'done' };
    }

    const escVersion = v + ESCALATION_SUFFIX;
    let second: { reply: LabelReply; answer: LabelAnswer } | null = null;
    try {
      second = await ask(deps.escalation as LabelModel, 'escalation', job, ev, ctx, input, escVersion, signal);
    } catch (err) {
      if (!first.answer.ok || signal?.aborted) throw err;
      // keep the first answer now; the escalation is retried later as its own job (normal back-off)
      await deps.db.recordLlmLabels(ev.id, toResult(first.answer, first.reply.model, v));
      const queued = await deps.db.enqueueReprocessing([ev.id], ['label'], escVersion);
      deps.log.log('warn', 'escalation_deferred', { job_id: job.id, evidence_id: ev.id, version: escVersion, queued, error: errorText(err) });
      return { status: 'done', reason: 'escalation_deferred' };
    }
    if (!second.answer.ok) {
      if (!first.answer.ok) return { status: 'failed', reason: `unusable_answers: ${second.answer.error ?? ''}`.slice(0, 300) };
      await deps.db.recordLlmLabels(ev.id, toResult(first.answer, first.reply.model, v));
      deps.log.log('warn', 'escalation_unusable', { job_id: job.id, evidence_id: ev.id, version: escVersion });
      return { status: 'done', reason: 'escalation_unusable' };
    }
    const out = await deps.db.recordLlmLabels(ev.id, toResult(second.answer, second.reply.model, escVersion),
      first.answer.ok ? toResult(first.answer, first.reply.model, v) : null);
    deps.log.log('info', 'labels_recorded', {
      job_id: job.id, evidence_id: ev.id, version: escVersion, escalated: true, labels: out.labels, superseded: out.superseded,
      field_matches: out.field_matches, held_for_review: out.held_for_review,
    });
    return { status: 'done', reason: 'escalated' };
  };
}
