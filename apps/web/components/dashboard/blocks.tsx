import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, type Tone } from "@/components/ui";

/** Big number that links to the matching list. `count` null means the read failed. */
export function StatTile({
  label,
  count,
  href,
  tone = "neutral",
  hint,
}: {
  label: string;
  count: number | null;
  href: string;
  tone?: Tone;
  hint?: string;
}) {
  const alert = tone === "danger" && count !== null && count > 0;
  return (
    <Link
      href={href}
      className={`block rounded border bg-surface p-4 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary ${
        alert ? "border-red-300" : "border-slate-200"
      }`}
    >
      <p className="text-sm text-text-muted">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${alert ? "text-danger" : ""}`}>{count ?? "—"}</p>
      {count === null ? (
        <p className="mt-1 text-xs text-danger">Could not be loaded</p>
      ) : (
        hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>
      )}
    </Link>
  );
}

export function Section({
  title,
  note,
  children,
  className = "",
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded border border-slate-200 bg-surface p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {note && <p className="text-xs text-text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export function SectionError({ what }: { what: string }) {
  return (
    <p role="alert" className="text-sm text-danger">
      {what} could not be loaded.
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>;
}

/** Name + count rows, each linking to a filtered list. */
export function WorkloadList({
  rows,
  hrefFor,
  unit,
}: {
  rows: { id: string | null; name: string; count: number }[];
  hrefFor: (id: string | null) => string;
  unit: string;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-text-muted">
          <th scope="col" className="py-1 pr-2 font-medium">
            Name
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {unit}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id ?? "none"} className="border-t border-slate-100">
            <td className="py-1.5 pr-2">{r.name}</td>
            <td className="py-1.5 text-right">
              {r.count > 0 ? (
                <Link href={hrefFor(r.id)} className="text-primary underline hover:no-underline">
                  {r.count}
                </Link>
              ) : (
                <span className="text-text-muted">0</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CountBadge({ n, tone }: { n: number; tone: Tone }) {
  return n > 0 ? <Badge tone={tone}>{n}</Badge> : <span className="text-text-muted">0</span>;
}
