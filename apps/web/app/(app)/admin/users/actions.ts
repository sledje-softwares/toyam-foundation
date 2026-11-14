"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { FIELD_SIGN_IN } from "@/lib/auth-config";
import * as adminUsers from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/server";
import { mapDbError, mapZeroRows } from "@/lib/validation/db-errors";
import { hasErrors, loginErrors, newUserErrors, profileErrors, readUserForm, type FieldErrors, type Role, type UserFormValues } from "@/lib/user-form";

export type CreateState = {
  error: string | null;
  fieldErrors: FieldErrors;
  values: UserFormValues;
  /** Present only in the response to the create call; held in memory by the client, never stored. */
  created: null | { user_id: string; full_name: string; temporary_password: string | null; phone: string; email: string };
};
export type SaveState = { error: string | null; fieldErrors: FieldErrors; saved: boolean };
export type PasswordState = { error: string | null; temporary_password: string | null };

const Id = z.guid();
const RELOAD = "Reload the page and try again.";

export async function createUserAction(_prev: CreateState, formData: FormData): Promise<CreateState> {
  await requireRole(["admin"]);
  const values = readUserForm(formData);
  const fieldErrors = newUserErrors(values, FIELD_SIGN_IN);
  if (hasErrors(fieldErrors)) return { error: "Check the highlighted fields.", fieldErrors, values, created: null };

  const r = await adminUsers.createUser({
    full_name: values.full_name,
    role: values.role as Role,
    ...(values.region && { region: values.region }),
    ...(values.email && { email: values.email }),
    ...(values.phone && { phone: values.phone }),
  });
  if (!r.ok) {
    const known = r.field !== undefined && r.field in values;
    return {
      error: known ? null : `The user was not added. ${r.message}`,
      fieldErrors: known ? { [r.field as keyof UserFormValues]: r.message } : {},
      values,
      created: null,
    };
  }
  revalidatePath("/admin/users");
  return {
    error: null,
    fieldErrors: {},
    values,
    created: { user_id: r.user_id, full_name: values.full_name, temporary_password: r.temporary_password ?? null, phone: values.phone, email: values.email },
  };
}

/** Profile edit: plain RLS update on profiles; zero returned rows means RLS refused it. */
export async function saveProfileAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const me = await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!Id.safeParse(userId).success) return { error: RELOAD, fieldErrors: {}, saved: false };
  const v = readUserForm(formData);
  const supabase = await createClient();
  if (userId === me.id) {
    const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
    if (data && data.role !== v.role) return { error: null, fieldErrors: { role: "You can't change your own role." }, saved: false };
  }
  const fieldErrors = profileErrors(v);
  if (hasErrors(fieldErrors)) return { error: "Check the highlighted fields.", fieldErrors, saved: false };

  const { data, error } = await supabase
    .from("profiles")
    .update({ full_name: v.full_name, role: v.role as Role, region: v.region || null })
    .eq("id", userId)
    .select("id");
  if (error) return { error: mapDbError(error).message, fieldErrors: {}, saved: false };
  if (!data || data.length !== 1) return { error: mapZeroRows().message, fieldErrors: {}, saved: false };
  revalidatePath("/admin/users", "layout");
  return { error: null, fieldErrors: {}, saved: true };
}

export async function updateLoginAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  await requireRole(["admin"]);
  const userId = String(formData.get("user_id") ?? "");
  if (!Id.safeParse(userId).success) return { error: RELOAD, fieldErrors: {}, saved: false };
  const v = readUserForm(formData);
  const fieldErrors = loginErrors(v);
  if (hasErrors(fieldErrors)) return { error: null, fieldErrors, saved: false };
  const r = await adminUsers.updateLogin({ user_id: userId, ...(v.email && { email: v.email }), ...(v.phone && { phone: v.phone }) });
  if (!r.ok) {
    const known = r.field === "email" || r.field === "phone";
    return { error: known ? null : r.message, fieldErrors: known ? { [r.field as "email" | "phone"]: r.message } : {}, saved: false };
  }
  revalidatePath("/admin/users", "layout");
  return { error: null, fieldErrors: {}, saved: true };
}

export async function resetPasswordAction(userId: string): Promise<PasswordState> {
  await requireRole(["admin"]);
  if (!Id.safeParse(userId).success) return { error: RELOAD, temporary_password: null };
  const r = await adminUsers.resetPassword(userId);
  return r.ok ? { error: null, temporary_password: r.temporary_password } : { error: r.message, temporary_password: null };
}

export async function setActiveAction(userId: string, active: boolean): Promise<{ error: string | null; done: boolean }> {
  await requireRole(["admin"]);
  if (!Id.safeParse(userId).success) return { error: RELOAD, done: false };
  const r = await adminUsers.setActive(userId, active);
  if (!r.ok) return { error: r.code === "self_deactivate" ? "You can't deactivate yourself." : r.message, done: false };
  revalidatePath("/admin/users", "layout");
  return { error: null, done: true };
}
