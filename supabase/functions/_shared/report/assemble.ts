// prepare_report_version() / prepare_report_preview() result + photo bytes → ReportData, and back from the resolved
// document to the photos actually placed (create_report_version's p_photos). Shared by the office user's browser
// (apps/web/lib/report-build, D51) and the report-generate edge function, so both pick, budget, order and record
// photos the same way. Pure: the bytes come from an injected fetcher; no npm imports (Deno + Node type stripping).
import type { RBlock, ReportData, ReportPhoto, ResolvedDocument } from './bind.ts';
import { fieldsFromSections } from './bind.ts';
import { sniffImage } from './image.ts';
import { validateLayout } from './validate.ts';
import {
  caseFacts, fail, type Failure, type ImageSource, imageSources, MAX_IMAGE_BYTES, MAX_PREVIEW_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
  type Mode, photoSections, pool, type PreparedPhoto, type PreparedReport, type ReportFormat, templateFormats,
} from '../report-generate/logic.ts';

export const INVALID_LAYOUT_MESSAGE = 'The report layout of this template is invalid. Ask an admin to fix and reload it.';

/**
 * Why the prepared report cannot be written at all (no layout, invalid layout, no output format), or null.
 * Preview needs no output format.
 */
export function preparedProblem(prepared: PreparedReport, mode: Mode): Failure | null {
  const layout = prepared.report_layout;
  if (layout === null || layout === undefined) {
    return fail(422, 'no_layout',
      'This insurer template has no report layout yet, so the report cannot be generated. Ask an admin to load the layout for this template.');
  }
  const issues = validateLayout(layout);
  if (issues.length) return fail(422, 'invalid_layout', INVALID_LAYOUT_MESSAGE, { issues: issues.slice(0, 10) });
  if (mode === 'generate' && templateFormats(prepared).length === 0) {
    return fail(422, 'no_formats', 'This insurer template lists no PDF or Word output.');
  }
  return null;
}

/** The formats one run writes: the template's for generate, the PDF alone for a preview. */
export function formatsFor(prepared: PreparedReport, mode: Mode): ReportFormat[] {
  return mode === 'preview' ? ['pdf'] : templateFormats(prepared);
}

// ---------------------------------------------------------------------------------------------
// Photos: which ones, which file each, within the byte budget

export interface PhotoPlan {
  photo: PreparedPhoto;
  /** `Photo "caption" (section title)`, for warnings. */
  label: string;
  /** Files to try in order (device copy first); empty when skipped. */
  sources: ImageSource[];
  /** Why no file is tried (unsupported type, too large, over the budget), or null. */
  skip: string | null;
}

/** Byte budget of all images in one report. */
export const imageBudget = (mode: Mode) => (mode === 'preview' ? MAX_PREVIEW_IMAGE_BYTES : MAX_TOTAL_IMAGE_BYTES);

/**
 * Photos of the sections some `photos` block of the layout shows, in prepare's order (section, then position), each
 * with its candidate files (`imageSources`). The budget counts the recorded size of the first choice (unknown = the
 * per-image maximum); photos past it are skipped.
 */
export function planReportPhotos(prepared: PreparedReport, mode: Mode): PhotoPlan[] {
  const shown = photoSections(prepared.report_layout);
  const sectionTitle = new Map(prepared.sections.map((s) => [s.key, s.title]));
  const photos = (prepared.photos ?? []).filter((p) => shown.has(p.section_key));
  const budget = imageBudget(mode);
  let planned = 0;
  return photos.map((p) => {
    const plan = imageSources(p, mode);
    const label = `Photo "${p.caption ?? p.category_name ?? 'untitled'}" (${sectionTitle.get(p.section_key) ?? p.section_key})`;
    if (plan.skip !== null) return { photo: p, label, sources: [], skip: plan.skip };
    const size = plan.sources[0].size ?? MAX_IMAGE_BYTES;
    if (planned + size > budget) return { photo: p, label, sources: [], skip: 'the report already holds as many image bytes as it can' };
    planned += size;
    return { photo: p, label, sources: plan.sources, skip: null };
  });
}

export interface LoadedPhoto {
  photo: PreparedPhoto;
  rp: ReportPhoto;
}

/** Bytes of one candidate file; null (or a reason) when it cannot be used. Must never return unverified bytes. */
export type ImageFetcher = (src: ImageSource, photo: PreparedPhoto) => Promise<Uint8Array | null | { reason: string }>;

