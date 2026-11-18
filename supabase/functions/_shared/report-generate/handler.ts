// Request flow of the `report-generate` function (build plan 7.7, D51) against an injected gateway
// (tested from Node with fakes). The Deno entry point (../../report-generate/index.ts) wires the
// gateway to a supabase-js client carrying the CALLER's JWT: prepare / create run under the
// database's own checks (staff, can_manage_case, editable status), report files are uploaded under
// the `reports` storage policies and Supabase Storage images are downloaded under `email-raw`'s, so
// no service-role key is used (rule 4). R2 images are read with the read-only R2 token, only for keys
// that prepare_report_version() returned to this caller.
import { INVALID_LAYOUT_MESSAGE, type LoadedPhoto, loadReportPhotos, placedPhotoKeys, placedPhotoRecords, planReportPhotos, preparedProblem, reportDataFrom } from '../report/assemble.ts';
import { bindReport, LayoutError, type ReportData, type ResolvedDocument } from '../report/bind.ts';
import { htmlFromDocument, type PdfOptions } from '../report/html.ts';
import { docxFromDocument, DOCX_MIME } from '../report/docx.ts';
import type { ReportLayout } from '../report/spec.ts';
import {
  type DbErrorLike, fail, type Failure, FETCH_POOL, hex, type ImageSource, isPdf, MAX_BODY_CHARS, MAX_IMAGE_BYTES, mapDbError,
  mapStorageError, type Mode, parseRequest, type PdfResult, pdfFailure, type PreparedReport, type RateLimit, type ReportFormat,
  reportPath, type StorageErrorLike, templateFormats,
} from './logic.ts';

export interface CreateVersionArgs {
  p_case_id: string;
  p_report_id: string;
  p_values_token: string;
  p_files: { format: ReportFormat; storage_path: string; sha256: string; size_bytes: number }[];
  p_photos: { evidence_id: string; section_key: string; position: number; caption: string | null }[];
  p_notes: string | null;
}

export interface Gateway {
  /** auth.getUser with the bearer token; the user id, or null when the session is not valid. */
  verifyCaller(): Promise<string | null>;
  /** rpc prepare_report_version(p_case_id) with the caller's client; for a preview, prepare_report_preview (no editable-status check). */
  prepare(caseId: string, preview: boolean): Promise<{ data: PreparedReport | null; error: DbErrorLike | null }>;
  /** Bytes of one image (R2 with the read token, Storage `email-raw` with the caller's client); null when missing, refused or larger than maxBytes. */
  fetchImage(src: ImageSource, maxBytes: number): Promise<Uint8Array | null>;
  /** POST {html, pdfOptions} to Browser Rendering /pdf. */
  renderPdf(html: string, pdfOptions: PdfOptions): Promise<PdfResult>;
  /** Upload to bucket `reports` with the caller's client, no upsert. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: StorageErrorLike | null }>;
  /** rpc create_report_version(...) with the caller's client. */
  createVersion(args: CreateVersionArgs): Promise<{ data: { report_id: string; version: number; created: boolean } | null; error: DbErrorLike | null }>;
  /** Error log without secrets or personal data (codes / ids only). */
  logError(msg: string): void;
}

export interface Env {
  /** R2 read secrets are set (needed for phone photos and their copies). */
  r2Configured: boolean;
  /** Browser Rendering secrets are set (needed when the template outputs PDF). */
  pdfConfigured: boolean;
  /** Per-user limits (keys `generate:<uid>` / `preview:<uid>`). */
  limit: RateLimit;
  /** Optional per-isolate spacing of /pdf calls (free plan: 1 per 10 s per account); key `pdf`. */
  pdfLimit: RateLimit | null;
  now?: () => Date;
  newId?: () => string;
  sha256?: (b: Uint8Array) => Promise<string>;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

const err = (f: Failure): Reply => ({
  status: f.status, body: { ok: false, error: f.error }, ...(f.retryAfter ? { retryAfter: f.retryAfter } : {}),
});

const defaultSha = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));

/** Fetches the images of the photos the layout shows (shared plan, assemble.ts); unusable ones get `image: null` and a warning. */
async function loadPhotos(gw: Gateway, env: Env, prepared: PreparedReport, mode: Mode, warnings: string[]): Promise<LoadedPhoto[] | Failure> {
  const plans = planReportPhotos(prepared, mode);
  if (!env.r2Configured && plans.some((x) => x.sources.some((s) => s.store === 'r2'))) {
    gw.logError('R2 is not configured');
    return fail(503, 'storage_not_configured', 'File storage is not available. Try again later.');
  }
  return loadReportPhotos(plans, (src) => gw.fetchImage(src, MAX_IMAGE_BYTES), { poolSize: FETCH_POOL, warnings });
}

