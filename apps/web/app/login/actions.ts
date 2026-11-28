"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { STAFF_ROLES } from "@/lib/auth";
import { safeNext } from "@/lib/safe-next";

export type LoginState = { error: string | null };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "Incorrect email or password." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    return { error: "This account is not active. Contact an administrator." };
  }
  if (!STAFF_ROLES.includes(profile.role)) {
    await supabase.auth.signOut();
    return { error: "Field staff use the Android app. This web app is for office staff." };
  }
  // Back to the page the user asked for before signing in (form field from ?next=); unsafe values go to /dashboard.
  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
