// Request flow of the `report-generate` function (build plan 7.7, D51) against an injected gateway
// (tested from Node with fakes). The Deno entry point (../../report-generate/index.ts) wires the
// gateway to a supabase-js client carrying the CALLER's JWT: prepare / create run under the
// database's own checks (staff, can_manage_case, editable status), report files are uploaded under
// the `reports` storage policies and Supabase Storage images are downloaded under `email-raw`'s, so
// no service-role key is used (rule 4). R2 images are read with the read-only R2 token, only for keys
// that prepare_report_version() returned to this caller.
import { bindReport, fieldsFromSections, LayoutError, type ReportData, type ReportPhoto, type RBlock, type ResolvedDocument } from '../report/bind.ts';
import { htmlFromDocument, type PdfOptions } from '../report/html.ts';
import { docxFromDocument, DOCX_MIME } from '../report/docx.ts';
import { sniffImage } from '../report/image.ts';
import type { ReportLayout } from '../report/spec.ts';
import { validateLayout } from '../report/validate.ts';
import {
  caseFacts, type DbErrorLike, fail, type Failure, FETCH_POOL, hex, type ImageSource, imageSources, isPdf, MAX_BODY_CHARS,
  MAX_IMAGE_BYTES, MAX_PREVIEW_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, mapDbError, mapStorageError, type Mode, parseRequest,
  type PdfResult, pdfFailure, photoSections, pool, type PreparedPhoto, type PreparedReport, type RateLimit, type ReportFormat,
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

interface Loaded {
  photo: PreparedPhoto;
  rp: ReportPhoto;
}

/** Fetches the images of the photos the layout shows; unusable ones get `image: null` and a warning. */
async function loadPhotos(
  gw: Gateway, env: Env, prepared: PreparedReport, layout: unknown, mode: Mode, warnings: string[],
): Promise<Loaded[] | Failure> {
  const shown = photoSections(layout);
  const sectionTitle = new Map(prepared.sections.map((s) => [s.key, s.title]));
  // prepare_report_version() orders photos by section, then position.
  const photos = (prepared.photos ?? []).filter((p) => shown.has(p.section_key));
  const budget = mode === 'preview' ? MAX_PREVIEW_IMAGE_BYTES : MAX_TOTAL_IMAGE_BYTES;
  let planned = 0;
  const plans = photos.map((p) => {
    const plan = imageSources(p, mode);
    const label = `Photo "${p.caption ?? p.category_name ?? 'untitled'}" (${sectionTitle.get(p.section_key) ?? p.section_key})`;
    if (plan.skip !== null) return { p, label, sources: [] as ImageSource[], skip: plan.skip };
    const first = plan.sources[0];
    const size = first.size ?? MAX_IMAGE_BYTES;
    if (planned + size > budget) {
      return { p, label, sources: [] as ImageSource[], skip: 'the report already holds as many image bytes as it can' };
    }
    planned += size;
    return { p, label, sources: plan.sources, skip: null as string | null };
  });
  if (!env.r2Configured && plans.some((x) => x.sources.some((s) => s.store === 'r2'))) {
    gw.logError('R2 is not configured');
    return fail(503, 'storage_not_configured', 'File storage is not available. Try again later.');
  }
  return pool(plans, FETCH_POOL, async ({ p, label, sources, skip }): Promise<Loaded> => {
    let reason = skip;
    for (const src of sources) {
      const bytes = await gw.fetchImage(src, MAX_IMAGE_BYTES);
      if (!bytes || bytes.length === 0) { reason = 'the file could not be read'; continue; }
      const mime = sniffImage(bytes);
      if (!mime) { reason = 'the file is not a JPEG or PNG'; continue; }
      return {
        photo: p,
        rp: {
          evidence_id: p.evidence_id, caption: p.caption,
          image: { bytes, mime, ...(src.width && src.height ? { width: src.width, height: src.height } : {}) },
        },
      };
    }
    warnings.push(`${label}: ${reason ?? 'not available'}; an empty box with the caption is printed instead.`);
    return { photo: p, rp: { evidence_id: p.evidence_id, caption: p.caption, image: null } };
  });
}

/** Image byte arrays that ended up in the document (identity), to record the photos actually placed. */
function placedBytes(doc: ResolvedDocument): Set<Uint8Array> {
  const out = new Set<Uint8Array>();
  const walk = (blocks: RBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === 'image' && b.image) out.add(b.image.bytes);
      else if (b.kind === 'group') walk(b.blocks);
      else if (b.kind === 'table') for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
    }
  };
  walk(doc.body);
  walk(doc.header);
  walk(doc.footer);
  return out;
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
  if (layout === null || layout === undefined) {
    return err(fail(422, 'no_layout',
      'This insurer template has no report layout yet, so the report cannot be generated. Ask an admin to load the layout for this template.'));
  }
  const issues = validateLayout(layout);
  if (issues.length) {
    gw.logError(`invalid layout: template ${prepared.template.id} (${issues.length} issues)`);
    return err(fail(422, 'invalid_layout', 'The report layout of this template is invalid. Ask an admin to fix and reload it.',
      { issues: issues.slice(0, 10) }));
  }
  const formats = templateFormats(prepared);
  if (req.mode === 'generate' && formats.length === 0) {
    return err(fail(422, 'no_formats', 'This insurer template lists no PDF or Word output.'));
  }
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
  const loaded = await loadPhotos(gw, env, prepared, layout, req.mode, warnings);
  if (!Array.isArray(loaded)) return err(loaded);
  const photos: Record<string, ReportPhoto[]> = {};
  for (const l of loaded) (photos[l.photo.section_key] ??= []).push(l.rp);
  const pos = new Map(loaded.map((l) => [l.rp, l.photo.position]));
  for (const k of Object.keys(photos)) photos[k].sort((a, b) => pos.get(a)! - pos.get(b)!);
  const generatedAt = now().toISOString();
  const data: ReportData = { case: caseFacts(prepared, generatedAt), fields: fieldsFromSections(prepared.sections), photos };
  let doc: ResolvedDocument;
  try {
    doc = bindReport(layout as ReportLayout, data);
  } catch (e) {
    if (e instanceof LayoutError) {
      return err(fail(422, 'invalid_layout', 'The report layout of this template is invalid. Ask an admin to fix and reload it.',
        { issues: e.issues.slice(0, 10) }));
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
  const placed = placedBytes(doc);

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
  const placedPhotos = loaded
    .filter((l) => l.rp.image && placed.has(l.rp.image.bytes))
    .map((l) => ({ evidence_id: l.photo.evidence_id, section_key: l.photo.section_key, position: l.photo.position, caption: l.photo.caption }));
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
