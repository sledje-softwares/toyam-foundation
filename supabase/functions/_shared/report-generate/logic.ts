// Pure logic of the `report-generate` function (build plan 7.7, D51): request validation, the shape of
// prepare_report_version(), which image file to embed for each photo, the per-user rate limit, the
// Browser Rendering request / 429 handling and DB error mapping. No I/O, no npm imports: runs in Deno
// and in Node's type stripping (services/intake/test/report-generate*.test.ts).
import type { CaseFacts } from '../report/bind.ts';
import type { PdfOptions } from '../report/html.ts';

export type ErrorCode =
  | 'method_not_allowed'
  | 'unauthorized'
  | 'invalid_body'
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'not_editable'
  | 'values_changed'
  | 'invalid_case'
  | 'no_layout'
  | 'invalid_layout'
  | 'no_formats'
  | 'rate_limited'
  | 'pdf_failed'
  | 'upload_failed'
  | 'storage_not_configured'
  | 'pdf_not_configured'
  | 'upstream_error'
  | 'internal';

export interface Failure {
  status: number;
  error: { code: ErrorCode; message: string; field?: string; retry_after?: number; issues?: string[] };
  retryAfter?: number;
}
export function fail(status: number, code: ErrorCode, message: string, extra: Partial<Failure['error']> = {}): Failure {
  return { status, error: { code, message, ...extra } };
}

const MB = 1024 * 1024;

/** Largest single image embedded (device copy or original); anything larger is a placeholder. */
export const MAX_IMAGE_BYTES = 3 * MB;
/**
 * Total image bytes embedded in one generated report. Base64 makes the HTML ~4/3 of this, and the
 * Browser Rendering /pdf body limit is 50 MB; the edge isolate has 256 MB for images, HTML, the
 * JSON body, the PDF and the DOCX together. Photos past the budget become placeholders (warning).
 */
export const MAX_TOTAL_IMAGE_BYTES = 24 * MB;
/** Preview budget: the HTML goes back to the browser. */
export const MAX_PREVIEW_IMAGE_BYTES = 12 * MB;
/** Images fetched at the same time. */
export const FETCH_POOL = 6;
export const MAX_NOTES = 2000;
export const MAX_BODY_CHARS = 8_000;
/** Browser Rendering call timeout (its browser times out after 60 s anyway). */
export const PDF_TIMEOUT_MS = 90_000;

export type Mode = 'generate' | 'preview';
export interface GenerateRequest {
  case_id: string;
  mode: Mode;
  notes: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Parsed = { ok: true; value: GenerateRequest } | { ok: false; failure: Failure };
const bad = (field: string, message: string): Parsed => ({ ok: false, failure: fail(400, 'invalid_input', message, { field }) });

export function parseRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: fail(400, 'invalid_body', 'Send a JSON object.') };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.case_id !== 'string' || !UUID.test(b.case_id)) return bad('case_id', 'case_id must be a UUID.');
  const mode = b.mode ?? 'generate';
  if (mode !== 'generate' && mode !== 'preview') return bad('mode', 'mode must be "generate" or "preview".');
  let notes: string | null = null;
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') return bad('notes', 'notes must be text.');
    notes = b.notes.trim() || null;
    if (notes && [...notes].length > MAX_NOTES) return bad('notes', `Keep the notes under ${MAX_NOTES} characters.`);
  }
  return { ok: true, value: { case_id: b.case_id.toLowerCase(), mode, notes } };
}

