"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@/lib/nav";

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const link = (i: NavItem) => {
    const active = pathname === i.href || pathname.startsWith(i.href + "/");
    return (
      <li key={i.href}>
        <Link
          href={i.href}
          aria-current={active ? "page" : undefined}
          className={`block rounded px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${
            active ? "bg-blue-50 font-medium text-blue-900" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          {i.label}
        </Link>
      </li>
    );
  };
  const main = items.filter((i) => !i.group);
  const admin = items.filter((i) => i.group === "Admin");
  return (
    <nav aria-label="Main">
      <ul className="space-y-1">{main.filter((i) => i.href !== "/audit-log").map(link)}</ul>
      {admin.length > 0 && (
        <>
          <p className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Admin</p>
          <ul className="mt-1 space-y-1">{admin.map(link)}</ul>
        </>
      )}
      <ul className="mt-1 space-y-1">{main.filter((i) => i.href === "/audit-log").map(link)}</ul>
    </nav>
  );
}
