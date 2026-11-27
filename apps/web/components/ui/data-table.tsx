import Link from "next/link";
import { buildHref, nextSort, type ListParams, type SearchParams } from "@/lib/list-params";

export type Column<Row> = {
  key: string;
  header: string;
  /** Renders the cell. Default: String(row[key]). */
  cell?: (row: Row) => React.ReactNode;
  /** Sort by this column (key must be in the page's ListConfig.sortable). */
  sortable?: boolean;
  align?: "left" | "right";
  /** Tailwind width class, e.g. "w-32". */
  width?: string;
  /**
   * Phone card view (below md). Default: a labelled value in a two-column grid.
   * "badge": next to the card title, unlabelled (statuses, due chips). "wide": a full-width row (subjects, actions).
   * "hide": left out of the card.
   */
  mobile?: "badge" | "wide" | "hide";
};

/**
 * Server-rendered table. Below md each row becomes a card (first column as the title, the rest as label: value),
 * with the sortable columns offered as links above the cards. Sorting is by links (so it survives reload and the back button).
 * The first column's cell is rendered as a link to rowHref(row) when rowHref is given.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowHref,
  basePath,
  searchParams,
  list,
  caption,
  empty,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  rowHref?: (row: Row) => string;
  basePath: string;
  searchParams: SearchParams;
  /** Result of parseListParams (current sort). */
  list: Pick<ListParams, "sort" | "dir">;
  /** Accessible name of the table (visually hidden). */
  caption: string;
  /** Shown instead of the table when rows is empty. */
  empty?: React.ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const cell = (row: Row, c: Column<Row>) => (c.cell ? c.cell(row) : String((row as Record<string, unknown>)[c.key] ?? "—"));
  const [first, ...rest] = columns;
  const sortable = columns.filter((c) => c.sortable);
  return (
    <>
      {/* Phones: cards. */}
      <div className="md:hidden">
        {sortable.length > 0 && (
          <nav aria-label={`Sort ${caption}`} className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
            <span className="text-text-muted">Sort:</span>
            {sortable.map((c) => {
              const active = list.sort === c.key;
              const n = nextSort(list, c.key);
              return (
                <Link
                  key={c.key}
                  href={buildHref(basePath, searchParams, { sort: n.sort, dir: n.dir })}
                  aria-current={active ? "true" : undefined}
                  className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-3 ${
                    active ? "border-primary bg-primary-soft font-medium text-primary" : "border-border bg-surface text-text"
                  }`}
                >
                  {c.header}
                  {active && (
                    <span aria-label={list.dir === "asc" ? "ascending" : "descending"}>{list.dir === "asc" ? "▲" : "▼"}</span>
                  )}
                </Link>
              );
            })}
          </nav>
        )}
        <ul aria-label={caption} className="space-y-2">
          {rows.map((row) => (
            <li key={rowKey(row)} className="rounded border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {first && (
                  <p className="mr-auto min-w-0 break-words text-sm font-semibold">
                    {rowHref ? (
                      <Link href={rowHref(row)} className="text-primary underline hover:no-underline">
                        {cell(row, first)}
                      </Link>
                    ) : (
                      cell(row, first)
                    )}
                  </p>
                )}
                {rest
                  .filter((c) => c.mobile === "badge")
                  .map((c) => (
                    <span key={c.key} className="text-sm">
                      {cell(row, c)}
                    </span>
                  ))}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {rest
                  .filter((c) => c.mobile !== "hide" && c.mobile !== "badge")
                  .map((c) => (
                    <div key={c.key} className={`min-w-0 ${c.mobile === "wide" ? "col-span-2" : ""}`}>
                      {c.header && <dt className="text-xs text-text-muted">{c.header}</dt>}
                      <dd className="break-words">{cell(row, c)}</dd>
                    </div>
                  ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>
      {/* Tablets and up: the table. */}
      <div className="hidden overflow-x-auto rounded border border-border bg-surface md:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-text-muted">
            <tr>
              {columns.map((c) => {
                const active = c.sortable && list.sort === c.key;
                const ariaSort = c.sortable ? (active ? (list.dir === "asc" ? "ascending" : "descending") : "none") : undefined;
                const n = nextSort(list, c.key);
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.width ?? ""}`}
                  >
                    {c.sortable ? (
                      <Link
                        href={buildHref(basePath, searchParams, { sort: n.sort, dir: n.dir })}
                        className="inline-flex min-h-8 items-center gap-1 uppercase hover:underline"
                      >
                        {c.header}
                        <span aria-hidden="true">{active ? (list.dir === "asc" ? "▲" : "▼") : ""}</span>
                      </Link>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-border hover:bg-primary-soft">
                {columns.map((c, i) => {
                  const content = cell(row, c);
                  return (
                    <td key={c.key} className={`h-10 px-3 py-2 align-middle ${c.align === "right" ? "text-right" : ""}`}>
                      {i === 0 && rowHref ? (
                        <Link href={rowHref(row)} className="font-medium text-primary underline hover:no-underline">
                          {content}
                        </Link>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
