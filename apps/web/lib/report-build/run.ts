/**
 * Report generation and preview in the office user's browser (7.7, D51): the order of work, against injected I/O
 * (browser.ts wires it to the user's own Supabase session, the file cache and the render worker; vitest uses fakes).
 *
 *   prepare (RPC, the database checks staff / case access / editable status)
 *   → photos (cache first, SHA-256 checked; a file that fails is a placeholder + warning, never placed)
 *   → Aadhaar masking of the placed copies (D55: OCR rows of the photos, first 8 digits blacked out; a photo that
 *     cannot be masked is placed with a warning, generation goes on)
 *   → PDF + Word (worker) → SHA-256 → upload to `reports/{case}/{report_id}/report.{pdf|docx}` (no upsert)
 *   → create_report_version (values token → RV409; size must equal the stored object's).
 *
 * A failed upload or record keeps the built files and the report id (Attempt): the retry skips the files already
 * stored and calls create_report_version again with the same id (it answers `created: false` when the version was in
 * fact recorded). RV409 or a refusal drops the attempt: the next click starts with a new prepare and a new id.
 */
import {
  formatsFor,
  type ImageFetcher,
  loadReportPhotos,
  placedPhotoRecords,
  planReportPhotos,
  preparedProblem,
  reportDataFrom,
} from "@shared/report/assemble.ts";
import { createAadhaarMasker, OCR_UNAVAILABLE_WARNING, ocrByEvidence, type OcrRowLike, type Painter } from "@shared/report/aadhaar.ts";
import type { RenderFilesInput, RenderFilesOutput, RenderStep } from "@shared/report/files.ts";
import type { ReportLayout } from "@shared/report/spec.ts";
import {
  type DbErrorLike,
  fail,
  type Failure,
  mapDbError,
  mapStorageError,
  MAX_NOTES,
  type Mode,
  type PreparedReport,
  reportPath,
  type StorageErrorLike,
} from "@shared/report-generate/logic.ts";
import {
  asCreated,
  asPrepared,
  type Attempt,
  type BuiltFile,
  CONTENT_TYPE,
  filesArg,
  isAlreadyExists,
  isResumable,
  PHOTO_POOL,
  renderFailure,
  UNEXPECTED,
  versionWarning,
} from "./core";
import type { Progress } from "./ui";

export interface CreateVersionArgs {
  p_case_id: string;
  p_report_id: string;
  p_values_token: string;
  p_files: ReturnType<typeof filesArg>;
  p_photos: Attempt["photos"];
  p_notes: string | null;
}

export interface RunDeps {
  /** rpc prepare_report_version (generate) or prepare_report_preview (preview) with the user's session. */
  prepare(caseId: string, mode: Mode): Promise<{ data: unknown; error: DbErrorLike | null }>;
  /** Verified bytes of one photo source (browser file cache), or null / a reason. */
  fetchPhoto: ImageFetcher;
  /** evidence_ocr rows (page 1, current or not) of these files under the user's RLS; null when they cannot be read. */
  loadOcr(evidenceIds: string[]): Promise<OcrRowLike[] | null>;
  /** Blacks out rectangles on the placed copy of a photo (canvas); throws when it cannot. */
  paintMask: Painter;
  /** The writers (Web Worker, or the page when no worker can run). Throws on a layout or writer error. */
  render(input: RenderFilesInput, onStep: (step: RenderStep) => void): Promise<RenderFilesOutput>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** Upload to bucket `reports` with the user's session, no upsert. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: (StorageErrorLike & { error?: string }) | null }>;
  /** Size of an object in bucket `reports` (null when unknown / not visible). */
  objectSize(path: string): Promise<number | null>;
  /** rpc create_report_version with the user's session. */
  createVersion(args: CreateVersionArgs): Promise<{ data: unknown; error: DbErrorLike | null }>;
  now(): Date;
  newId(): string;
}

type Built = { prepared: PreparedReport; out: RenderFilesOutput; photos: Attempt["photos"]; warnings: string[] };

const creator = "Toyam Investigation and Valuation";

/** prepare → photos → files; shared by generate and preview. */
async function build(deps: RunDeps, caseId: string, mode: Mode, onProgress: (p: Progress) => void): Promise<Built | Failure> {
  onProgress({ phase: "preparing" });
  let prep: { data: unknown; error: DbErrorLike | null };
  try {
    prep = await deps.prepare(caseId, mode);
  } catch {
    return UNEXPECTED();
  }
  if (prep.error) return mapDbError(prep.error);
  const prepared = asPrepared(prep.data);
  if (!prepared) return UNEXPECTED();
  const problem = preparedProblem(prepared, mode);
  if (problem) return problem;

  const warnings: string[] = [];
  const plans = planReportPhotos(prepared, mode);
  if (plans.length) onProgress({ phase: "photos", done: 0, total: plans.length });
  const ids = [...new Set(plans.filter((x) => x.sources.length).map((x) => x.photo.evidence_id))];
  let ocr: OcrRowLike[] | null = [];
  if (ids.length) {
    try {
      ocr = await deps.loadOcr(ids);
    } catch {
      ocr = null;
    }
    if (ocr === null) warnings.push(OCR_UNAVAILABLE_WARNING);
  }
  const loaded = await loadReportPhotos(plans, deps.fetchPhoto, {
    poolSize: PHOTO_POOL,
    warnings,
    onProgress: (done, total) => onProgress({ phase: "photos", done, total }),
    mask: createAadhaarMasker(ocr ? ocrByEvidence(ocr) : null, deps.paintMask),
  });
  const data = reportDataFrom(prepared, loaded, deps.now().toISOString());
  let out: RenderFilesOutput;
  try {
    out = await deps.render(
      { layout: prepared.report_layout as ReportLayout, data, formats: formatsFor(prepared, mode), now: deps.now(), creator },
      (step) => onProgress({ phase: step }),
    );
  } catch (e) {
    return renderFailure(e);
  }
  warnings.push(...out.warnings);
  return { prepared, out, photos: placedPhotoRecords(loaded, out.placedKeys), warnings };
}

