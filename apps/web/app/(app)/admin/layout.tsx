import { requireRole } from "@/lib/auth";

// Defence in depth: every /admin/* route needs an admin. RLS is still the real guard.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["admin"]);
  return children;
}
