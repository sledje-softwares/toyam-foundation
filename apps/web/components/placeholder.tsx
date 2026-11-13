import { requireRole } from "@/lib/auth";
import { findNavItem } from "@/lib/nav";

/** Server-side role guard + placeholder body for a nav page. */
export async function Placeholder({ href }: { href: string }) {
  const item = findNavItem(href);
  if (!item) throw new Error(`Unknown nav item: ${href}`);
  await requireRole(item.roles);
  return (
    <div>
      <h1 className="text-2xl font-semibold">{item.label}</h1>
      <p className="mt-2 text-slate-600">Coming in {item.milestone}.</p>
    </div>
  );
}
