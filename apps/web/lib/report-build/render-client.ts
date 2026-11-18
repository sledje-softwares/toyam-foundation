/**
 * Runs the report writers in a Web Worker (worker.ts), one worker per page load, reused for every render. When no
 * worker can start (no Worker support, the script fails to load), the same writers run on the page itself
 * (renderer.ts, yielding to the event loop before each writer so the progress text paints). Client components only.
 */
import type { RenderFilesInput, RenderFilesOutput, RenderStep } from "@shared/report/files.ts";

type Reply =
  | { id: number; type: "step"; step: RenderStep }
  | { id: number; type: "done"; out: RenderFilesOutput }
  | { id: number; type: "error"; error: { name: string; message: string; issues?: string[] } };

type Pending = { resolve: (out: RenderFilesOutput) => void; reject: (e: unknown) => void; onStep: (step: RenderStep) => void };

class WorkerUnavailable extends Error {}

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(e: unknown) {
  for (const p of pending.values()) p.reject(e);
  pending.clear();
}

function getWorker(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { name: "report-writer" });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === "step") {
      p.onStep(e.data.step);
      return;
    }
    pending.delete(e.data.id);
    if (e.data.type === "done") p.resolve(e.data.out);
    else p.reject(Object.assign(new Error(e.data.error.message), { name: e.data.error.name, issues: e.data.error.issues }));
  };
  // The script did not load or crashed: never use a worker again on this page; the waiting renders run on the page.
  worker.onerror = (ev) => {
    ev.preventDefault();
    broken = true;
    worker?.terminate();
    worker = null;
    failAll(new WorkerUnavailable());
  };
  return worker;
}

function viaWorker(w: Worker, input: RenderFilesInput, onStep: (step: RenderStep) => void): Promise<RenderFilesOutput> {
  const id = ++seq;
  return new Promise<RenderFilesOutput>((resolve, reject) => {
    pending.set(id, { resolve, reject, onStep });
    try {
      w.postMessage({ id, input }); // photo bytes are copied: the page keeps its own for a retry
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

/** PDF / Word files for one report, in a worker when possible. Throws on a layout or writer error. */
export async function renderReport(input: RenderFilesInput, onStep: (step: RenderStep) => void): Promise<RenderFilesOutput> {
  const w = getWorker();
  if (w) {
    try {
      return await viaWorker(w, input, onStep);
    } catch (e) {
      if (!(e instanceof WorkerUnavailable)) throw e;
    }
  }
  const { renderSerially } = await import("./renderer");
  return renderSerially(input, onStep, true);
}
