/**
 * Web Worker that writes the report files (7.7, D51), so pdfmake's second or so of work does not freeze the page.
 * Started by render-client.ts with `new Worker(new URL("./worker.ts", import.meta.url))`; pdfmake and the fonts load
 * here on the first render only. Messages: in `{id, input}` (layout + ReportData with the photo bytes); out
 * `{id, type: "step", step}`, `{id, type: "done", out}` (file buffers transferred) or `{id, type: "error", error}`.
 */
import type { RenderFilesInput } from "@shared/report/files.ts";
import { renderSerially } from "./renderer";

type Scope = {
  addEventListener(type: "message", fn: (e: MessageEvent<{ id: number; input: RenderFilesInput }>) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const scope = self as unknown as Scope;

scope.addEventListener("message", (e) => {
  const { id, input } = e.data;
  renderSerially(input, (step) => scope.postMessage({ id, type: "step", step }))
    .then((out) => {
      const buffers = [...new Set(out.files.map((f) => f.bytes.buffer as ArrayBuffer))];
      scope.postMessage({ id, type: "done", out }, buffers);
    })
    .catch((err: unknown) => {
      const o = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown; issues?: unknown };
      scope.postMessage({
        id,
        type: "error",
        error: {
          name: typeof o.name === "string" ? o.name : "Error",
          message: typeof o.message === "string" ? o.message : "The report could not be written.",
          issues: Array.isArray(o.issues) ? o.issues.filter((x) => typeof x === "string").slice(0, 10) : undefined,
        },
      });
    });
});
