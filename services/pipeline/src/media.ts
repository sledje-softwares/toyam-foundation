// Image and PDF helpers. The heavy libraries (sharp, pdfjs-dist, @napi-rs/canvas) are imported lazily, so
// the stages can be tested with fakes and the worker starts even if an optional renderer is missing.
import type { OcrBlock } from './types.ts';

export interface ResizedImage { bytes: Uint8Array; width: number; height: number }

/** Shrinks an image to a JPEG with the given long edge. Metadata (EXIF, GPS) is dropped. */
export interface ImageResizer {
  toJpeg(bytes: Uint8Array, longEdge: number): Promise<ResizedImage>;
}

export interface PdfPageText {
  page_no: number;
  text: string;
  blocks: OcrBlock[];
}

export interface PdfTools {
  /** Text layer of the first `maxPages` pages (empty text for pages without one). */
  textPages(bytes: Uint8Array, maxPages: number): Promise<{ pages: PdfPageText[]; pageCount: number }>;
  /** First page rendered to JPEG (for scanned PDFs, which have no text to label from). Null when no renderer. */
  renderFirstPage(bytes: Uint8Array, longEdge: number): Promise<ResizedImage | null>;
  version: string;
}

/** Image types the resizer and the providers accept. */
export const RESIZABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif']);

// Pixel cap: a 100 MP image is far above any phone camera; refuses decompression bombs.
const MAX_INPUT_PIXELS = 100_000_000;

export function createSharpResizer(): ImageResizer {
  let mod: Promise<any> | null = null;
  return {
    async toJpeg(bytes, longEdge) {
      mod ??= import('sharp').then((m) => m.default ?? m);
      const sharp = await mod;
      const { data, info } = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
        .rotate()                                               // apply EXIF orientation, then drop metadata
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      return { bytes: new Uint8Array(data), width: info.width, height: info.height };
    },
  };
}

/** Group pdf.js text items into lines and blocks in top-left page coordinates (points at scale 1). */
export function textItemsToPage(items: Array<{ str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }>,
                                pageHeight: number, pageNo: number): PdfPageText {
  const blocks: OcrBlock[] = [];
  const lines: string[] = [];
  let current: string[] = [];
  let line = 1;
  let lastY: number | null = null;
  for (const it of items) {
    const str = it.str ?? '';
    const h = Math.abs(it.height || it.transform[3] || 0);
    const y = pageHeight - it.transform[5] - h;
    if (lastY !== null && Math.abs(y - lastY) > Math.max(h, 1) / 2 && current.length) {
      lines.push(current.join(' '));
      current = [];
      line++;
    }
    lastY = y;
    if (str.trim() !== '') {
      blocks.push({ text: str.trim(), bbox: [round(it.transform[4]), round(y), round(it.width), round(h)], conf: 1, line });
      current.push(str.trim());
    }
    if (it.hasEOL && current.length) {
      lines.push(current.join(' '));
      current = [];
      line++;
      lastY = null;
    }
  }
  if (current.length) lines.push(current.join(' '));
  return { page_no: pageNo, text: lines.join('\n'), blocks };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function createPdfTools(): PdfTools {
  let pdfjs: Promise<any> | null = null;
  const load = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));
  const open = async (bytes: Uint8Array) => {
    const lib = await load();
    // pdf.js may transfer the buffer: give it a copy so the caller's bytes stay usable
    return lib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, useSystemFonts: false });
  };
  const tools: PdfTools = {
    version: 'pdfjs-dist',
    async textPages(bytes, maxPages) {
      const task = await open(bytes);
      try {
        const doc = await task.promise;
        const pages: PdfPageText[] = [];
        for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
          const page = await doc.getPage(p);
          const vp = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          pages.push(textItemsToPage(tc.items.filter((i: any) => typeof i.str === 'string'), vp.height, p));
          page.cleanup();
        }
        return { pages, pageCount: doc.numPages };
      } finally {
        await task.destroy();
      }
    },
    async renderFirstPage(bytes, longEdge) {
      let canvasMod: any;
      try {
        canvasMod = await import('@napi-rs/canvas');
      } catch {
        return null;
      }
      const task = await open(bytes);
      try {
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) });
        const canvas = canvasMod.createCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        return { bytes: new Uint8Array(canvas.toBuffer('image/jpeg', 80)), width: canvas.width, height: canvas.height };
      } finally {
        await task.destroy();
      }
    },
  };
  void load().then((lib) => { tools.version = `pdfjs-dist ${lib.version ?? ''}`.trim(); }).catch(() => {});
  return tools;
}

export function isPdf(mime: string | null): boolean {
  return (mime ?? '').toLowerCase() === 'application/pdf';
}
