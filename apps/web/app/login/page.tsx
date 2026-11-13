import { redirect } from "next/navigation";
import { getCurrentProfile, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const profile = await getCurrentProfile();
  if (profile && STAFF_ROLES.includes(profile.role)) redirect("/dashboard");

  let initialError: string | null = null;
  if (error === "field" || profile) {
    // Signed in but not allowed here (field user): end the session.
    const supabase = await createClient();
    await supabase.auth.signOut().catch(() => {});
    initialError = "Field staff use the Android app. This web app is for office staff.";
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">Claims investigation platform for office staff.</p>
      <LoginForm initialError={initialError} />
    </main>
  );
}
