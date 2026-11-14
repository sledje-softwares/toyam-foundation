import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Enums } from "@/lib/database.types";

type UserRole = Enums<"user_role">;

export type CurrentProfile = { id: string; role: UserRole; full_name: string };

export const STAFF_ROLES: UserRole[] = ["admin", "orchestrator", "office"];

/**
 * Returns the signed-in user's profile (via their own session, so RLS applies),
 * or null if not signed in, no profile exists, or the profile is inactive.
 */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, role, full_name, is_active")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!data || !data.is_active) return null;
  return { id: data.id, role: data.role, full_name: data.full_name };
});

/** Server-side guard: returns the profile if signed in and one of `roles`, else redirects. */
export async function requireRole(roles: UserRole[]): Promise<CurrentProfile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!roles.includes(profile.role)) redirect("/forbidden");
  return profile;
}