export async function handleReportGenerate(method: string, hasAuth: boolean, bodyText: string, gw: Gateway, env: Env): Promise<Reply> {
  const now = env.now ?? (() => new Date());
  if (method !== 'POST') return err(fail(405, 'method_not_allowed', 'Use POST.'));
  if (!hasAuth) return err(fail(401, 'unauthorized', 'Sign in again.'));
  if (bodyText.length > MAX_BODY_CHARS) return err(fail(400, 'invalid_body', 'The request is too large.'));
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return err(fail(400, 'invalid_body', 'Send a JSON object.'));
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) return err(parsed.failure);
  const req = parsed.value;

  const uid = await gw.verifyCaller();
  if (!uid) return err(fail(401, 'unauthorized', 'Sign in again.'));
  const wait = env.limit.take(`${req.mode}:${uid}`, now().getTime());
  if (wait !== null) {
    const what = req.mode === 'preview' ? 'previews' : 'reports generated';
    return err({ ...fail(429, 'rate_limited', `Too many ${what}. Try again in ${wait} s.`, { retry_after: wait }), retryAfter: wait });
  }

  // 1. Everything the report needs, under the database's checks (staff, own case; editable status unless previewing).
  const prep = await gw.prepare(req.case_id, req.mode === 'preview');
  if (prep.error || !prep.data) {
    const f = prep.error ? mapDbError(prep.error) : fail(502, 'upstream_error', 'Something went wrong. Try again later.');
    if (f.status >= 500) gw.logError(`prepare failed: ${prep.error?.code ?? 'no data'} case ${req.case_id} user ${uid}`);
    return err(f);
  }
  const prepared = prep.data;
  const layout = prepared.report_layout;
  const problem = preparedProblem(prepared, req.mode);
  if (problem) {
    if (problem.error.code === 'invalid_layout') gw.logError(`invalid layout: template ${prepared.template.id} (${problem.error.issues?.length ?? 0} issues)`);
    return err(problem);
  }
  const formats = templateFormats(prepared);
  const wantPdf = req.mode === 'generate' && formats.includes('pdf');
  if (wantPdf && !env.pdfConfigured) {
    gw.logError('Browser Rendering is not configured');
    return err(fail(503, 'pdf_not_configured', 'PDF generation is not set up yet. Ask an admin.'));
  }
  if (wantPdf && env.pdfLimit) {
    const w = env.pdfLimit.take('pdf', now().getTime());
    if (w !== null) {
      return err({ ...fail(429, 'rate_limited', `The PDF service is busy. Try again in ${w} s.`, { retry_after: w }), retryAfter: w });
    }
  }

  // 2. Photos (device copies first), then the resolved document, bound once for both writers.
  const warnings: string[] = [];
  const loaded = await loadPhotos(gw, env, prepared, req.mode, warnings);
  if (!Array.isArray(loaded)) return err(loaded);
  const data: ReportData = reportDataFrom(prepared, loaded, now().toISOString());
  let doc: ResolvedDocument;
  try {
    doc = bindReport(layout as ReportLayout, data);
  } catch (e) {
    if (e instanceof LayoutError) {
      return err(fail(422, 'invalid_layout', INVALID_LAYOUT_MESSAGE, { issues: e.issues.slice(0, 10) }));
    }
    throw e;
  }
  warnings.push(...doc.warnings);

  if (req.mode === 'preview') {
    const out = htmlFromDocument(doc, 'preview');
    return { status: 200, body: { ok: true, html: out.html, warnings } };
  }

  // 3. Files.
  const reportId = (env.newId ?? (() => crypto.randomUUID()))();
  const sha256 = env.sha256 ?? defaultSha;
  const files: { format: ReportFormat; bytes: Uint8Array; mime: string }[] = [];
  if (wantPdf) {
    const out = htmlFromDocument(doc, 'pdf');
    const r = await gw.renderPdf(out.html, out.pdfOptions);
    if (!r.ok) {
      gw.logError(`pdf failed: status ${r.status} case ${req.case_id} user ${uid}`);
      return err(pdfFailure(r, now().getTime()));
    }
    if (!isPdf(r.bytes)) {
      gw.logError(`pdf failed: not a PDF (${r.bytes.length} bytes) case ${req.case_id}`);
      return err(fail(502, 'pdf_failed', 'The PDF could not be made. Try again in a minute.'));
    }
    files.push({ format: 'pdf', bytes: r.bytes, mime: 'application/pdf' });
  }
  if (formats.includes('docx')) {
    files.push({ format: 'docx', bytes: await docxFromDocument(doc, { now: now() }), mime: DOCX_MIME });
  }
  const placedKeys = placedPhotoKeys(doc, data);

  // 4. Upload (caller's JWT, no upsert), then record the version.
  const recorded: { format: ReportFormat; storage_path: string; sha256: string; size_bytes: number }[] = [];
  for (const f of files) {
    const path = reportPath(prepared.case.id, reportId, f.format);
    const hash = await sha256(f.bytes);
    const up = await gw.upload(path, f.bytes, f.mime);
    if (up.error) {
      const m = mapStorageError(up.error);
      gw.logError(`upload failed: ${up.error.statusCode ?? up.error.status ?? 'unknown'} ${path} user ${uid}`);
      return err(m);
    }
    recorded.push({ format: f.format, storage_path: path, sha256: hash, size_bytes: f.bytes.length });
  }
  const placedPhotos = placedPhotoRecords(loaded, placedKeys);
  const created = await gw.createVersion({
    p_case_id: prepared.case.id, p_report_id: reportId, p_values_token: prepared.values_token,
    p_files: recorded, p_photos: placedPhotos, p_notes: req.notes,
  });
  if (created.error || !created.data) {
    const f = created.error ? mapDbError(created.error) : fail(502, 'upstream_error', 'Something went wrong. Try again later.');
    // The uploaded objects stay: they cannot be overwritten, nothing references them, and a new attempt uses a new report id.
    gw.logError(`create_report_version failed: ${created.error?.code ?? 'no data'} report ${reportId} case ${req.case_id} user ${uid}`);
    return err(f);
  }
  if (created.data.version !== prepared.next_version) {
    warnings.push(`Another version was recorded at the same time: this one is version ${created.data.version}, ` +
      `but the document prints version ${prepared.next_version}. Generate again if the number matters.`);
  }
  return {
    status: 200,
    body: {
      ok: true, report_id: created.data.report_id, version: created.data.version,
      files: recorded, photos: placedPhotos.length, warnings,
    },
  };
}
