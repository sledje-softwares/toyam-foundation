"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildHref } from "@/lib/list-params";
import { Select, TextInput, type SelectOption } from "./controls";

export type FilterDef = {
  /** URL param name; must be in the page's ListConfig.filters. */
  name: string;
  label: string;
  options: SelectOption[];
  /** Label of the "no filter" option (default "All"). */
  allLabel?: string;
};

/**
 * Search box (debounced 300 ms) + selects that read and write URL params, with "Clear filters" and a result count.
 * Any change resets `page`. `total` comes from the server query.
 */
export function FilterBar({
  filters = [],
  searchLabel,
  total,
  noSearch = false,
}: {
  filters?: FilterDef[];
  searchLabel?: string;
  total?: number;
  noSearch?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = Object.fromEntries(params.entries());
  const urlQ = params.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the box in sync when the URL changes (back button, Clear filters).
  const [seenUrlQ, setSeenUrlQ] = useState(urlQ);
  if (seenUrlQ !== urlQ) {
    setSeenUrlQ(urlQ);
    setQ(urlQ);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const go = (patch: Record<string, string | null>) =>
    startTransition(() => router.push(buildHref(pathname, current, patch)));

  const onSearch = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ q: v.trim() || null }), 300);
  };

  const active = Boolean(urlQ) || filters.some((f) => params.get(f.name));
  const clear = () => {
    const patch: Record<string, string | null> = { q: null };
    for (const f of filters) patch[f.name] = null;
    go(patch);
  };

  return (
    <div role="search" className="mb-4 flex flex-wrap items-end gap-3">
      {!noSearch && (
        <div className="w-64">
          <label htmlFor="filter-q" className="mb-1 block text-xs font-medium text-text-muted">
            {searchLabel ?? "Search"}
          </label>
          <TextInput id="filter-q" type="search" value={q} onChange={(e) => onSearch(e.target.value)} autoComplete="off" />
        </div>
      )}
      {filters.map((f) => (
        <div key={f.name} className="w-44">
          <label htmlFor={`filter-${f.name}`} className="mb-1 block text-xs font-medium text-text-muted">
            {f.label}
          </label>
          <Select
            id={`filter-${f.name}`}
            value={params.get(f.name) ?? ""}
            onChange={(e) => go({ [f.name]: e.target.value || null })}
            options={f.options}
            placeholder={f.allLabel ?? "All"}
          />
        </div>
      ))}
      {active && (
        <button type="button" onClick={clear} className="min-h-9 px-2 text-sm text-primary underline hover:no-underline">
          Clear filters
        </button>
      )}
      {total !== undefined && (
        <p aria-live="polite" className="ml-auto pb-2 text-sm text-text-muted">
          {pending ? "Updating…" : `${total} ${total === 1 ? "result" : "results"}`}
        </p>
      )}
    </div>
  );
}
