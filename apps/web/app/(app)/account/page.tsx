import { requireRole } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";

// Stub so the sidebar link resolves; the password form is piece T10.
export default async function Page() {
  await requireRole(["admin", "orchestrator", "office"]);
  return (
    <div>
      <PageHeader title="My account" />
      <p className="text-text-muted">Password change is coming soon.</p>
    </div>
  );
}
