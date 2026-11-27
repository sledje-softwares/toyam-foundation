/** For loading.tsx next to a list page. */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {/* Phones: card placeholders, as DataTable shows cards below md. */}
      <div className="space-y-2 md:hidden">
        {Array.from({ length: Math.min(rows, 4) }, (_, r) => (
          <div key={r} className="space-y-3 rounded border border-border bg-surface p-3">
            <div className="h-4 w-1/2 animate-pulse rounded bg-slate-200" />
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, c) => (
                <div key={c} className="h-3 animate-pulse rounded bg-slate-200" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-hidden rounded border border-border bg-surface md:block">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-b-0">
            {Array.from({ length: columns }, (_, c) => (
              <div key={c} className="h-3 flex-1 animate-pulse rounded bg-slate-200" />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
