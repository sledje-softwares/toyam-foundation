import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentProfile, redirectToLogin, STAFF_ROLES } from "@/lib/auth";
import { ROLE_LABELS } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { NAV_ITEMS, type NavBadge } from "@/lib/nav";
import { NavLinks } from "@/components/nav-links";
import { Toaster } from "@/components/ui/toaster";
import { FileCacheProvider } from "@/components/file-cache/provider";
import { SignOutForm } from "@/components/file-cache/sign-out-form";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile) return redirectToLogin();
  // Field users never use the web app.
  if (!STAFF_ROLES.includes(profile.role)) redirect("/login?error=field");

  const items = NAV_ITEMS.filter((i) => i.roles.includes(profile.role));
  // Counts for nav badges, only for items this role sees. { intake: n } shows next to "Intake".
  const badges: Partial<Record<NavBadge, number>> = {};
  const supabase = await createClient();
  const [intake, failedMail] = await Promise.all([
    items.some((i) => i.badge === "intake")
      ? supabase.from("intake_extractions").select("id", { count: "exact", head: true }).eq("status", "pending_review")
      : null,
    items.some((i) => i.badge === "failedMail")
      ? supabase.from("emails").select("id", { count: "exact", head: true }).in("status", ["failed", "retry_requested"])
      : null,
  ]);
  if (intake?.count) badges.intake = intake.count;
  if (failedMail?.count) badges.failedMail = failedMail.count;

  return (
    <>
      <AppShell
        brand={
          <Link href="/dashboard" className="block truncate text-base font-semibold text-text">
            Claims Investigation
          </Link>
        }
        sidebar={
          <>
            <NavLinks items={items} badges={badges} />
            <div className="mt-6 border-t border-border px-3 pt-4 text-sm">
              <p className="font-medium">{profile.full_name}</p>
              <p className="text-text-muted">{ROLE_LABELS[profile.role]}</p>
              <p className="mt-2">
                <Link href="/account" className="text-primary underline hover:no-underline">
                  My account
                </Link>
              </p>
              {/* Wipes the browser file cache, then signs out. */}
              <SignOutForm className="mt-2" />
            </div>
          </>
        }
      >
        <FileCacheProvider userId={profile.id}>{children}</FileCacheProvider>
      </AppShell>
      <Toaster />
    </>
  );
}