// ---------------------------------------------------------------------------------------------
// prepare_report_version() result (the parts the generator reads; docs/12-office-pages/reports.md)
// ---------------------------------------------------------------------------------------------
export interface PreparedDerivative {
  width: number;
  storage_path: string;
  sha256?: string;
  size_bytes: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
}
export interface PreparedFile {
  evidence_type: string;
  mime_type: string | null;
  original_filename?: string | null;
  storage_backend: string;
  storage_path: string | null;
  sha256?: string | null;
  size_bytes: number | null;
  derivatives?: PreparedDerivative[] | null;
}
export interface PreparedPhoto extends PreparedFile {
  evidence_id: string;
  section_key: string;
  position: number;
  caption: string | null;
  category_code?: string | null;
  category_name?: string | null;
}
export interface PreparedField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  value: string | null;
}
export interface PreparedSection {
  key: string;
  title: string;
  position: number;
  fields: PreparedField[];
}
export interface PreparedReport {
  prepared_at?: string;
  prepared_by?: { id: string; name: string | null } | null;
  case: {
    id: string;
    case_ref: string;
    insurer_claim_no?: string | null;
    policy_no?: string | null;
    received_at?: string | null;
    due_at?: string | null;
    insurer?: { id?: string; code?: string | null; name?: string | null } | null;
    office_owner?: { id: string; name: string | null } | null;
  };
  template: {
    id: string;
    key?: string | null;
    name?: string | null;
    version?: number | null;
    output_formats?: string[] | null;
  };
  report_layout: unknown;
  values_token: string;
  next_version: number;
  sections: PreparedSection[];
  photos: PreparedPhoto[];
}

export type ReportFormat = 'pdf' | 'docx';
/** The template's formats, in a fixed order, unknown values dropped. */
export function templateFormats(p: PreparedReport): ReportFormat[] {
  const f = p.template.output_formats ?? [];
  return (['pdf', 'docx'] as const).filter((x) => f.includes(x));
}

export function caseFacts(p: PreparedReport, generatedAt: string): CaseFacts {
  return {
    case_ref: p.case.case_ref,
    insurer_code: p.case.insurer?.code ?? null,
    insurer_name: p.case.insurer?.name ?? null,
    claim_no: p.case.insurer_claim_no ?? null,
    policy_no: p.case.policy_no ?? null,
    template_key: p.template.key ?? null,
    template_name: p.template.name ?? null,
    template_version: p.template.version ?? null,
    office_owner_name: p.case.office_owner?.name ?? null,
    received_at: p.case.received_at ?? null,
    due_at: p.case.due_at ?? null,
    generated_at: generatedAt,
    report_version: p.next_version,
  };
}

// ---------------------------------------------------------------------------------------------
// Which file to embed for a photo
// ---------------------------------------------------------------------------------------------
export type Store = 'r2' | 'supabase';
export interface ImageSource {
  store: Store;
  path: string;
  /** Size recorded in the database, when known. */
  size: number | null;
  /** Pixel size recorded for a device copy (saves reading the JPEG header). */
  width?: number;
  height?: number;
  kind: 'copy384' | 'copy1600' | 'original';
}

/** Types that can be embedded in both PDF (Chrome) and Word. */
export const EMBEDDABLE = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png']);

const R2_ORIGINAL = /^cases\/[0-9a-f-]{36}\/(tasks\/[0-9a-f-]{36}|files)\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const R2_COPY = /^derived\/[0-9a-f-]{36}\/[0-9a-f]{64}\/w(384|1600)\.jpg$/;
const safeStoragePath = (p: string) => p.length > 0 && p.length <= 1024 && !p.startsWith('/') && !p.split('/').includes('..');

export type SourcePlan = { sources: ImageSource[]; skip: null } | { sources: []; skip: string };

/**
 * Candidates in order of preference. Generate: the 1600 px device copy, then the original.
 * Preview: the 384 px copy, the 1600 px copy, then the original. Device copies are JPEGs on R2
 * (`derived/{case}/{sha}/w{width}.jpg`); originals are used only when their recorded type is JPEG /
 * PNG (or unknown: the bytes are sniffed) and they are at most MAX_IMAGE_BYTES.
 */
