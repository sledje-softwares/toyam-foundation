// Value formatting for report placeholders: dates, Indian digit grouping, yes/no, list splitting.
// Pure; no imports beyond types.
import type { SplitMode } from './spec.ts';

export interface DateParts {
  y: number; m: number; d: number;
  hh: number | null; mi: number | null; ss: number | null;
}

const IST_OFFSET_MIN = 330; // India has one zone and no daylight saving

function valid(p: DateParts): DateParts | null {
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.y < 1000 || p.y > 9999) return null;
  if (p.hh !== null && (p.hh > 23 || (p.mi ?? 0) > 59 || (p.ss ?? 0) > 59)) return null;
  return p;
}

/**
 * Reads `yyyy-mm-dd`, `yyyy-mm-ddThh:mm[:ss]` (as stored by the workspace), timestamps with a zone
 * (`…Z`, `…+00:00`, Postgres `2026-11-15 10:05:00+00`; shown in India time) and `dd/mm/yyyy`, `dd.mm.yyyy`,
 * `dd-mm-yyyy`. Anything else → null (the value is then shown as typed).
 */
export function parseDateish(raw: string): DateParts | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(s);
  if (m) {
    const p: DateParts = {
      y: +m[1], m: +m[2], d: +m[3],
      hh: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null, ss: m[6] !== undefined ? +m[6] : null,
    };
    if (m[7] && p.hh !== null) {
      const z = m[7].toUpperCase();
      let off = 0;
      if (z !== 'Z') {
        const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(z)!;
        off = (zm[1] === '-' ? -1 : 1) * (+zm[2] * 60 + +(zm[3] ?? 0));
      }
      const utc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi ?? 0, p.ss ?? 0) - off * 60_000;
      const ist = new Date(utc + IST_OFFSET_MIN * 60_000);
      return valid({
        y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate(),
        hh: ist.getUTCHours(), mi: ist.getUTCMinutes(), ss: ist.getUTCSeconds(),
      });
    }
    return valid(p);
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (m) return valid({ y: +m[3], m: +m[2], d: +m[1], hh: null, mi: null, ss: null });
  return null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Pattern tokens: yyyy yy MMMM MMM MM M dd d HH H hh h mm ss a; text in single quotes is literal ('' = a quote).
 * Time tokens on a value without a time print 00 / 12 AM (bind uses the date pattern for such values by default).
 */
export function formatDate(p: DateParts, pattern: string): string {
  let out = '';
  let i = 0;
  const hh = p.hh ?? 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "'") {
          if (pattern[j + 1] === "'") { out += "'"; j += 2; continue; }
          break;
        }
        out += pattern[j++];
      }
      i = j + 1;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    const tok = ch.repeat(n);
    switch (tok) {
      case 'yyyy': out += pad(p.y, 4); break;
      case 'yy': out += pad(p.y % 100); break;
      case 'MMMM': out += MONTHS[p.m - 1]; break;
      case 'MMM': out += MONTHS[p.m - 1].slice(0, 3); break;
      case 'MM': out += pad(p.m); break;
      case 'M': out += String(p.m); break;
      case 'dd': out += pad(p.d); break;
      case 'd': out += String(p.d); break;
      case 'HH': out += pad(hh); break;
      case 'H': out += String(hh); break;
      case 'hh': out += pad(hh % 12 === 0 ? 12 : hh % 12); break;
      case 'h': out += String(hh % 12 === 0 ? 12 : hh % 12); break;
      case 'mm': out += pad(p.mi ?? 0); break;
      case 'ss': out += pad(p.ss ?? 0); break;
      case 'a': out += hh < 12 ? 'AM' : 'PM'; break;
      default: out += tok;
    }
    i += n;
  }
  return out;
}

/** Indian digit grouping (12,34,567.50); non-numeric text is returned unchanged. */
export function groupIndian(raw: string): string {
  const s = raw.trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return raw.trim();
  const int = m[2].replace(/^0+(?=\d)/, '');
  let grouped = int;
  if (int.length > 3) {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${m[1]}${grouped}${m[3] ?? ''}`;
}

/** multi_choice values are stored as a JSON array of strings (O1); anything else is one item. */
export function parseMulti(raw: string): string[] | null {
  const s = raw.trim();
  if (!s.startsWith('[')) return null;
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '' : String(x))).filter((x) => x.trim() !== '');
  } catch { /* not JSON */ }
  return null;
}

const MARKER_RE = /^\s*(?:\d{1,3}[.)]|[•●▪◦*-])\s+/;

/** Splits a value into list items (see SplitMode). Markers and surrounding blank lines are stripped. */
export function splitItems(raw: string, mode: SplitMode = 'auto'): string[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const multi = parseMulti(text);
  if (multi) return multi;
  const clean = (xs: string[]) => xs.map((x) => x.replace(/^\s*\n|\s+$/g, '')).filter((x) => x.trim() !== '');
  if (mode === 'lines') return clean(text.split('\n').map((l) => l.replace(MARKER_RE, '').trim()));
  if (mode === 'paragraphs') return clean(text.split(/\n[ \t]*\n/).map((p) => p.trim().replace(MARKER_RE, '')));
  if (mode === 'sections') return clean(text.split(/^[ \t]*-{3,}[ \t]*$/m).map((p) => p.trim()));
  const lines = text.split('\n');
  if (!lines.some((l) => MARKER_RE.test(l))) return clean(lines.map((l) => l.trim()));
  const items: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (MARKER_RE.test(l)) {
      if (cur) items.push(cur.join('\n'));
      cur = [l.replace(MARKER_RE, '').trim()];
    } else if (cur) cur.push(l.trim());
    else if (l.trim() !== '') cur = [l.trim()]; // text before the first marker is its own item
  }
  if (cur) items.push(cur.join('\n'));
  return clean(items);
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

/** `yesno` formatter: maps yes/true/y/1 and no/false/n/0; other text unchanged. */
export function yesNo(raw: string, arg?: string): string {
  const [yes, no] = (arg ?? 'Yes|No').split('|');
  const v = raw.trim().toLowerCase();
  if (['yes', 'true', 'y', '1'].includes(v)) return yes ?? 'Yes';
  if (['no', 'false', 'n', '0'].includes(v)) return no ?? 'No';
  return raw;
}
