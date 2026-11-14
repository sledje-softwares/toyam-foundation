import { z } from "zod";

/** Matches supabase config.toml: minimum_password_length = 10, password_requirements = lower_upper_letters_digits. */
export const PASSWORD_HINT = "At least 10 characters with upper- and lower-case letters and a number.";

export const PasswordChangeSchema = z
  .object({
    password: z
      .string()
      .min(1, "Enter a new password.")
      .min(10, "Use at least 10 characters.")
      .max(72, "Use at most 72 characters.")
      .regex(/[a-z]/, "Include a lower-case letter.")
      .regex(/[A-Z]/, "Include an upper-case letter.")
      .regex(/[0-9]/, "Include a number."),
    confirm: z.string().min(1, "Confirm the new password."),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The passwords do not match." });

/** First message per field, for FormField errors. */
export function passwordErrors(input: { password: string; confirm: string }): Record<string, string> {
  const r = PasswordChangeSchema.safeParse(input);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = String(i.path[0]);
    if (!out[k]) out[k] = i.message;
  }
  return out;
}
