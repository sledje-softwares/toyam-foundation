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
};

/**
 * Server-rendered table. Sorting is by links (so it survives reload and the back button).
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
  return (
    <div className="overflow-x-auto rounded border border-border bg-surface">
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
                const content = c.cell ? c.cell(row) : String((row as Record<string, unknown>)[c.key] ?? "—");
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
  );
}
