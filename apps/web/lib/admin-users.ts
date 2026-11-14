/**
 * Server-side wrapper for the `admin-users` edge function (contract: supabase/functions/admin-users/README.md).
 * Called with the signed-in user's own session (their JWT is sent); no service-role key exists in this app.
 */
import { createClient } from "@/lib/supabase/server";
import {
  mapAdminUsersError,
  parseAdminUsersBody,
  readInvokeError,
  type AdminUsersBody,
  type AdminUsersResult,
  type CreateResult,
  type ResetResult,
  type SetActiveResult,
  type UpdateLoginResult,
} from "./admin-users-errors";

export * from "./admin-users-errors";

async function call<T>(body: AdminUsersBody): Promise<AdminUsersResult<T>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    if (error) return await readInvokeError(error);
    return parseAdminUsersBody<T>(data);
  } catch {
    return mapAdminUsersError(null);
  }
}

export const createUser = (b: Omit<Extract<AdminUsersBody, { action: "create" }>, "action">) =>
  call<CreateResult>({ action: "create", ...b });
export const updateLogin = (b: Omit<Extract<AdminUsersBody, { action: "update_login" }>, "action">) =>
  call<UpdateLoginResult>({ action: "update_login", ...b });
export const resetPassword = (userId: string) => call<ResetResult>({ action: "reset_password", user_id: userId });
export const setActive = (userId: string, active: boolean) =>
  call<SetActiveResult>({ action: "set_active", user_id: userId, active });
