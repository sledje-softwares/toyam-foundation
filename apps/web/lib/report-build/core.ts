/**
 * Report generation in the office user's browser (7.7, D51), pure part: which cached file stands for each photo
 * source, the prepare / create answers' shape, error mapping, and what a retry keeps. No I/O (vitest). The
 * orchestration is run.ts, the browser wiring browser.ts; the progress text, button and messages are in ui.ts (kept
 * free of the shared writers so the workspace's first load stays small: everything here loads on the first click).
 */
import type { Variant } from "@/lib/evidence-view-core";
import { LayoutError } from "@shared/report/bind.ts";
import { INVALID_LAYOUT_MESSAGE, type PhotoRecord } from "@shared/report/assemble.ts";
import { DOCX_MIME } from "@shared/report/docx.ts";
import {
  fail,
  type Failure,
  type ImageSource,
  type PreparedPhoto,
  type PreparedReport,
  type ReportFormat,
  type StorageErrorLike,
} from "@shared/report-generate/logic.ts";

export type { Failure, PreparedReport, ReportFormat };
export { MAX_NOTES } from "@shared/report-generate/logic.ts";

/** Photos fetched at the same time (the file cache's download pool is 4 as well). */
export const PHOTO_POOL = 4;

export const CONTENT_TYPE: Record<ReportFormat, string> = { pdf: "application/pdf", docx: DOCX_MIME };

// ---------------------------------------------------------------------------------------------
// Photo sources → the browser file cache

/** The evidence-view variant of a planned source (device copies are w384 / w1600). */
export function variantFor(src: ImageSource): Variant {
  return src.kind === "copy384" ? "w384" : src.kind === "copy1600" ? "w1600" : "original";
}

const SHA = /^[0-9a-f]{64}$/;

/**
 * SHA-256 the database records for the bytes of this source (the copy's own hash, else the original's), read under
 * the user's RLS by prepare. A cached file with this hash is used with no network request; anything fetched is
 * checked against the hash evidence-view reads from the database. null = not known here (the link's hash decides).
 */
export function expectedSha(photo: PreparedPhoto, src: ImageSource): string | null {
  const v =
    src.kind === "original"
      ? photo.sha256
      : (photo.derivatives ?? []).find((d) => d.width === (src.kind === "copy384" ? 384 : 1600))?.sha256;
  return typeof v === "string" && SHA.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// prepare_report_version() / prepare_report_preview() result

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Enough of the shape to work on; anything else is treated as an unexpected answer. */
export function asPrepared(v: unknown): PreparedReport | null {
  if (!isObj(v) || !isObj(v.case) || !isObj(v.template)) return null;
  if (typeof v.case.id !== "string" || typeof v.case.case_ref !== "string" || typeof v.template.id !== "string") return null;
  if (typeof v.values_token !== "string" || typeof v.next_version !== "number") return null;
  if (!Array.isArray(v.sections) || !Array.isArray(v.photos)) return null;
  return v as unknown as PreparedReport;
}

/** create_report_version()'s answer. */
export function asCreated(v: unknown): { report_id: string; version: number; created: boolean } | null {
  if (!isObj(v) || typeof v.report_id !== "string" || typeof v.version !== "number") return null;
  return { report_id: v.report_id, version: v.version, created: v.created !== false };
}

// ---------------------------------------------------------------------------------------------
// Errors

export const UNEXPECTED = (): Failure => fail(502, "upstream_error", "Something went wrong. Try again later.");

/** A failure while building in the browser (pdfmake / Word writer), or a layout error. */
export function renderFailure(e: unknown): Failure {
  if (e instanceof LayoutError) return fail(422, "invalid_layout", INVALID_LAYOUT_MESSAGE, { issues: e.issues.slice(0, 10) });
  if (isObj(e) && e.name === "LayoutError") {
    // from the worker: a plain object { name, issues }
    const issues = Array.isArray(e.issues) ? e.issues.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
    return fail(422, "invalid_layout", INVALID_LAYOUT_MESSAGE, issues.length ? { issues } : {});
  }
  return fail(500, "pdf_failed", "The report could not be written in this browser. Reload the page and try again.");
}

/**
 * A retry may reuse the built files and report id only after a transient failure (storage or network). A changed
 * value (RV409) or any refusal starts over with a new prepare and a new report id.
 */
export function isResumable(f: Failure): boolean {
  return f.error.code === "upload_failed" || f.error.code === "upstream_error";
}

/** Storage's "the object already exists" (an earlier attempt's upload whose answer was lost). */
export function isAlreadyExists(e: (StorageErrorLike & { error?: string | null; code?: string | null }) | null | undefined): boolean {
  if (!e) return false;
  const s = Number(e.statusCode ?? e.status ?? 0);
  return s === 409 || e.code === "ResourceAlreadyExists" || /already exists|duplicate/i.test(`${e.error ?? ""} ${e.message ?? ""}`);
}

// ---------------------------------------------------------------------------------------------
// A generate attempt (kept in memory for a retry)

export interface BuiltFile {
  format: ReportFormat;
  bytes: Uint8Array;
  sha256: string;
  size_bytes: number;
  storage_path: string;
  content_type: string;
}

export interface Attempt {
  caseId: string;
  reportId: string;
  valuesToken: string;
  nextVersion: number;
  files: BuiltFile[];
  /** Formats whose object is in Storage (uploaded, or already there with the same size). */
  uploaded: ReportFormat[];
  photos: PhotoRecord[];
  warnings: string[];
  notes: string | null;
}

/** p_files of create_report_version. */
export function filesArg(a: Attempt) {
  return a.files.map((f) => ({ format: f.format, storage_path: f.storage_path, sha256: f.sha256, size_bytes: f.size_bytes }));
}

/** Two versions recorded at the same moment: the document prints the number prepare promised. */
export function versionWarning(recorded: number, printed: number): string | null {
  if (recorded === printed) return null;
  return `Another version was recorded at the same time: this one is version ${recorded}, but the document prints version ${printed}. Generate again if the number matters.`;
}
