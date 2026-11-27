// Shared fixtures for report-generate*.test.ts (fictional data only).
import {
  type PreparedPhoto, type PreparedReport,
} from '../../../supabase/functions/_shared/report-generate/logic.ts';
import { type Env, type Gateway, handleReportGenerate } from '../../../supabase/functions/_shared/report-generate/handler.ts';
import { defaultLayout } from '../../../supabase/functions/_shared/report/spec.ts';
import type { OcrRowLike } from '../../../supabase/functions/_shared/report/aadhaar.ts';
import { photoA, photoB } from './report-helpers.ts';

export const CASE = '7e500000-0000-4000-8000-000000000001';
export const TASK = '7e600000-0000-4000-8000-000000000001';
export const REPORT = '7e900000-0000-4000-8000-000000000001';
export const NOW = new Date('2026-11-17T06:00:00Z');
export const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
export const originalKey = (n: number, ext = 'jpg') => `cases/${CASE}/tasks/${TASK}/${sha(n)}.${ext}`;
export const copyKey = (n: number, w: 384 | 1600) => `derived/${CASE}/${sha(n)}/w${w}.jpg`;

export const SECTIONS = [
  { key: 'insured', title: 'Insured details', position: 1, fields: [
    { key: 'insured_name', label: 'Insured name', type: 'text', value: 'A. Example' },
    { key: 'loss_date', label: 'Date of loss', type: 'date', value: '2026-10-02' },
  ] },
  { key: 'garage', title: 'Garage visit', position: 2, fields: [
    { key: 'garage_name', label: 'Garage', type: 'text', value: 'Example Motors' },
  ] },
  { key: 'spot', title: 'Spot visit', position: 3, fields: [] },
];

export function photo(n: number, over: Partial<PreparedPhoto> = {}): PreparedPhoto {
  return {
    evidence_id: `7e700000-0000-4000-8000-${String(n).padStart(12, '0')}`, section_key: 'garage', position: n,
    caption: `Photo ${n}`, category_name: 'Vehicle', evidence_type: 'photo', mime_type: 'image/jpeg', original_filename: `IMG_${n}.jpg`,
    storage_backend: 'r2', storage_path: originalKey(n), sha256: sha(n), size_bytes: 400_000,
    derivatives: [
      { width: 384, storage_path: copyKey(n, 384), size_bytes: 30_000, pixel_width: 384, pixel_height: 288 },
      { width: 1600, storage_path: copyKey(n, 1600), size_bytes: 300_000, pixel_width: 1600, pixel_height: 1200 },
    ],
    ...over,
  };
}

export function prepared(over: Partial<PreparedReport> = {}): PreparedReport {
  return {
    prepared_at: NOW.toISOString(), prepared_by: { id: 'u-1', name: 'O. Office' },
    case: {
      id: CASE, case_ref: 'INV-2026-000042', insurer_claim_no: 'CL/1/2026', policy_no: 'P-1', received_at: '2026-11-01T04:00:00Z',
      due_at: '2026-11-16T04:00:00Z', insurer: { id: 'i-1', code: 'EXM', name: 'Example General' }, office_owner: { id: 'u-1', name: 'O. Office' },
    },
    template: { id: 't-1', key: 'exm-motor-od', name: 'Example Motor OD', version: 1, output_formats: ['pdf', 'docx'] },
    report_layout: defaultLayout(SECTIONS),
    values_token: 'v1:abc',
    next_version: 3,
    sections: SECTIONS,
    photos: [photo(1), photo(2)],
    ...over,
  };
}

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nfake\n%%EOF');

interface FakeOpts {
  uid?: string | null;
  prepared?: PreparedReport | null;
  prepareError?: { code: string; message?: string };
  images?: Map<string, Uint8Array>;
  pdf?: Awaited<ReturnType<Gateway['renderPdf']>>;
  uploadError?: { statusCode: string; message?: string };
  createError?: { code: string; message?: string };
  createdVersion?: number;
  /** evidence_ocr rows loadOcr returns (default none; null = cannot be read). */
  ocr?: OcrRowLike[] | null;
}

export function fakeGateway(o: FakeOpts = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const logs: string[] = [];
  const a = photoA();
  const images = o.images ?? new Map<string, Uint8Array>([
    [copyKey(1, 384), a], [copyKey(1, 1600), a], [originalKey(1), a],
    [copyKey(2, 384), photoB()], [copyKey(2, 1600), photoB()], [originalKey(2), photoB()],
  ]);
  const gw: Gateway = {
    async verifyCaller() {
      return o.uid === undefined ? 'u-1' : o.uid;
    },
    async prepare(caseId, preview) {
      calls.push({ fn: 'prepare', args: preview ? [caseId, 'preview'] : [caseId] });
      if (o.prepareError) return { data: null, error: o.prepareError };
      return { data: o.prepared === undefined ? prepared() : o.prepared, error: null };
    },
    async fetchImage(src, max) {
      calls.push({ fn: 'fetchImage', args: [src.store, src.path, max] });
      const b = images.get(src.path);
      return b && b.length <= max ? b.slice() : null;
    },
    async loadOcr(ids) {
      calls.push({ fn: 'loadOcr', args: [ids] });
      return o.ocr === undefined ? [] : o.ocr;
    },
    async renderPdf(html, pdfOptions) {
      calls.push({ fn: 'renderPdf', args: [html, pdfOptions] });
      return o.pdf ?? { ok: true, bytes: PDF_BYTES };
    },
    async upload(path, bytes, contentType) {
      calls.push({ fn: 'upload', args: [path, bytes.length, contentType] });
      return { error: o.uploadError ?? null };
    },
    async createVersion(args) {
      calls.push({ fn: 'createVersion', args: [args] });
      if (o.createError) return { data: null, error: o.createError };
      return { data: { report_id: args.p_report_id, version: o.createdVersion ?? 3, created: true }, error: null };
    },
    logError(msg) {
      logs.push(msg);
    },
  };
  return { gw, calls, logs };
}

export const open = () => ({ take: () => null });
export function env(over: Partial<Env> = {}): Env {
  return { r2Configured: true, pdfConfigured: true, limit: open(), pdfLimit: null, now: () => NOW, newId: () => REPORT, ...over };
}
export const post = (gw: Gateway, body: unknown, e: Env = env()) => handleReportGenerate('POST', true, JSON.stringify(body), gw, e);
