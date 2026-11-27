"use client";

import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { visibleComments, type FileComment } from "@/lib/evidence-comments";

/** Operator comments on a file (D54), oldest first. `compact`: line-clamped bodies (tap to expand) for the report panel. */
export function OperatorComments({ comments, compact = false }: { comments: FileComment[]; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (comments.length === 0) return null;
  const { shown, hidden } = visibleComments(comments, expanded);
  return (
    <div className="mt-1 space-y-1 rounded border-l-2 border-primary bg-slate-50 px-2 py-1 text-xs" aria-label="Operator comments">
      <p className="font-semibold text-text-muted">Operator comments ({comments.length})</p>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="min-h-6 text-primary underline hover:no-underline">
          Show all {comments.length}
        </button>
      )}
      <ul className="space-y-1">
        {shown.map((c) => (
          <li key={c.id}>
            <span className="text-text-muted">
              {c.author} · {formatDateTime(c.createdAt)}
            </span>
            <span className={`block whitespace-pre-wrap break-words ${compact && !expanded ? "line-clamp-2" : ""}`}>{c.body}</span>
          </li>
        ))}
      </ul>
      {expanded && comments.length > 3 && (
        <button type="button" onClick={() => setExpanded(false)} className="min-h-6 text-primary underline hover:no-underline">
          Show fewer
        </button>
      )}
    </div>
  );
}
