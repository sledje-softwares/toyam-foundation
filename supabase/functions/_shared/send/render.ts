// Small pure helpers for report emails (8.2). No imports; runs in Deno and in Node.

/** Replaces `{{name}}` with values; unknown or empty names become ''. Line breaks in values are flattened. */
export function renderTemplate(pattern: string, values: Record<string, string | null | undefined>): string {
  return pattern.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, k: string) => String(values[k] ?? '').replace(/[\r\n]+/g, ' ').trim());
}

/** A file or folder name that every portal and mail client accepts: ASCII letters, digits, `.`, `_`, `-`. */
export function safeName(s: string, max = 80): string {
  const base = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  return (base || 'file').slice(0, max).replace(/[_.-]+$/g, '') || 'file';
}

export function extOf(filename: string | null | undefined, mime?: string | null): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename ?? '');
  if (m) return m[1].toLowerCase();
  const byMime: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf',
    'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  };
  return byMime[(mime ?? '').toLowerCase()] ?? 'bin';
}

export function contentTypeFor(format: 'pdf' | 'docx'): string {
  return format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

/** Mail address in `a@b.c` form, lower case; null when it is not one (no display names, no control characters). */
export function normaliseAddress(a: string): string | null {
  const s = a.trim().toLowerCase();
  return /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) && s.length <= 254 ? s : null;
}
