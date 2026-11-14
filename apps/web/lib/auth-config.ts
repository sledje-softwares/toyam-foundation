/** How field operators sign in. Keep equal to the `FIELD_SIGN_IN` secret of the admin-users function. */
export type FieldSignIn = "mobile_password" | "mobile_otp" | "email_password";

export const FIELD_SIGN_IN: FieldSignIn = "mobile_password";
