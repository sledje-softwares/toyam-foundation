/**
 * Post-login return path. `next` comes from the query string or a form field, so it is attacker-controlled: only a
 * same-origin, path-absolute URL is accepted; anything else falls back to the dashboard (no open redirect).
 */

export const DEFAULT_NEXT = "/dashboard";
export const NEXT_MAX_LENGTH = 2048;

const BASE = "http://x";

// Any ASCII control character, space or DEL. The URL parser silently strips tab / CR / LF, so "/\t/evil.com" would
// become "//evil.com"; spaces have no business in an unencoded path either.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;
// Control characters (not space) after percent-decoding, e.g. "%0d%0a".
const CONTROL = /[\u0000-\u001f\u007f]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Structural checks shared by the raw value, its decoded forms and the normalised result. */
function looksSafe(path: string, controlPattern: RegExp): boolean {
  if (!path.startsWith("/")) return false;
  // Protocol-relative ("//host") and the backslash variant browsers treat the same ("/\host").
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  if (path.includes("\\")) return false;
  if (controlPattern.test(path)) return false;
  if (SCHEME.test(path)) return false;
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname === "/login" || pathname.startsWith("/login/")) return false;
  return true;
}

/** The value decoded up to three times; null if it is not valid percent-encoding. */
function decodedForms(raw: string): string[] | null {
  const forms: string[] = [];
  let current = raw;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/** Returns `raw` as a safe same-origin path (normalised), or "/dashboard". */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_NEXT;
  if (raw.length === 0 || raw.length > NEXT_MAX_LENGTH) return DEFAULT_NEXT;
  if (!looksSafe(raw, CONTROL_OR_SPACE)) return DEFAULT_NEXT;

  // Encoded variants such as "/%2F%2Fevil.com" or "/%5Cevil.com" may be decoded by a proxy or the router later.
  const decoded = decodedForms(raw);
  if (decoded === null) return DEFAULT_NEXT;
  if (!decoded.every((form) => looksSafe(form, CONTROL))) return DEFAULT_NEXT;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return DEFAULT_NEXT;
  }
  if (url.origin !== BASE) return DEFAULT_NEXT;

  // Dot segments are resolved here ("/.//evil.com" -> "//evil.com"), so check the normalised result again.
  const normalised = url.pathname + url.search + url.hash;
  if (!looksSafe(normalised, CONTROL_OR_SPACE)) return DEFAULT_NEXT;
  return normalised;
}

/** Login URL that returns to `path` after sign-in; plain "/login" when there is nothing worth returning to. */
export function loginPathFor(path: string | null | undefined): string {
  const next = safeNext(path);
  if (next === DEFAULT_NEXT || next === "/") return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Request header the middleware sets to the requested path + query, so server layouts and guards can build a login
 * URL with `next`. Always overwritten by the middleware (a client-sent value never survives) and still passed through
 * `safeNext` by readers.
 */
export const REQUEST_PATH_HEADER = "x-toyam-request-path";
