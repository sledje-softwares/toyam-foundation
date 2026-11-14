"use server";

import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { passwordErrors } from "@/lib/password-rules";

export type PasswordState = { error: string | null; fieldErrors: Record<string, string>; done: boolean };

/** Changes the signed-in user's own password through their session (no admin rights, no service-role key). */
export async function changePassword(_prev: PasswordState, formData: FormData): Promise<PasswordState> {
  await requireRole(STAFF_ROLES);
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const fieldErrors = passwordErrors({ password, confirm });
  if (Object.keys(fieldErrors).length) return { error: null, fieldErrors, done: false };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const msg = /same|different/i.test(error.message)
      ? "Choose a password you have not used just now."
      : /weak|characters|password/i.test(error.message) && !/session|jwt/i.test(error.message)
        ? "That password was not accepted. Use at least 10 characters with upper- and lower-case letters and a number."
        : "The password could not be changed. Sign in again and retry.";
    return { error: msg, fieldErrors: {}, done: false };
  }
  return { error: null, fieldErrors: {}, done: true };
}
