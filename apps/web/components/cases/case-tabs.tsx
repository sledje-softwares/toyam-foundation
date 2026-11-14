"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type CaseTab = { href: string; label: string; count?: number };

/** Tabs of the case layout (links, so each tab has its own URL). The first tab is the case root. */
export function CaseTabs({ tabs }: { tabs: CaseTab[] }) {
  const pathname = usePathname();
  const root = tabs[0]?.href;
  return (
    <nav aria-label="Case sections" className="mb-6 border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-1">
        {tabs.map((t) => {
          const active = t.href === root ? pathname === root : pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm ${
                  active ? "border-primary font-medium text-primary" : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                {t.label}
                {t.count !== undefined && (
                  <span className="rounded-full bg-slate-100 px-2 text-xs text-text-muted">{t.count > 999 ? "999+" : t.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