const isFailure = (v: unknown): v is Failure => typeof v === "object" && v !== null && "error" in v && "status" in v;

export type PreviewResult = { ok: true; pdf: Uint8Array; warnings: string[] } | { ok: false; failure: Failure };

/** The PDF exactly as Generate would write it now (prepare_report_preview: any status; nothing is stored). */
export async function runPreview(deps: RunDeps, caseId: string, onProgress: (p: Progress) => void): Promise<PreviewResult> {
  const b = await build(deps, caseId, "preview", onProgress);
  if (isFailure(b)) return { ok: false, failure: b };
  const pdf = b.out.files.find((f) => f.format === "pdf");
  return pdf ? { ok: true, pdf: pdf.bytes, warnings: b.warnings } : { ok: false, failure: renderFailure(null) };
}

export type GenerateResult =
  | { ok: true; reportId: string; version: number; created: boolean; warnings: string[] }
  | { ok: false; failure: Failure; attempt: Attempt | null; warnings: string[] };

/** Builds the files of a new attempt (new report id) after a fresh prepare. */
async function newAttempt(deps: RunDeps, caseId: string, notes: string | null, onProgress: (p: Progress) => void): Promise<Attempt | Failure> {
  const b = await build(deps, caseId, "generate", onProgress);
  if (isFailure(b)) return b;
  const reportId = deps.newId();
  const files: BuiltFile[] = [];
  for (const f of b.out.files) {
    files.push({
      format: f.format,
      bytes: f.bytes,
      sha256: await deps.sha256(f.bytes),
      size_bytes: f.bytes.length,
      storage_path: reportPath(b.prepared.case.id, reportId, f.format),
      content_type: CONTENT_TYPE[f.format],
    });
  }
  return {
    caseId: b.prepared.case.id,
    reportId,
    valuesToken: b.prepared.values_token,
    nextVersion: b.prepared.next_version,
    files,
    uploaded: [],
    photos: b.photos,
    warnings: b.warnings,
    notes,
  };
}

/** Stores the files not stored yet; an object that already exists with the same size counts as stored. */
async function uploadAll(deps: RunDeps, a: Attempt): Promise<Failure | null> {
  for (const f of a.files) {
    if (a.uploaded.includes(f.format)) continue;
    let error: (StorageErrorLike & { error?: string }) | null;
    try {
      ({ error } = await deps.upload(f.storage_path, f.bytes, f.content_type));
    } catch {
      return fail(502, "upload_failed", "The report files could not be stored. Try again.");
    }
    if (error && isAlreadyExists(error)) {
      let size: number | null = null;
      try {
        size = await deps.objectSize(f.storage_path);
      } catch {
        return fail(502, "upload_failed", "The report files could not be stored. Try again.");
      }
      // Same report id, same size: our own earlier upload whose answer was lost. Anything else: start over.
      if (size !== f.size_bytes) return fail(409, "invalid_case", "A file of this attempt is already stored with another size. Generate the report again.");
    } else if (error) {
      return mapStorageError(error);
    }
    a.uploaded = [...a.uploaded, f.format];
  }
  return null;
}

/**
 * Generates a new version, or finishes `attempt` (a kept attempt of the same case after a transient failure).
 * The caller keeps `attempt` from a failed result for the next click.
 */
export async function runGenerate(
  deps: RunDeps,
  input: { caseId: string; notes?: string | null; attempt?: Attempt | null },
  onProgress: (p: Progress) => void,
): Promise<GenerateResult> {
  const notes = input.notes?.trim() || null;
  if (notes && [...notes].length > MAX_NOTES) {
    return { ok: false, failure: fail(400, "invalid_input", `Keep the notes under ${MAX_NOTES} characters.`), attempt: null, warnings: [] };
  }
  let a: Attempt;
  if (input.attempt && input.attempt.caseId.toLowerCase() === input.caseId.toLowerCase()) {
    a = input.attempt;
  } else {
    const made = await newAttempt(deps, input.caseId, notes, onProgress);
    if (isFailure(made)) return { ok: false, failure: made, attempt: null, warnings: [] };
    a = made;
  }
  const keep = (f: Failure): GenerateResult => ({ ok: false, failure: f, attempt: isResumable(f) ? a : null, warnings: a.warnings });

  onProgress({ phase: "uploading" });
  const upFailure = await uploadAll(deps, a);
  if (upFailure) return keep(upFailure);

  let created: { data: unknown; error: DbErrorLike | null };
  try {
    created = await deps.createVersion({
      p_case_id: a.caseId,
      p_report_id: a.reportId,
      p_values_token: a.valuesToken,
      p_files: filesArg(a),
      p_photos: a.photos,
      p_notes: a.notes,
    });
  } catch {
    return keep(UNEXPECTED());
  }
  if (created.error) return keep(mapDbError(created.error));
  const c = asCreated(created.data);
  if (!c) return keep(UNEXPECTED());
  const w = versionWarning(c.version, a.nextVersion);
  return { ok: true, reportId: c.report_id, version: c.version, created: c.created, warnings: w ? [...a.warnings, w] : a.warnings };
}
