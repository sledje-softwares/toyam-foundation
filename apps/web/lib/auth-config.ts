/** How field operators sign in. Keep equal to the `FIELD_SIGN_IN` secret of the admin-users function. */
export type FieldSignIn = "mobile_password" | "mobile_otp" | "email_password";

const METHODS: readonly FieldSignIn[] = ["mobile_password", "mobile_otp", "email_password"];

/** Unknown or empty values fall back to mobile_password (the local seed's method). */
export function parseFieldSignIn(raw: string | undefined): FieldSignIn {
  const v = (raw ?? "").trim();
  return (METHODS as readonly string[]).includes(v) ? (v as FieldSignIn) : "mobile_password";
}

/** Build-time setting `NEXT_PUBLIC_FIELD_SIGN_IN`; the hosted project uses email_password (T6, 2026-11-18). */
export const FIELD_SIGN_IN: FieldSignIn = parseFieldSignIn(process.env.NEXT_PUBLIC_FIELD_SIGN_IN);
