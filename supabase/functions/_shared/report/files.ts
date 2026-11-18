// Layout + ReportData → the report files (PDF with pdfmake, Word with docx.ts), bound once for both writers (D51:
// built in the office user's browser, apps/web/lib/report-build; also run from Node tests with the same pdfmake
// build). pdfmake is injected (no npm import here) and is a page-wide singleton: renders must not overlap.
// The pdfmake definition is built fresh for every render (pdfmake mutates it). Fonts come from the injected loader into
// pdfmake's virtual file system, and URL / local file access is switched off, so pdfmake reads nothing by itself.
import type { ReportData, ResolvedDocument } from './bind.ts';
import { bindReport } from './bind.ts';
import { docxFromDocument } from './docx.ts';
import { toBase64 } from './image.ts';
import { pdfFontsUsed, pdfmakeFonts, pdfmakeFromDocument, REPORT_FONT_FILES, type PdfFontVariant } from './pdfmake.ts';
import type { ReportLayout } from './spec.ts';
import { placedPhotoKeys } from './assemble.ts';
import { isPdf, type ReportFormat } from '../report-generate/logic.ts';

/** The parts of the pdfmake 0.3 browser build (`pdfmake/build/pdfmake.js`) this module uses. */
export interface PdfMakeLike {
  addVirtualFileSystem(vfs: Record<string, string>): void;
  setFonts(fonts: Record<string, Partial<Record<PdfFontVariant, string>>>): void;
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  /** Read by createPdf; the browser build has no setter (the Node build's setLocalAccessPolicy). */
  localAccessPolicy?: ((path: string) => boolean) | undefined;
  createPdf(definition: never): { getBuffer(): Promise<Uint8Array> };
}

export interface RenderFilesInput {
  layout: ReportLayout;
  data: ReportData;
  /** Files to write, in this order. */
  formats: ReportFormat[];
  /** Creation time printed in the PDF info and the Word properties. */
  now: Date;
  creator?: string;
}

export interface RenderedFile {
  format: ReportFormat;
  bytes: Uint8Array;
}

export interface RenderFilesOutput {
  files: RenderedFile[];
  /** Binding warnings (unknown field, missing runtime asset, ...). */
  warnings: string[];
  /** `photoKey`s of the photos whose image is in the document (assemble.ts placedPhotoRecords). */
  placedKeys: string[];
}

export type RenderStep = 'pdf' | 'docx';

export interface ReportRenderer {
  /**
   * Throws LayoutError for an invalid layout, an Error when pdfmake fails or does not return a PDF. `onStep` is called
   * before each writer; a returned promise is awaited (the page yields there so its progress text can paint).
   */
  render(input: RenderFilesInput, onStep?: (step: RenderStep) => void | Promise<void>): Promise<RenderFilesOutput>;
}

const FONT_FILES = new Set(Object.values(REPORT_FONT_FILES).flatMap((v) => Object.values(v)));

/**
 * A renderer over one pdfmake instance. `loadFont(file)` returns the bytes of one of REPORT_FONT_FILES (the browser
 * fetches `/fonts/<file>` from its own origin); each file is loaded once per renderer and only when a report uses it.
 */
export function createReportRenderer(deps: { pdfmake: PdfMakeLike; loadFont: (file: string) => Promise<Uint8Array> }): ReportRenderer {
  const { pdfmake } = deps;
  const loaded = new Set<string>();
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.localAccessPolicy = () => false; // fonts are in the virtual file system, images are data: URLs

  async function ensureFonts(files: string[]): Promise<void> {
    const missing = files.filter((f) => !loaded.has(f));
    if (!missing.length) return;
    const bytes = await Promise.all(missing.map((f) => {
      if (!FONT_FILES.has(f)) throw new Error(`Unknown font file ${f}`);
      return deps.loadFont(f);
    }));
    const vfs: Record<string, string> = {};
    missing.forEach((f, i) => { vfs[f] = toBase64(bytes[i]); });
    pdfmake.addVirtualFileSystem(vfs);
    for (const f of missing) loaded.add(f);
  }

  async function pdf(doc: ResolvedDocument, input: RenderFilesInput): Promise<Uint8Array> {
    const definition = pdfmakeFromDocument(doc, { creator: input.creator, now: input.now });
    const fonts = pdfmakeFonts(pdfFontsUsed(definition), (f) => f);
    await ensureFonts(Object.values(fonts).flatMap((v) => Object.values(v) as string[]));
    pdfmake.setFonts(fonts);
    const out = await pdfmake.createPdf(definition as never).getBuffer();
    const bytes = out instanceof Uint8Array ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength) : new Uint8Array(out as ArrayBuffer);
    if (!isPdf(bytes)) throw new Error('pdfmake did not return a PDF');
    return bytes;
  }

  return {
    async render(input, onStep) {
      const doc = bindReport(input.layout, input.data);
      const files: RenderedFile[] = [];
      for (const format of input.formats) {
        await onStep?.(format);
        files.push({ format, bytes: format === 'pdf' ? await pdf(doc, input) : await docxFromDocument(doc, { now: input.now, creator: input.creator }) });
      }
      return { files, warnings: [...doc.warnings], placedKeys: placedPhotoKeys(doc, input.data) };
    },
  };
}