/**
 * Fetches each planned photo (`poolSize` at a time, results in plan order), trying its sources in order. Bytes must be
 * a JPEG or PNG of at most MAX_IMAGE_BYTES; anything else falls through to the next source. A photo with no usable
 * file gets `image: null` (the writers print a dashed box with the caption) and a warning.
 */
export async function loadReportPhotos(
  plans: PhotoPlan[],
  fetchImage: ImageFetcher,
  opts: { poolSize: number; warnings: string[]; onProgress?: (done: number, total: number) => void },
): Promise<LoadedPhoto[]> {
  let done = 0;
  const tick = () => opts.onProgress?.(++done, plans.length);
  return pool(plans, opts.poolSize, async ({ photo: p, label, sources, skip }): Promise<LoadedPhoto> => {
    let reason = skip;
    for (const src of sources) {
      let got: Uint8Array | null | { reason: string };
      try {
        got = await fetchImage(src, p);
      } catch {
        got = null;
      }
      if (!(got instanceof Uint8Array)) { reason = got?.reason ?? 'the file could not be read'; continue; }
      if (got.length === 0) { reason = 'the file could not be read'; continue; }
      if (got.length > MAX_IMAGE_BYTES) { reason = `the file is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`; continue; }
      const mime = sniffImage(got);
      if (!mime) { reason = 'the file is not a JPEG or PNG'; continue; }
      tick();
      return {
        photo: p,
        rp: {
          evidence_id: p.evidence_id, caption: p.caption,
          image: { bytes: got, mime, ...(src.width && src.height ? { width: src.width, height: src.height } : {}) },
        },
      };
    }
    opts.warnings.push(`${label}: ${reason ?? 'not available'}; an empty box with the caption is printed instead.`);
    tick();
    return { photo: p, rp: { evidence_id: p.evidence_id, caption: p.caption, image: null } };
  });
}

/** ReportData for the writers: header facts, field values, photos per section in position order. */
export function reportDataFrom(prepared: PreparedReport, loaded: LoadedPhoto[], generatedAt: string): ReportData {
  const photos: Record<string, ReportPhoto[]> = {};
  for (const l of loaded) (photos[l.photo.section_key] ??= []).push(l.rp);
  const pos = new Map(loaded.map((l) => [l.rp, l.photo.position]));
  for (const k of Object.keys(photos)) photos[k].sort((a, b) => pos.get(a)! - pos.get(b)!);
  return { case: caseFacts(prepared, generatedAt), fields: fieldsFromSections(prepared.sections), photos };
}

// ---------------------------------------------------------------------------------------------
// Photos actually placed

/** Image byte arrays that ended up in the document (identity). */
export function placedImageBytes(doc: ResolvedDocument): Set<Uint8Array> {
  const out = new Set<Uint8Array>();
  const walk = (blocks: RBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === 'image' && b.image) out.add(b.image.bytes);
      else if (b.kind === 'group') walk(b.blocks);
      else if (b.kind === 'table') for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
    }
  };
  walk(doc.body);
  walk(doc.header);
  walk(doc.footer);
  return out;
}

export const photoKey = (sectionKey: string, evidenceId: string | undefined) => `${sectionKey}\u0000${evidenceId ?? ''}`;

/**
 * Keys (`photoKey`) of the photos of `data` whose image was embedded in `doc` (bound from that same `data`, so the
 * byte arrays are the same objects). Plain strings: they survive a postMessage to and from a Web Worker.
 */
export function placedPhotoKeys(doc: ResolvedDocument, data: ReportData): string[] {
  const placed = placedImageBytes(doc);
  const out: string[] = [];
  for (const [section, list] of Object.entries(data.photos ?? {})) {
    for (const p of list) if (p.image && placed.has(p.image.bytes)) out.push(photoKey(section, p.evidence_id));
  }
  return out;
}

export interface PhotoRecord {
  evidence_id: string;
  section_key: string;
  position: number;
  caption: string | null;
}

/** create_report_version's p_photos: the loaded photos whose key is in `placedKeys`, in load order. */
export function placedPhotoRecords(loaded: LoadedPhoto[], placedKeys: Iterable<string>): PhotoRecord[] {
  const keys = new Set(placedKeys);
  return loaded
    .filter((l) => l.rp.image && keys.has(photoKey(l.photo.section_key, l.photo.evidence_id)))
    .map((l) => ({ evidence_id: l.photo.evidence_id, section_key: l.photo.section_key, position: l.photo.position, caption: l.photo.caption }));
}
