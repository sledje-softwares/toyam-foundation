"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "./button";

/** Submit button that disables itself and shows "Saving…" while the parent form's action runs. */
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  variant = "primary",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} aria-disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
