import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ROLE_LABELS } from "@/lib/format";
import { PageHeader } from "@/components/ui";
import { PasswordForm } from "./password-form";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  const me = await requireRole(STAFF_ROLES);
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const subtitle = [me.full_name, ROLE_LABELS[me.role], data.user?.email].filter(Boolean).join(" · ");

  return (
    <div>
      <PageHeader title="My account" />
      <p className="-mt-4 mb-6 text-sm text-text-muted">{subtitle}</p>
      <section aria-labelledby="pw-h" className="rounded border border-border bg-surface p-4">
        <h2 id="pw-h" className="mb-4 text-lg font-medium">
          Change password
        </h2>
        <PasswordForm />
      </section>
    </div>
  );
}
