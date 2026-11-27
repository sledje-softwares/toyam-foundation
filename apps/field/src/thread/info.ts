// What the field app shows about a file it can see (D54): active labels (category + description) and the
// file's comments. Pure mapping of the two extra reads in cache/fetch.ts; tested in info.test.ts.
//
// Rule 4: only category code / name, source and description are read. Confidence, model, pipeline version and
// OCR are never selected, so they cannot reach the screen.
import type { FileLabel, ServerComment, ServerFile } from './model';

/** One `evidence` row with its embedded labels (`labels:evidence_labels(...)`, category embedded as one row). */
export interface LabelRow {
  id: string;
  labels?: {
    is_active?: boolean | null;
    source?: string | null;
    description?: string | null;
    category?: { code?: string | null; name?: string | null } | { code?: string | null; name?: string | null }[] | null;
  }[] | null;
}

/** One `evidence_comments` row. */
export interface CommentRow {
  id: string;
  evidence_id: string;
  body: string | null;
  author_id: string | null;
  created_at: string;
  client_comment_id: string | null;
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/** Active labels per evidence id (inactive rows and rows without a category name are dropped). */
export function labelsByEvidence(rows: readonly LabelRow[]): Map<string, FileLabel[]> {
  const out = new Map<string, FileLabel[]>();
  for (const r of rows) {
    const list: FileLabel[] = [];
    for (const l of r.labels ?? []) {
      if (l.is_active === false) continue;
      const cat = one(l.category);
      const name = cat?.name?.trim();
      if (!name) continue;
      const d = l.description?.trim();
      list.push({ code: cat?.code ?? null, name, source: String(l.source ?? ''), description: d ? d : null });
    }
    out.set(String(r.id), list);
  }
  return out;
}

/** Comments per evidence id, oldest first (blank bodies dropped). */
export function commentsByEvidence(rows: readonly CommentRow[]): Map<string, ServerComment[]> {
  const out = new Map<string, ServerComment[]>();
  for (const r of rows) {
    const body = (r.body ?? '').trim();
    if (!body) continue;
    const c: ServerComment = {
      id: String(r.id), body, author_id: r.author_id ?? null, created_at: String(r.created_at), client_comment_id: r.client_comment_id ?? null,
    };
    const k = String(r.evidence_id);
    const l = out.get(k);
    if (l) l.push(c);
    else out.set(k, [c]);
  }
  for (const l of out.values()) l.sort((a, b) => cmpTime(a.created_at, b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Adds labels and comments to the files. A read that failed (null) keeps what the previous fetch had
 * (`previous`, e.g. the cached files), so a short outage does not blank the info panel.
 */
export function attachInfo(
  files: readonly ServerFile[], labels: readonly LabelRow[] | null, comments: readonly CommentRow[] | null,
  previous: readonly ServerFile[] = [],
): ServerFile[] {
  const lab = labels ? labelsByEvidence(labels) : null;
  const com = comments ? commentsByEvidence(comments) : null;
  const prev = new Map(previous.map((f) => [f.id, f] as const));
  return files.map((f) => ({
    ...f,
    labels: lab ? lab.get(f.id) ?? [] : prev.get(f.id)?.labels ?? [],
    comments: com ? com.get(f.id) ?? [] : prev.get(f.id)?.comments ?? [],
  }));
}

/** Every client_comment_id the server returned (the comment queue drops its sent copies of these). */
export function serverCommentIds(files: readonly Pick<ServerFile, 'comments'>[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) for (const c of f.comments ?? []) if (c.client_comment_id) ids.add(c.client_comment_id);
  return ids;
}

function cmpTime(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
  return x - y;
}
