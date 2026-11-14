"use client";

import { useActionState, useState } from "react";
import { ButtonLink, FormField, InlineAlert, SubmitButton, TextInput } from "@/components/ui";
import { FIELD_SIGN_IN } from "@/lib/auth-config";
import { formatPhone, ROLE_LABELS } from "@/lib/format";
import { ROLES } from "@/lib/user-form";
import { createUserAction, type CreateState } from "../actions";
import { TempPassword } from "../temp-password";

const INITIAL: CreateState = { error: null, fieldErrors: {}, values: { full_name: "", role: "", region: "", email: "", phone: "" }, created: null };

export function NewUserForm({ regions }: { regions: string[] }) {
  const [state, action] = useActionState(createUserAction, INITIAL);
  const [role, setRole] = useState(state.values.role);
  const v = state.values;
  const e = state.fieldErrors;
  const field = role === "field";
  const emailRequired = !field || FIELD_SIGN_IN === "email_password";

  if (state.created) {
    const c = state.created;
    return (
      <section aria-labelledby="created-title" className="max-w-xl space-y-4 rounded-lg border border-border bg-surface p-6">
        <h2 id="created-title" className="text-xl font-semibold">
          {c.full_name} can now sign in
        </h2>
        <dl className="space-y-1 text-sm">
          {c.phone && (
            <div className="flex gap-3">
              <dt className="w-32 text-text-muted">Mobile number</dt>
              <dd>{formatPhone(c.phone)}</dd>
            </div>
          )}
          {c.email && (
            <div className="flex gap-3">
              <dt className="w-32 text-text-muted">Email</dt>
              <dd>{c.email}</dd>
            </div>
          )}
        </dl>
        {c.temporary_password ? (
          <TempPassword password={c.temporary_password} />
        ) : (
          <InlineAlert>No password was created. They sign in with a code sent to their mobile number.</InlineAlert>
        )}
        <div className="flex justify-end">
          <ButtonLink href={`/admin/users/${c.user_id}`}>Done</ButtonLink>
        </div>
      </section>
    );
  }

  return (
    <form action={action} className="max-w-xl space-y-4" noValidate>
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      <FormField label="Full name" required error={e.full_name}>
        {(p) => <TextInput {...p} name="full_name" defaultValue={v.full_name} autoComplete="off" />}
      </FormField>
      <fieldset aria-describedby={e.role ? "role-err" : undefined}>
        <legend className="text-sm font-medium">
          Role <span aria-hidden="true" className="text-danger">*</span>
        </legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm">
              <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
              {ROLE_LABELS[r]}
            </label>
          ))}
        </div>
        {e.role && (
          <p id="role-err" className="mt-1 text-sm text-danger">
            {e.role}
          </p>
        )}
      </fieldset>
      <FormField
        label="Region"
        required={field}
        hint={field ? "Used to pick operators for a case area." : "Optional for office staff."}
        error={e.region}
      >
        {(p) => (
          <>
            <TextInput {...p} name="region" list="region-options" defaultValue={v.region} autoComplete="off" />
            <datalist id="region-options">
              {regions.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </>
        )}
      </FormField>
      <h2 className="border-t border-border pt-3 text-sm font-semibold">Sign-in details</h2>
      <FormField
        label="Mobile number"
        required={field}
        hint={field ? "Field operators sign in with this number. 10-digit Indian mobile." : "Optional for staff."}
        error={e.phone}
      >
        {(p) => <TextInput {...p} name="phone" type="tel" inputMode="tel" defaultValue={v.phone} autoComplete="off" placeholder="98000 00001" />}
      </FormField>
      <FormField label="Email" required={emailRequired} hint={emailRequired ? "Used to sign in to the web app." : "Optional for field operators."} error={e.email}>
        {(p) => <TextInput {...p} name="email" type="email" defaultValue={v.email} autoComplete="off" />}
      </FormField>
      <p className="text-sm text-text-muted">
        {field && FIELD_SIGN_IN === "mobile_otp" ? "No password is created; they sign in with a code." : "A temporary password is created when you save."}
      </p>
      <div className="flex justify-end gap-2">
        <ButtonLink href="/admin/users" variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton pendingLabel="Adding…">Add user</SubmitButton>
      </div>
    </form>
  );
}
