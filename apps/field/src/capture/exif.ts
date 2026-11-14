// EXIF helpers (pure). Gallery files take their capture time from EXIF when present, else the file
// time; camera captures use the device clock at the shutter. All times are device-side and untrusted
// (the server only accepts them inside its own window, D43).

const EXIF_TIME = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
const DAY_MS = 86_400_000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Parses an EXIF "YYYY:MM:DD HH:MM:SS" stamp. EXIF has no zone: use `offset` ("+05:30") when given,
 * else the phone's zone (`tzOffsetMinutes` = `Date.getTimezoneOffset()`, -330 for India).
 */
export function parseExifDate(value: unknown, offset: unknown, tzOffsetMinutes: number): number | null {
  const m = str(value)?.match(EXIF_TIME);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se);
  const om = str(offset)?.match(OFFSET);
  const offsetMin = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : -tzOffsetMinutes;
  return asUtc - offsetMin * 60_000;
}

/** Plausible: after 2000 and not more than a day ahead of the phone clock. */
const plausible = (ms: number | null | undefined, nowMs: number): ms is number =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < nowMs + DAY_MS;

/**
 * Capture time for a picked file: EXIF DateTimeOriginal (then Digitized, then DateTime), else the
 * file's modification time, else now. Returns ISO 8601 (UTC).
 */
export function pickCaptureTime(
  exif: Record<string, unknown> | null | undefined,
  fileTimeMs: number | null | undefined,
  nowMs: number,
  tzOffsetMinutes: number,
): string {
  const e = exif ?? {};
  const candidates: [unknown, unknown][] = [
    [e.DateTimeOriginal, e.OffsetTimeOriginal ?? e.OffsetTime],
    [e.DateTimeDigitized, e.OffsetTimeDigitized ?? e.OffsetTime],
    [e.DateTime, e.OffsetTime],
  ];
  for (const [v, o] of candidates) {
    const ms = parseExifDate(v, o, tzOffsetMinutes);
    if (plausible(ms, nowMs)) return new Date(ms).toISOString();
  }
  if (plausible(fileTimeMs, nowMs)) return new Date(fileTimeMs).toISOString();
  return new Date(nowMs).toISOString();
}

const MAX_STRING = 256;
const MAX_KEYS = 120;

/**
 * Keeps EXIF as metadata (docs/11 "keeps EXIF"; compression re-encodes the pixels, so the tags travel
 * here): primitive values only, long / binary-looking strings (MakerNote, thumbnails) dropped.
 */
export function cleanExif(exif: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> | undefined {
  if (!exif || typeof exif !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(exif)) {
    if (n >= MAX_KEYS) break;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= MAX_STRING) out[k] = v;
    else continue;
    n++;
  }
  return n > 0 ? out : undefined;
}
