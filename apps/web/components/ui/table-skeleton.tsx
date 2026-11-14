/** For loading.tsx next to a list page. */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-label="Loading" className="overflow-hidden rounded border border-border bg-surface">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className="h-3 flex-1 animate-pulse rounded bg-slate-200" />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
