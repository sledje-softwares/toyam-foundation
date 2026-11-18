/**
 * Pure helpers shared by the server pages that show files and the client components that load them through the cache:
 * what the page tells the browser about each file (hashes of every variant, read from the database under RLS), which
 * variant a thumbnail / preview uses, request validation for the server actions, and UI state for one image.
 */
import { hasThumbnail, isUuid, type Variant } from "@/lib/evidence-view-core";
import { FileFetchError, FILE_ERROR_MESSAGES, isSha256, type FileErrorKind } from "./core";

/** One evidence file as the page passes it to the client: enough to find it in the cache with no network request. */
export type CachedFile = {
  evidenceId: string;
  caseId: string;
  /** The original's type (copies are always image/jpeg). */
  mime: string | null;
  original: { sha256: string | null; size: number | null };
  w384: { sha256: string; size: number | null; width: number | null } | null;
  w1600: { sha256: string; size: number | null; width: number | null } | null;
};

/**
 * Built from the page's own evidence select (under RLS), which adds
 * `case_id, sha256, size_bytes, evidence_derivatives(width, sha256, size_bytes, pixel_width)`.
 */
type DerivativeCols = { width: number; sha256: string; size_bytes: number | null; pixel_width: number | null };
export function toCachedFile(row: {
  id: string;
  case_id: string;
  evidence_type: string;
  mime_type: string | null;
  sha256: string | null;
  size_bytes: number | null;
  evidence_derivatives?: DerivativeCols[] | null;
}): CachedFile | null {
  if (row.evidence_type === "note") return null;
  const copy = (w: number) => {
    const d = (row.evidence_derivatives ?? []).find((x) => x.width === w && isSha256(x.sha256));
    return d ? { sha256: d.sha256, size: d.size_bytes ?? null, width: d.pixel_width ?? null } : null;
  };
  return {
    evidenceId: row.id,
    caseId: row.case_id,
    mime: row.mime_type,
    original: { sha256: isSha256(row.sha256) ? row.sha256 : null, size: row.size_bytes ?? null },
    w384: copy(384),
    w1600: copy(1600),
  };
}

/** An original larger than this is not loaded as a thumbnail (insurer attachments have no copies). */
export const THUMB_ORIGINAL_MAX_BYTES = 15 * 1024 * 1024;

export type Source = { variant: Variant; expectedSha256: string | null };

/**
 * Thumbnail: the 384 px copy, else the 1600 px copy, else the original when the browser can show it inline and it is not
 * huge. Preview: the 1600 px copy, else the original (inline-safe images only). null = no in-page image (placeholder;
 * the file opens through /files/...).
 */
export function chooseSource(f: CachedFile, purpose: "thumb" | "preview"): Source | null {
  const copies = purpose === "thumb" ? [f.w384 && { variant: "w384" as const, c: f.w384 }, f.w1600 && { variant: "w1600" as const, c: f.w1600 }] : [f.w1600 && { variant: "w1600" as const, c: f.w1600 }];
  for (const x of copies) if (x) return { variant: x.variant, expectedSha256: x.c.sha256 };
  if (!hasThumbnail(f.mime)) return null;
  if (purpose === "thumb" && (f.original.size ?? 0) > THUMB_ORIGINAL_MAX_BYTES) return null;
  return { variant: "original", expectedSha256: f.original.sha256 };
}

/** Valid, distinct, lower-cased UUIDs, at most `max`; null when the input is not such a list. */
export function parseIdList(v: unknown, max: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !isUuid(x)) return null;
    const id = x.toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type ImageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; fromCache: boolean }
  | { status: "error"; kind: FileErrorKind; message: string };

export function errorState(e: unknown): Extract<ImageState, { status: "error" }> {
  if (e instanceof FileFetchError) return { status: "error", kind: e.kind, message: e.message };
  return { status: "error", kind: "link", message: FILE_ERROR_MESSAGES.link };
}
