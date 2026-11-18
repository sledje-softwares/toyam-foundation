/**
 * Pure parts of the evidence-view wrapper (contract: supabase/functions/evidence-view/README.md): request batching,
 * reply parsing, which files get a thumbnail and the `/files/...` redirect paths. No server imports, unit-testable.
 */
export type FileKind = "evidence" | "attachment";
export type Disposition = "inline" | "attachment";
/** Which bytes of an evidence file: the original, or the field app's 384 px / 1600 px JPEG copy (D51). */
export type Variant = "original" | "w384" | "w1600";
export const VARIANTS: readonly Variant[] = ["original", "w384", "w1600"];
export const isVariant = (v: unknown): v is Variant => typeof v === "string" && (VARIANTS as readonly string[]).includes(v);

export type FileLink = {
  kind: FileKind;
  id: string;
  url: string;
  expires_at: string;
  content_type: string;
  file_name: string;
  disposition: Disposition;
  /** What was served: the asked-for copy, or "original" when the file has no copy. */
  variant: Variant;
  /** SHA-256 of the served bytes as the database records it (64 lower-case hex), or null when unknown. */
  sha256: string | null;
  size_bytes: number | null;
  /** Pixel width of a served copy, or null. */
  width: number | null;
  mime: string;
};
export type FileLinkError = { kind: FileKind; id: string; error: string };

export type LinksResult =
  | { ok: true; links: Map<string, FileLink>; errors: Map<string, string> }
  | { ok: false; code: string; message: string };

/** Ids per function call (the function's limit). */
export const MAX_IDS_PER_CALL = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

/** Map key for a link: attachments and evidence ids live in different tables. */
export const linkKey = (kind: FileKind, id: string) => `${kind}:${id.toLowerCase()}`;

export type ViewBody = { evidence_ids?: string[]; attachment_ids?: string[]; disposition: Disposition; variant?: Variant };

/** Splits ids into function-sized bodies (valid UUIDs only, repeats dropped). `variant` applies to evidence ids. */
export function batchBodies(evidenceIds: string[], attachmentIds: string[], disposition: Disposition, variant: Variant = "original"): ViewBody[] {
  const items: { kind: FileKind; id: string }[] = [];
  const seen = new Set<string>();
  for (const [kind, ids] of [
    ["evidence", evidenceIds],
    ["attachment", attachmentIds],
  ] as const) {
    for (const raw of ids) {
      const k = linkKey(kind, raw);
      if (!isUuid(raw) || seen.has(k)) continue;
      seen.add(k);
      items.push({ kind, id: raw.toLowerCase() });
    }
  }
  const bodies: ViewBody[] = [];
  for (let i = 0; i < items.length; i += MAX_IDS_PER_CALL) {
    const part = items.slice(i, i + MAX_IDS_PER_CALL);
    const ev = part.filter((p) => p.kind === "evidence").map((p) => p.id);
    const at = part.filter((p) => p.kind === "attachment").map((p) => p.id);
    bodies.push({
      ...(ev.length ? { evidence_ids: ev } : {}),
      ...(at.length ? { attachment_ids: at } : {}),
      disposition,
      ...(variant !== "original" ? { variant } : {}),
    });
  }
  return bodies;
}

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  rate_limited: "Too many files were opened at once. Wait a minute and try again.",
  storage_not_configured: "File storage is not available yet. Try again later.",
  not_found: "This file does not exist or you cannot open it.",
  no_file: "This entry is a note; there is no file to open.",
  archived: "This file has been moved to the long-term archive. Ask an admin for a copy.",
  unavailable: "A link to this file could not be made. Try again.",
};
export const GENERIC_LINK_FAILURE = "The file could not be opened. Try again.";
export const linkErrorMessage = (code: string) => MESSAGES[code] ?? GENERIC_LINK_FAILURE;

function failure(e: unknown): Extract<LinksResult, { ok: false }> {
  const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
  const code = typeof o.code === "string" ? o.code : "internal";
  return { ok: false, code, message: linkErrorMessage(code) };
}

const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);
const sha = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Reads one function reply body into links and per-file errors (anything malformed is dropped). */
export function parseViewReply(body: unknown): LinksResult {
  if (typeof body !== "object" || body === null) return failure(null);
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return failure(b.error);
  const links = new Map<string, FileLink>();
  const errors = new Map<string, string>();
  for (const f of Array.isArray(b.files) ? b.files : []) {
    if (typeof f !== "object" || f === null) continue;
    const x = f as Record<string, unknown>;
    if ((x.kind !== "evidence" && x.kind !== "attachment") || typeof x.id !== "string") continue;
    const key = linkKey(x.kind, x.id);
    if (typeof x.error === "string") errors.set(key, x.error);
    else if (isHttpUrl(x.url)) {
      const contentType = typeof x.content_type === "string" ? x.content_type : "application/octet-stream";
      links.set(key, {
        kind: x.kind,
        id: x.id,
        url: x.url,
        expires_at: typeof x.expires_at === "string" ? x.expires_at : "",
        content_type: contentType,
        file_name: typeof x.file_name === "string" ? x.file_name : "",
        disposition: x.disposition === "attachment" ? "attachment" : "inline",
        variant: isVariant(x.variant) ? x.variant : "original",
        sha256: sha(x.sha256),
        size_bytes: count(x.size_bytes),
        width: count(x.width),
        mime: typeof x.mime === "string" ? x.mime : contentType,
      });
    }
  }
  return { ok: true, links, errors };
}

/** Merges batch results; the first failure wins only when nothing succeeded. */
export function mergeResults(parts: LinksResult[]): LinksResult {
  const links = new Map<string, FileLink>();
  const errors = new Map<string, string>();
  let firstFailure: Extract<LinksResult, { ok: false }> | null = null;
  for (const p of parts) {
    if (!p.ok) {
      firstFailure ??= p;
      continue;
    }
    p.links.forEach((v, k) => links.set(k, v));
    p.errors.forEach((v, k) => errors.set(k, v));
  }
  if (firstFailure && links.size === 0 && errors.size === 0) return firstFailure;
  return { ok: true, links, errors };
}

/** Image types every browser renders in an <img> (HEIC/HEIF are opened, not previewed). */
const THUMB_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export function hasThumbnail(mime: string | null | undefined): boolean {
  return THUMB_TYPES.has((mime ?? "").split(";")[0].trim().toLowerCase());
}

/** Same-origin redirect to a fresh link (app/files/[kind]/[id]/route.ts); never expires on the page. */
export function fileHref(kind: FileKind, id: string, opts: { download?: boolean } = {}): string {
  return `/files/${kind}/${encodeURIComponent(id)}${opts.download ? "?download=1" : ""}`;
}
