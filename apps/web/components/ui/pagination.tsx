import Link from "next/link";
import { buildHref, pageCount, rangeLabel, type SearchParams } from "@/lib/list-params";
import { buttonClass } from "./button";

/** Server component: "1–50 of 312" with Previous/Next links that keep every other URL param. */
export function Pagination({
  page,
  pageSize,
  total,
  basePath,
  searchParams,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  searchParams: SearchParams;
}) {
  const last = pageCount(total, pageSize);
  const disabled = `${buttonClass("secondary")} pointer-events-none opacity-60`;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <p className="text-text-muted">{rangeLabel(page, pageSize, total)}</p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link rel="prev" href={buildHref(basePath, searchParams, { page: page - 1 })} className={buttonClass("secondary")}>
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>Previous</span>
        )}
        {page < last ? (
          <Link rel="next" href={buildHref(basePath, searchParams, { page: page + 1 })} className={buttonClass("secondary")}>
            Next
          </Link>
        ) : (
          <span aria-disabled="true" className={disabled}>Next</span>
        )}
      </div>
    </nav>
  );
}
