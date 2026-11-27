"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type CaseTab = { href: string; label: string; count?: number };

/** Tabs of the case layout (links, so each tab has its own URL). The first tab is the case root. */
export function CaseTabs({ tabs }: { tabs: CaseTab[] }) {
  const pathname = usePathname();
  const root = tabs[0]?.href;
  return (
    <nav aria-label="Case sections" className="-mx-4 mb-6 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0">
      <ul className="-mb-px flex gap-1">
        {tabs.map((t) => {
          const active = t.href === root ? pathname === root : pathname === t.href || pathname.startsWith(t.href + "/");
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm ${
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
