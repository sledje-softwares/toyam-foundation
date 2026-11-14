/** Pure validation for the add-user and user-detail forms (same rules as the admin-users function). */
import type { FieldSignIn } from "./auth-config";
import { normalizeIndianMobile } from "./format";

export type Role = "admin" | "orchestrator" | "office" | "field";
export const ROLES: readonly Role[] = ["admin", "orchestrator", "office", "field"];

export type UserFormValues = { full_name: string; role: string; region: string; email: string; phone: string };
export type FieldErrors = Partial<Record<keyof UserFormValues, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readUserForm(fd: FormData): UserFormValues {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  return { full_name: s("full_name"), role: s("role"), region: s("region"), email: s("email"), phone: s("phone") };
}

export function emailError(email: string, required: boolean): string | undefined {
  if (!email) return required ? "Enter an email address." : undefined;
  return EMAIL.test(email) ? undefined : "Enter a valid email address.";
}

export function phoneError(phone: string, required: boolean): string | undefined {
  if (!phone) return required ? "Enter a mobile number." : undefined;
  return normalizeIndianMobile(phone) ? undefined : "Enter a 10-digit Indian mobile number.";
}

export function profileErrors(v: Pick<UserFormValues, "full_name" | "role" | "region">): FieldErrors {
  const e: FieldErrors = {};
  if (v.full_name.length < 2 || v.full_name.length > 80) e.full_name = "Enter a name of 2 to 80 characters.";
  if (!(ROLES as readonly string[]).includes(v.role)) e.role = "Choose a role.";
  if (v.region.length > 60) e.region = "Use at most 60 characters.";
  else if (v.role === "field" && !v.region) e.region = "Enter a region for field operators.";
  return e;
}

/** Requirements switch with the role and FIELD_SIGN_IN. */
export function newUserErrors(v: UserFormValues, signIn: FieldSignIn): FieldErrors {
  const e = profileErrors(v);
  const field = v.role === "field";
  const emailReq = !field || signIn === "email_password";
  const em = emailError(v.email, emailReq);
  if (em) e.email = em;
  const ph = phoneError(v.phone, field);
  if (ph) e.phone = ph;
  return e;
}

export function loginErrors(v: Pick<UserFormValues, "email" | "phone">): FieldErrors {
  const e: FieldErrors = {};
  if (!v.email && !v.phone) e.email = "Give a new email and/or mobile number.";
  const em = emailError(v.email, false);
  if (em) e.email = em;
  const ph = phoneError(v.phone, false);
  if (ph) e.phone = ph;
  return e;
}

export function hasErrors(e: FieldErrors): boolean {
  return Object.keys(e).length > 0;
}
