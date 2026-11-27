export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading report" className="animate-pulse space-y-4">
      <div className="h-8 w-64 rounded bg-slate-200" />
      <div className="h-4 w-96 rounded bg-slate-100" />
      <div className="h-20 rounded bg-slate-100" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="h-96 rounded bg-slate-100" />
        <div className="h-96 rounded bg-slate-100" />
      </div>
    </div>
  );
}
