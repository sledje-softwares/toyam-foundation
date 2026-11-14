/**
 * Marks a place in the UI kept for a build piece that does not exist yet (docs/04-build-plan.md piece ids).
 * Always visibly labelled "Planned", never clickable, so nobody mistakes it for a broken feature.
 */
export function PlannedButton({ piece, children, title }: { piece: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      role="img"
      aria-label={`${typeof children === "string" ? children : "Feature"}: planned (${piece})`}
      title={title ?? `Planned (${piece}), not built yet`}
      className="inline-flex h-9 cursor-not-allowed items-center gap-2 rounded border border-dashed border-border-input px-3 text-sm text-text-muted"
    >
      {children}
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium">Planned · {piece}</span>
    </span>
  );
}

export function PlannedNote({ piece, title, children }: { piece: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-border-input bg-slate-50 px-3 py-2 text-sm text-text-muted">
      <p className="flex flex-wrap items-center gap-2 font-medium text-text">
        {title}
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-text-muted">Planned · {piece}</span>
      </p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}
