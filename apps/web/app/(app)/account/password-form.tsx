"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormField, InlineAlert, SubmitButton, TextInput, toast } from "@/components/ui";
import { PASSWORD_HINT } from "@/lib/password-rules";
import { changePassword, type PasswordState } from "./actions";

const INITIAL: PasswordState = { error: null, fieldErrors: {}, done: false };

export function PasswordForm() {
  const [state, action] = useActionState(changePassword, INITIAL);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.done) {
      toast("Password changed.");
      form.current?.reset();
    }
  }, [state]);

  return (
    <form ref={form} action={action} className="max-w-md space-y-4" noValidate>
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      <FormField label="New password" required error={state.fieldErrors.password} hint={PASSWORD_HINT}>
        {(p) => <TextInput {...p} name="password" type="password" autoComplete="new-password" />}
      </FormField>
      <FormField label="Confirm password" required error={state.fieldErrors.confirm}>
        {(p) => <TextInput {...p} name="confirm" type="password" autoComplete="new-password" />}
      </FormField>
      <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
    </form>
  );
}
