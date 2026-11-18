/**
 * The report writers in the browser (7.7, D51): the pdfmake browser build and the open report fonts from this app's
 * own origin (`/fonts/<file>`, apps/web/public/fonts), handed to pdfmake as a virtual file system. pdfmake's URL and
 * local-file access are switched off (shared/report/files.ts), so it reads nothing by itself; photos arrive as bytes.
 * Loaded by the render worker (worker.ts) or, when no worker can run, by the page itself (render-client.ts).
 */
// Static import: this module is itself loaded lazily (the worker's own bundle, or a dynamic import on the page), so the
// worker needs no chunk loading of its own.
import * as pdfmakeModule from "pdfmake/build/pdfmake";
import { createReportRenderer, type PdfMakeLike, type RenderFilesInput, type RenderFilesOutput, type RenderStep, type ReportRenderer } from "@shared/report/files.ts";

async function loadPdfmake(): Promise<PdfMakeLike> {
  // CommonJS bundle: the instance is the module itself or its default export, depending on the interop.
  const mod = pdfmakeModule as unknown as PdfMakeLike & { default?: PdfMakeLike };
  const pm = mod.default && typeof mod.default.createPdf === "function" ? mod.default : mod;
  if (typeof pm.createPdf !== "function") throw new Error("pdfmake did not load");
  return pm;
}

/** One of REPORT_FONT_FILES from this origin (the HTTP cache keeps it; files.ts asks for each file once). */
async function fetchFont(file: string): Promise<Uint8Array> {
  const res = await fetch(new URL(`/fonts/${encodeURIComponent(file)}`, self.location.origin), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Font ${file} could not be loaded (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

let renderer: Promise<ReportRenderer> | null = null;
function browserRenderer(): Promise<ReportRenderer> {
  if (!renderer) {
    const r = loadPdfmake().then((pdfmake) => createReportRenderer({ pdfmake, loadFont: fetchFont }));
    renderer = r;
    r.catch(() => {
      if (renderer === r) renderer = null; // try again on the next render
    });
  }
  return renderer;
}

/** Resolves after the next frame has painted. */
const paint = () =>
  new Promise<void>((res) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(res, 0));
    else setTimeout(res, 0);
  });

let queue: Promise<unknown> = Promise.resolve();
/**
 * Renders one report at a time (pdfmake keeps fonts and files globally). `onPage`: running on the page's own thread,
 * so yield to the event loop before each writer (it blocks for about a second) to let the progress text paint.
 */
export function renderSerially(input: RenderFilesInput, onStep: (step: RenderStep) => void, onPage = false): Promise<RenderFilesOutput> {
  const run = queue.then(async () => {
    const r = await browserRenderer();
    return r.render(input, (step) => {
      onStep(step);
      return onPage ? paint() : undefined;
    });
  });
  queue = run.catch(() => undefined);
  return run;
}
