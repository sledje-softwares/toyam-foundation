import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile, STAFF_ROLES } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { NAV_ITEMS, type NavBadge } from "@/lib/nav";
import { NavLinks } from "@/components/nav-links";
import { Toaster } from "@/components/ui/toaster";
import { FileCacheProvider } from "@/components/file-cache/provider";
import { SignOutForm } from "@/components/file-cache/sign-out-form";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  // Field users never use the web app.
  if (!STAFF_ROLES.includes(profile.role)) redirect("/login?error=field");

  const items = NAV_ITEMS.filter((i) => i.roles.includes(profile.role));
  // Counts for nav badges, only for items this role sees. { intake: n } shows next to "Intake".
  const badges: Partial<Record<NavBadge, number>> = {};
  const supabase = await createClient();
  if (items.some((i) => i.badge === "intake")) {
    const { count } = await supabase
      .from("intake_extractions")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending_review");
    if (count) badges.intake = count;
  }
  if (items.some((i) => i.badge === "failedMail")) {
    const { count } = await supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .in("status", ["failed", "retry_requested"]);
    if (count) badges.failedMail = count;
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to main content
      </a>
      <aside className="border-b border-slate-200 bg-white p-4 md:w-60 md:border-b-0 md:border-r">
        <p className="px-3 text-base font-semibold">Claims Investigation</p>
        <div className="mt-4">
          <NavLinks items={items} badges={badges} />
        </div>
        <div className="mt-6 border-t border-slate-200 px-3 pt-4 text-sm">
          <p className="font-medium">{profile.full_name}</p>
          <p className="text-slate-600">{ROLE_LABELS[profile.role]}</p>
          <p className="mt-2">
            <Link href="/account" className="text-blue-800 underline hover:no-underline">
              My account
            </Link>
          </p>
          {/* Wipes the browser file cache, then signs out. */}
          <SignOutForm className="mt-2" />
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-screen-2xl flex-1 p-6 md:p-8">
        <FileCacheProvider userId={profile.id}>{children}</FileCacheProvider>
      </main>
      <Toaster />
    </div>
  );
}
