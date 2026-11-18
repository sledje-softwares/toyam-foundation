/**
 * What the workspace shows while a report is built in the browser (7.7, D51): progress text, the Generate button and
 * the messages for a failure. Pure and dependency-free on purpose: the page loads this file up front, while the
 * writers, pdfmake and the fonts load only when the user generates or previews (run.ts, worker.ts).
 */
import type { Failure } from "@shared/report-generate/logic.ts";

/** The sentence shown under the buttons; `resumable` = the built files are kept for a retry (core.ts isResumable). */
export function userMessage(f: Failure, resumable = false): string {
  let m: string;
  switch (f.error.code) {
    case "values_changed":
      m = "Someone changed the report fields while it was generating. The page now shows the new values: generate it again.";
      break;
    case "unauthorized":
      m = "Your session has ended. Sign in again.";
      break;
    default:
      m = f.error.message || "The report could not be generated. Try again, or ask the admin if it keeps failing.";
  }
  return resumable ? `${m} The files are kept: a retry only stores and records them.` : m;
}

// ---------------------------------------------------------------------------------------------
// Progress and the Generate button

export type Progress =
  | { phase: "preparing" }
  | { phase: "photos"; done: number; total: number }
  | { phase: "pdf" }
  | { phase: "docx" }
  | { phase: "uploading" };

export function progressText(p: Progress): string {
  switch (p.phase) {
    case "preparing":
      return "Preparing…";
    case "photos":
      return `Photos ${p.done}/${p.total}…`;
    case "pdf":
      return "Writing PDF…";
    case "docx":
      return "Writing Word file…";
    case "uploading":
      return "Uploading…";
  }
}

export type GenerateUi =
  | { status: "idle" }
  | { status: "running"; progress: Progress }
  | { status: "done"; version: number; warnings: string[] }
  | { status: "error"; message: string; warnings: string[]; resumable: boolean };

export const IDLE: GenerateUi = { status: "idle" };

export function doneText(version: number): string {
  return `Saved as version ${version}`;
}

/** Disabled while a run is in progress; "Retry" when the built files are kept for the remaining steps. */
export function buttonState(ui: GenerateUi, ready: boolean): { disabled: boolean; label: string } {
  if (ui.status === "running") return { disabled: true, label: "Generating report…" };
  if (!ready) return { disabled: true, label: "Generate report" };
  if (ui.status === "error" && ui.resumable) return { disabled: false, label: "Retry saving the report" };
  return { disabled: false, label: "Generate report" };
}

/** `<case_ref>_preview.pdf` for the preview's download button. */
export function previewFileName(caseRef: string): string {
  return `${caseRef.replace(/[^A-Za-z0-9_-]+/g, "_")}_preview.pdf`;
}
