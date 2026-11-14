import Link from "next/link";

export function PageHeader({
  title,
  breadcrumbs,
  badges,
  actions,
}: {
  title: string;
  breadcrumbs?: { label: string; href?: string }[];
  badges?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1 text-sm text-text-muted">
          <ol className="flex flex-wrap items-center gap-1">
            {breadcrumbs.map((b, i) => (
              <li key={`${i}-${b.label}`} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true">/</span>}
                {b.href ? (
                  <Link href={b.href} className="underline hover:no-underline">
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current="page">{b.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {badges}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
