import { requireRole } from "@/lib/auth";
import { emptyInsurerValues } from "@/lib/insurer-form";
import { PageHeader } from "@/components/ui";
import { InsurerForm } from "../insurer-form";

export const metadata = { title: "Add insurer" };

export default async function NewInsurerPage() {
  await requireRole(["admin"]);
  return (
    <>
      <PageHeader title="Add insurer" breadcrumbs={[{ label: "Admin" }, { label: "Insurers", href: "/admin/insurers" }, { label: "Add insurer" }]} />
      <div className="space-y-4">
        <InsurerForm insurerId={null} initial={emptyInsurerValues()} />
        <p className="text-sm text-text-muted">Save the insurer first, then upload its report template.</p>
      </div>
    </>
  );
}