export function imageSources(f: PreparedFile, mode: Mode): SourcePlan {
  const out: ImageSource[] = [];
  const copies = f.derivatives ?? [];
  const widths = mode === 'preview' ? [384, 1600] : [1600];
  for (const w of widths) {
    const d = copies.find((x) => x.width === w);
    if (d && R2_COPY.test(d.storage_path) && (d.size_bytes ?? 0) <= MAX_IMAGE_BYTES) {
      out.push({
        store: 'r2', path: d.storage_path, size: d.size_bytes ?? null, kind: w === 384 ? 'copy384' : 'copy1600',
        ...(d.pixel_width && d.pixel_height ? { width: d.pixel_width, height: d.pixel_height } : {}),
      });
    }
  }
  const mime = (f.mime_type ?? '').toLowerCase().split(';')[0].trim();
  let skip: string | null = null;
  if (!f.storage_path) skip = 'no file is stored';
  else if (mime && !EMBEDDABLE.has(mime)) skip = `${mime.replace(/^image\//, '').toUpperCase()} images cannot be placed in a report`;
  else if (f.size_bytes !== null && f.size_bytes > MAX_IMAGE_BYTES) skip = `the file is larger than ${MAX_IMAGE_BYTES / MB} MB`;
  else if (f.storage_backend === 'r2' && R2_ORIGINAL.test(f.storage_path)) {
    out.push({ store: 'r2', path: f.storage_path, size: f.size_bytes, kind: 'original' });
  } else if (f.storage_backend === 'supabase' && safeStoragePath(f.storage_path)) {
    out.push({ store: 'supabase', path: f.storage_path, size: f.size_bytes, kind: 'original' });
  } else skip = 'the file cannot be read';
  return out.length ? { sources: out, skip: null } : { sources: [], skip: skip ?? 'the file cannot be read' };
}

/** Sections that some `photos` block of the layout shows (conditions not evaluated: a superset). */
export function photoSections(layout: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o.type === 'photos' && typeof o.section === 'string') out.add(o.section);
    for (const k of Object.keys(o)) if (k !== 'assets') walk(o[k]);
  };
  walk(layout);
  return out;
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export function hex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** `{case_id}/{report_id}/report.{format}` in bucket `reports` (create_report_version checks it). */
export function reportPath(caseId: string, reportId: string, format: ReportFormat): string {
  return `${caseId}/${reportId}/report.${format}`;
}

// ---------------------------------------------------------------------------------------------
// Browser Rendering /pdf
// ---------------------------------------------------------------------------------------------
export const BROWSER_RENDERING_API = 'https://api.cloudflare.com/client/v4/accounts';

export interface PdfRequest {
  url: string;
  body: string;
}
/**
 * POST /accounts/{id}/browser-rendering/pdf?cacheTTL=0 with `{html, pdfOptions}` exactly as
 * renderReportHtml returns them. cacheTTL=0: the rendered report (personal data) is not kept in
 * Cloudflare's response cache. JavaScript is off and the page waits only for `load` (all images
 * are data: URIs and the CSP forbids any fetch).
 */
export function pdfRequest(accountId: string, html: string, pdfOptions: PdfOptions): PdfRequest {
  return {
    url: `${BROWSER_RENDERING_API}/${encodeURIComponent(accountId)}/browser-rendering/pdf?cacheTTL=0`,
    body: JSON.stringify({
      html,
      pdfOptions,
      setJavaScriptEnabled: false,
      gotoOptions: { waitUntil: 'load', timeout: 60_000 },
    }),
  };
}

export type PdfResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; retryAfter: number | null; message: string | null };

/** Seconds from a Retry-After header (seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Math.max(1, Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(1, Math.ceil((t - nowMs) / 1000));
}

/** Seconds to the next 00:00 UTC (05:30 India time), when the free plan's daily browser time resets. */
export function secondsToUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

/** Maps a failed /pdf call to the reply. 429 is passed through with retry_after; anything else is 502. */
export function pdfFailure(r: Extract<PdfResult, { ok: false }>, nowMs: number): Failure {
  if (r.status === 429) {
    const daily = /time limit|daily/i.test(r.message ?? '');
    const wait = daily ? secondsToUtcMidnight(nowMs) : (r.retryAfter ?? 10);
    const message = daily
      ? 'The PDF service has used up today\'s allowance. Try again after 05:30 India time, or generate Word only.'
      : `The PDF service is busy. Try again in ${wait} s.`;
    return { ...fail(429, 'rate_limited', message, { retry_after: wait }), retryAfter: wait };
  }
  return fail(502, 'pdf_failed', 'The PDF could not be made. Try again in a minute.');
}

