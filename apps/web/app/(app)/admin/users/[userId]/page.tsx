import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { FIELD_SIGN_IN } from "@/lib/auth-config";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime, ROLE_LABELS } from "@/lib/format";
import { Badge, ErrorState, PageHeader } from "@/components/ui";
import { AccessSection, LoginForm, PasswordSection, ProfileForm } from "./detail-forms";

export const metadata = { title: "User" };

export default async function UserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const me = await requireRole(["admin"]);
  const { userId } = await params;
  if (!z.guid().safeParse(userId).success) notFound();

  const supabase = await createClient();
  const [users, tasks, regionRows] = await Promise.all([
    supabase.rpc("admin_list_users", { p_user_id: userId }),
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("assignee_id", userId).in("status", ["pending", "in_progress"]),
    supabase.from("profiles").select("region").not("region", "is", null).limit(1000),
  ]);
  if (users.error) {
    return (
      <>
        <PageHeader title="User" breadcrumbs={[{ label: "Admin" }, { label: "Users", href: "/admin/users" }]} />
        <ErrorState what="This user" />
      </>
    );
  }
  const u = users.data?.[0];
  if (!u) notFound();

  const openTasks = tasks.count ?? 0;
  const regions = [...new Set((regionRows.data ?? []).map((r) => r.region).filter((x): x is string => Boolean(x)))].sort();
  const person = {
    id: u.id,
    full_name: u.full_name,
    role: u.role,
    region: u.region ?? "",
    email: u.email ?? "",
    phone: u.phone ?? u.profile_phone ?? "",
    is_active: u.is_active,
  };
  const isSelf = u.id === me.id;
  const showPassword = u.is_active && !(u.role === "field" && FIELD_SIGN_IN === "mobile_otp");

  return (
    <>
      <PageHeader
        title={u.full_name}
        breadcrumbs={[{ label: "Admin" }, { label: "Users", href: "/admin/users" }, { label: u.full_name }]}
        badges={
          <>
            <Badge tone="info">{ROLE_LABELS[u.role]}</Badge>
            <Badge tone={u.is_active ? "success" : "neutral"}>{u.is_active ? "Active" : "Inactive"}</Badge>
          </>
        }
        actions={
          <p className="text-right text-xs text-text-muted">
            Added {formatDate(u.created_at)}
            <br />
            Last sign-in {formatDateTime(u.last_sign_in_at)}
          </p>
        }
      />
      <div className="space-y-4">
        <ProfileForm user={person} isSelf={isSelf} regions={regions} openTasks={openTasks} />
        <LoginForm user={person} />
        {showPassword && <PasswordSection userId={u.id} name={u.full_name} />}
        <AccessSection userId={u.id} name={u.full_name} active={u.is_active} isSelf={isSelf} openTasks={openTasks} />
      </div>
    </>
  );
}
