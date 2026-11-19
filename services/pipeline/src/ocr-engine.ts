// Pluggable server OCR (6.3, D34): `none` (no engine; the OCR stage completes as skipped) or `http`, a PaddleOCR
// sidecar (services/pipeline/ocr-sidecar) speaking the contract below.
//
//   POST {OCR_URL}/ocr
//     headers: Content-Type: image/jpeg | image/png | image/webp | application/pdf
//              Authorization: Bearer {OCR_TOKEN}         (when set)
//              X-Max-Pages: n                            (PDFs: pages to read, default 10)
//     body:    the file bytes
//   200 { "engine": "paddleocr", "engine_version": "3.x.y", "lang": "en",
//         "pages": [ { "page_no": 1, "width": 1600, "height": 1200, "text": "line 1\nline 2",
//                      "mean_confidence": 0.93,
//                      "blocks": [ { "text": "...", "bbox": [x, y, w, h], "conf": 0.97, "line": 1 } ] } ] }
//   4xx { "error": "..." }   not retried (bad input)      5xx / timeout: retried by the job back-off
//   GET {OCR_URL}/health -> 200 { "ok": true, "engine": "paddleocr", "engine_version": "..." }
//
// Coordinates are image pixels (rendered page pixels for PDFs), top-left origin, as docs/10 "Data shapes".
import type { OcrBlock } from './types.ts';

export interface OcrPage {
  page_no: number;
  text: string;
  blocks: OcrBlock[];
  mean_confidence: number | null;
}

export interface OcrOutput {
  engine: string;
  engine_version: string | null;
  lang: string | null;
  pages: OcrPage[];
}

export interface OcrEngine {
  name: string;                        // none | http
  /** null = engine not available: the stage completes as skipped with `reason`. */
  read(bytes: Uint8Array, mimeType: string, opts: { maxPages: number; signal?: AbortSignal }): Promise<OcrOutput | null>;
  reason?: string;
}

export class OcrHttpError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

export function createNoneEngine(): OcrEngine {
  return { name: 'none', reason: 'no_ocr_engine_configured', async read() { return null; } };
}

export const OCR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'application/pdf']);

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal }) => Promise<Response>;

export function createHttpEngine(opts: { url: string; token?: string; timeoutMs?: number; fetch?: FetchFn }): OcrEngine {
  const base = opts.url.replace(/\/+$/, '');
  const fetchFn: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    name: 'http',
    async read(bytes, mimeType, ro) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = ro.signal ? AbortSignal.any([ro.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetchFn(`${base}/ocr`, {
          method: 'POST',
          headers: {
            'content-type': mimeType,
            'x-max-pages': String(ro.maxPages),
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          },
          body: bytes,
          signal,
        });
      } catch (err) {
        throw new OcrHttpError(0, `OCR sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        throw new OcrHttpError(res.status, `OCR sidecar HTTP ${res.status} ${body}`);
      }
      return parseOcrResponse(await res.json());
    },
  };
}

/** Validate the sidecar's answer; drops malformed blocks instead of failing the page. */
export function parseOcrResponse(json: unknown): OcrOutput {
  const r = (json ?? {}) as Record<string, unknown>;
  if (!Array.isArray(r.pages)) throw new OcrHttpError(502, 'OCR sidecar answer has no pages');
  const pages: OcrPage[] = [];
  for (const p of r.pages as Array<Record<string, unknown>>) {
    const pageNo = Number(p?.page_no);
    if (!Number.isInteger(pageNo) || pageNo < 1) continue;
    const blocks: OcrBlock[] = [];
    for (const b of Array.isArray(p.blocks) ? p.blocks as Array<Record<string, unknown>> : []) {
      const bbox = Array.isArray(b?.bbox) ? (b.bbox as unknown[]).map(Number) : [];
      if (typeof b?.text !== 'string' || b.text.trim() === '' || bbox.length !== 4 || bbox.some((x) => !Number.isFinite(x))) continue;
      blocks.push({ text: b.text.trim(), bbox: bbox as [number, number, number, number], conf: clamp01(Number(b.conf)), line: Number.isInteger(b.line) ? b.line as number : blocks.length + 1 });
    }
    const text = typeof p.text === 'string' ? p.text : blocks.map((b) => b.text).join('\n');
    const mean = Number(p.mean_confidence);
    pages.push({
      page_no: pageNo,
      text,
      blocks,
      mean_confidence: Number.isFinite(mean) ? clamp01(mean) : blocks.length ? blocks.reduce((s, b) => s + b.conf, 0) / blocks.length : null,
    });
  }
  return {
    engine: typeof r.engine === 'string' && r.engine ? r.engine.slice(0, 50) : 'paddleocr',
    engine_version: typeof r.engine_version === 'string' ? r.engine_version.slice(0, 50) : null,
    lang: typeof r.lang === 'string' ? r.lang.slice(0, 20) : null,
    pages,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