export function isPdf(b: Uint8Array): boolean {
  return b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-
}

// ---------------------------------------------------------------------------------------------
// Rate limits (best effort, per isolate)
// ---------------------------------------------------------------------------------------------
export interface RateLimit {
  /** null = allowed (and counted); otherwise seconds until the key may try again. */
  take(key: string, nowMs: number): number | null;
}

/** Sliding windows per key, e.g. [{windowMs: 15_000, max: 1}, {windowMs: 3_600_000, max: 10}]. */
export function createRateLimit(windows: { windowMs: number; max: number }[], maxKeys = 5_000): RateLimit {
  const longest = Math.max(...windows.map((w) => w.windowMs));
  const seen = new Map<string, number[]>();
  return {
    take(key, nowMs) {
      const recent = (seen.get(key) ?? []).filter((t) => t > nowMs - longest);
      let wait = 0;
      for (const w of windows) {
        const inWin = recent.filter((t) => t > nowMs - w.windowMs);
        if (inWin.length >= w.max) wait = Math.max(wait, Math.ceil((inWin[inWin.length - w.max] + w.windowMs - nowMs) / 1000));
      }
      seen.delete(key);
      if (wait > 0) {
        seen.set(key, recent);
        return Math.max(1, wait);
      }
      recent.push(nowMs);
      seen.set(key, recent); // re-insert: Map order = least recently used first
      if (seen.size > maxKeys) seen.delete(seen.keys().next().value as string);
      return null;
    },
  };
}
/** Per user: generate 1 per 15 s and 10 per hour; preview 20 per minute. */
export const GENERATE_LIMITS = [{ windowMs: 15_000, max: 1 }, { windowMs: 3_600_000, max: 10 }];
export const PREVIEW_LIMITS = [{ windowMs: 60_000, max: 20 }];

// ---------------------------------------------------------------------------------------------
// Database / storage errors
// ---------------------------------------------------------------------------------------------
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
}

/** A clean message raised by our own SQL (no internals): first line, at most 300 characters. */
function dbMessage(e: DbErrorLike, fallback: string): string {
  const m = (e.message ?? '').split('\n')[0].trim();
  return m ? [...m].slice(0, 300).join('') : fallback;
}

export function mapDbError(e: DbErrorLike): Failure {
  switch (e.code) {
    case 'PGRST301': case 'PGRST302': case 'PGRST303':
      return fail(401, 'unauthorized', 'Sign in again.');
    case '42501':
      return fail(403, 'forbidden', dbMessage(e, 'You cannot generate the report of this case.'));
    case 'P0002':
      return fail(404, 'not_found', 'Case not found.');
    case '55000':
      return fail(409, 'not_editable', dbMessage(e, 'The report of this case cannot be changed now.'));
    case 'RV409':
      return fail(409, 'values_changed', 'Someone changed the report while it was generating. Generate it again.');
    case '22023':
      return fail(422, 'invalid_case', dbMessage(e, 'The report cannot be generated.'));
    default:
      return fail(502, 'upstream_error', 'Something went wrong. Try again later.');
  }
}

export interface StorageErrorLike {
  statusCode?: string | number | null;
  status?: number | null;
  message?: string | null;
}
export function mapStorageError(e: StorageErrorLike): Failure {
  const s = Number(e.statusCode ?? e.status ?? 0);
  if (s === 401) return fail(401, 'unauthorized', 'Sign in again.');
  if (s === 403) return fail(403, 'forbidden', 'You cannot store reports for this case.');
  return fail(502, 'upload_failed', 'The report files could not be stored. Try again.');
}
