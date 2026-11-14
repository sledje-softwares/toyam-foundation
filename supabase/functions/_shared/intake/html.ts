// Tolerant HTML helpers for email bodies (Outlook / Gmail / insurer systems).
// No DOM: emails are small and table markup is regular enough for this.

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', hellip: '…', rupee: '₹', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title|xml)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<o:p>\s*<\/o:p>/gi, '');
}

/** Collapse whitespace inside one table cell / inline fragment. */
export function cellText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ ​‌‍﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Readable plain text, keeping line structure (rows -> lines, cells -> tabs). */
export function htmlToText(html: string): string {
  const s = stripNoise(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ ​﻿]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \f\v]+/g, ' ').replace(/\t[ ]+/g, '\t').replace(/[ ]+\t/g, '\t').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Innermost table rows as arrays of cell texts. Empty cells are kept so that
 * "label | value | label | value" positions stay aligned. Rows of layout tables that
 * contain nested tables are skipped (their inner rows are returned instead).
 */
export function htmlRows(html: string): string[][] {
  const s = stripNoise(html);
  const rows: string[][] = [];
  const trRe = /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(s)) !== null) {
    const parts = m[1].split(/<t[dh]\b[^>]*>/i).slice(1);
    if (parts.length === 0) continue;
    const cells = parts.map((p) => cellText(p.replace(/<\/t[dh]\s*>[\s\S]*$/i, '')));
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}

/** Fallback for text/plain bodies: cells separated by tabs or 2+ spaces. */
export function textRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/\t+| {2,}/).map((c) => c.trim()).filter((c) => c !== ''))
    .filter((r) => r.length > 0);
}
