// Operator comments on a file (D54): shown beside the image for staff. Pure mapping; rows come from an RLS read of
// evidence_comments embedded as `comments:evidence_comments(id, body, created_at, author:profiles(full_name))`.

export type CommentRow = {
  id: string;
  body: string;
  created_at: string;
  author: { full_name: string } | { full_name: string }[] | null;
};

export type FileComment = { id: string; body: string; createdAt: string; author: string };

export const COMMENTS_COLLAPSED = 3;

/** Oldest first (newest last); blank bodies dropped; author falls back to "Operator". */
export function toFileComments(rows: CommentRow[] | null | undefined): FileComment[] {
  return (rows ?? [])
    .filter((r) => r.body.trim() !== "")
    .map((r) => {
      const a = Array.isArray(r.author) ? r.author[0] : r.author;
      return { id: r.id, body: r.body.trim(), createdAt: r.created_at, author: a?.full_name?.trim() || "Operator" };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/** The comments shown before "Show all": the newest `limit`, still oldest-first. */
export function visibleComments(all: FileComment[], expanded: boolean, limit = COMMENTS_COLLAPSED): { shown: FileComment[]; hidden: number } {
  if (expanded || all.length <= limit) return { shown: all, hidden: 0 };
  return { shown: all.slice(all.length - limit), hidden: all.length - limit };
}
