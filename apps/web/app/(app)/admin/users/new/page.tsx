import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { NewUserForm } from "./new-user-form";

export const metadata = { title: "Add user" };

export default async function NewUserPage() {
  await requireRole(["admin"]);
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("region").not("region", "is", null).limit(1000);
  const regions = [...new Set((data ?? []).map((r) => r.region).filter((x): x is string => Boolean(x)))].sort();
  return (
    <>
      <PageHeader title="Add user" breadcrumbs={[{ label: "Admin" }, { label: "Users", href: "/admin/users" }, { label: "Add user" }]} />
      <NewUserForm regions={regions} />
    </>
  );
}
