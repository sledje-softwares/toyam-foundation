import { redirect } from "next/navigation";
import { getCurrentProfile, STAFF_ROLES } from "@/lib/auth";
import { NAV_ITEMS } from "@/lib/nav";
import { NavLinks } from "@/components/nav-links";
import { signOut } from "@/app/login/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  // Field users never use the web app.
  if (!STAFF_ROLES.includes(profile.role)) redirect("/login?error=field");

  const items = NAV_ITEMS.filter((i) => i.roles.includes(profile.role));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-slate-200 bg-white p-4 md:w-60 md:border-b-0 md:border-r">
        <p className="px-3 text-base font-semibold">Claims Investigation</p>
        <div className="mt-4">
          <NavLinks items={items} />
        </div>
        <div className="mt-6 border-t border-slate-200 px-3 pt-4 text-sm">
          <p className="font-medium">{profile.full_name}</p>
          <p className="capitalize text-slate-600">{profile.role}</p>
          <form action={signOut} className="mt-2">
            <button type="submit" className="text-blue-800 underline hover:no-underline">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-6 md:p-8">{children}</main>
    </div>
  );
}
