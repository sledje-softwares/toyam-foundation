/**
 * URL search params <-> list state <-> Supabase query. Pure (no React, no Next), so it is unit-tested.
 * Pages call parseListParams(await searchParams, config), then applyListParams(query, params, config).
 */

export type SearchParams = Record<string, string | string[] | undefined>;
export type SortDir = "asc" | "desc";

export type ListConfig = {
  /** Rows per page (default 50). */
  pageSize?: number;
  /** Column keys a user may sort by (anything else in the URL is ignored). */
  sortable: string[];
  defaultSort: { key: string; dir: SortDir };
  /** URL param names that are exact-match filters (e.g. "status", "role"). Value "" or "all" means no filter. */
  filters?: string[];
  /** Columns searched (case-insensitive contains) by the `q` param. */
  searchColumns?: string[];
  /** Map URL filter name -> column, when they differ. */
  filterColumns?: Record<string, string>;
  /** Upper bound for `page`, to stop absurd ranges. */
  maxPage?: number;
};

export type ListParams = {
  page: number; // 1-based
  pageSize: number;
  from: number; // inclusive row index for .range()
  to: number; // inclusive
  sort: string;
  dir: SortDir;
  q: string;
  filters: Record<string, string>;
};

export const DEFAULT_PAGE_SIZE = 50;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function parseListParams(sp: SearchParams, cfg: ListConfig): ListParams {
  const pageSize = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const rawPage = Number.parseInt(first(sp.page), 10);
  const page = Math.min(cfg.maxPage ?? 10_000, Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1);

  const wanted = first(sp.sort);
  const sort = cfg.sortable.includes(wanted) ? wanted : cfg.defaultSort.key;
  const dirRaw = first(sp.dir);
  const dir: SortDir = sort === wanted && (dirRaw === "asc" || dirRaw === "desc") ? dirRaw : cfg.defaultSort.dir;

  const filters: Record<string, string> = {};
  for (const name of cfg.filters ?? []) {
    const v = first(sp[name]).trim();
    if (v && v !== "all") filters[name] = v;
  }

  return {
    page,
    pageSize,
    from: (page - 1) * pageSize,
    to: page * pageSize - 1,
    sort,
    dir,
    q: first(sp.q).trim().slice(0, 100),
    filters,
  };
}

/** Escapes a user string for use inside a PostgREST `or=(col.ilike.*x*)` filter. */
export function escapeSearchTerm(q: string): string {
  // Strip characters that have meaning in the or() grammar or in LIKE patterns.
  return q.replace(/[,()*%_\\"]/g, " ").replace(/\s+/g, " ").trim();
}

/** The subset of the PostgREST builder used here (every method returns the builder). */
type Chainable = {
  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): unknown;
  range(from: number, to: number): unknown;
  eq(column: string, value: string): unknown;
  or(filters: string): unknown;
};

/** Applies filters, search, sort and page range. Returns the same builder type. */
export function applyListParams<Q extends Chainable>(query: Q, p: ListParams, cfg: ListConfig): Q {
  let qb = query;
  for (const [name, value] of Object.entries(p.filters)) {
    qb = qb.eq(cfg.filterColumns?.[name] ?? name, value) as Q;
  }
  const term = escapeSearchTerm(p.q);
  if (term && cfg.searchColumns?.length) {
    qb = qb.or(cfg.searchColumns.map((c) => `${c}.ilike.*${term}*`).join(",")) as Q;
  }
  qb = qb.order(p.sort, { ascending: p.dir === "asc" }) as Q;
  // A stable tiebreaker keeps pages from overlapping when the sort column has duplicates.
  if (p.sort !== "id") qb = qb.order("id", { ascending: true }) as Q;
  return qb.range(p.from, p.to) as Q;
}

/**
 * Builds a link to the same page with some params changed. A null/"" value removes the param.
 * Changing anything except `page` resets to page 1.
 */
export function buildHref(basePath: string, sp: SearchParams, patch: Record<string, string | number | null | undefined>): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = first(v);
    if (val) next.set(k, val);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") next.delete(k);
    else next.set(k, String(v));
  }
  if (!("page" in patch)) next.delete("page");
  if (next.get("page") === "1") next.delete("page");
  const s = next.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** Next sort state when a header is clicked: new column -> asc; same column -> toggle. */
export function nextSort(current: { sort: string; dir: SortDir }, key: string): { sort: string; dir: SortDir } {
  if (current.sort !== key) return { sort: key, dir: "asc" };
  return { sort: key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** "1–50 of 312" (or "0 results"). */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total <= 0) return "0 results";
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return `${from}–${to} of ${total}`;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
