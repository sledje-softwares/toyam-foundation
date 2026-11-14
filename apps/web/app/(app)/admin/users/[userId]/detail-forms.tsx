"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ConfirmDialog, FormField, InlineAlert, Select, SubmitButton, TextInput } from "@/components/ui";
import { ROLE_LABELS } from "@/lib/format";
import { ROLES } from "@/lib/user-form";
import { resetPasswordAction, saveProfileAction, setActiveAction, updateLoginAction, type PasswordState, type SaveState } from "../actions";
import { TempPassword } from "../temp-password";

const IDLE: SaveState = { error: null, fieldErrors: {}, saved: false };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="max-w-xl space-y-3 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Status({ state, savedText }: { state: SaveState; savedText: string }) {
  return (
    <div role="status">
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      {state.saved && !state.error && <p className="text-sm text-success">{savedText}</p>}
    </div>
  );
}

type Person = { id: string; full_name: string; role: string; region: string; email: string; phone: string; is_active: boolean };

export function ProfileForm({ user, isSelf, regions, openTasks }: { user: Person; isSelf: boolean; regions: string[]; openTasks: number }) {
  const [state, action] = useActionState(saveProfileAction, IDLE);
  const [role, setRole] = useState(user.role);
  const first = user.full_name.split(" ")[0];
  const toStaff = user.role === "field" && role !== "field";
  const toField = user.role !== "field" && role === "field";
  return (
    <Section title="Profile">
      <form action={action} className="space-y-3" noValidate>
        <input type="hidden" name="user_id" value={user.id} />
        <Status state={state} savedText="Profile saved." />
        <FormField label="Full name" required error={state.fieldErrors.full_name}>
          {(p) => <TextInput {...p} name="full_name" defaultValue={user.full_name} autoComplete="off" />}
        </FormField>
        <FormField label="Role" required error={state.fieldErrors.role} hint={isSelf ? "You can't change your own role or deactivate yourself." : undefined}>
          {(p) => (
            <>
              <Select {...p} name="role" value={role} onChange={(ev) => setRole(ev.target.value)} disabled={isSelf} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
              {/* A disabled select is not submitted. */}
              {isSelf && <input type="hidden" name="role" value={user.role} />}
            </>
          )}
        </FormField>
        {toStaff && openTasks > 0 && (
          <InlineAlert tone="warning">
            {first} has {openTasks} open field {openTasks === 1 ? "task" : "tasks"}. They stay assigned but they will no longer be able to use the field app. Reassign them in Cases first.
          </InlineAlert>
        )}
        {toField && <InlineAlert tone="warning">{first} will lose access to this web app and can only use the field app.</InlineAlert>}
        <FormField label="Region" required={role === "field"} error={state.fieldErrors.region}>
          {(p) => (
            <>
              <TextInput {...p} name="region" list="region-options" defaultValue={user.region} autoComplete="off" />
              <datalist id="region-options">
                {regions.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </>
          )}
        </FormField>
        <div className="flex justify-end">
          <SubmitButton>Save profile</SubmitButton>
        </div>
      </form>
    </Section>
  );
}

export function LoginForm({ user }: { user: Person }) {
  const [state, setState] = useState<SaveState>(IDLE);
  const [phone, setPhone] = useState(user.phone);
  const [email, setEmail] = useState(user.email);
  const first = user.full_name.split(" ")[0];
  // The confirmation dialog owns a form, so these inputs sit outside any form and are collected on confirm.
  async function save() {
    const fd = new FormData();
    fd.set("user_id", user.id);
    fd.set("phone", phone);
    fd.set("email", email);
    setState(await updateLoginAction(IDLE, fd));
  }
  return (
    <Section title="Sign-in details">
      <Status state={state} savedText="Sign-in details saved." />
      <FormField label="Mobile number" error={state.fieldErrors.phone} hint="10-digit Indian mobile.">
        {(p) => <TextInput {...p} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />}
      </FormField>
      <FormField label="Email" error={state.fieldErrors.email}>
        {(p) => <TextInput {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
      </FormField>
      <div className="flex justify-end">
        <ConfirmDialog trigger="Save sign-in details" title="Change sign-in details?" confirmLabel="Save sign-in details" action={save}>
          {first} must use the new mobile number or email the next time they sign in.
        </ConfirmDialog>
      </div>
    </Section>
  );
}

export function PasswordSection({ userId, name }: { userId: string; name: string }) {
  const [result, setResult] = useState<PasswordState | null>(null);
  return (
    <Section title="Password">
      <p className="text-sm text-text-muted">Create a new temporary password. The current one stops working.</p>
      {result?.error && <InlineAlert tone="danger">{result.error}</InlineAlert>}
      {result?.temporary_password && <TempPassword password={result.temporary_password} />}
      <div className="flex justify-end">
        <ConfirmDialog
          trigger="Reset password"
          title={`Reset password for ${name}?`}
          confirmLabel="Reset password"
          action={async () => setResult(await resetPasswordAction(userId))}
        >
          The current password stops working immediately.
        </ConfirmDialog>
      </div>
    </Section>
  );
}

export function AccessSection({ userId, name, active, isSelf, openTasks }: { userId: string; name: string; active: boolean; isSelf: boolean; openTasks: number }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const first = name.split(" ")[0];
  return (
    <Section title="Access">
      {openTasks > 0 && (
        <p className="text-sm">
          {openTasks} open {openTasks === 1 ? "task is" : "tasks are"} assigned to {first}. <Link href="/tasks" className="underline">View tasks</Link>
        </p>
      )}
      {isSelf && active && <p className="text-sm text-text-muted">You can&apos;t change your own role or deactivate yourself.</p>}
      <div role="status">
        {error && <InlineAlert tone="danger">{error}</InlineAlert>}
        {done && !error && <p className="text-sm text-success">{done}</p>}
      </div>
      {!(isSelf && active) && (
        <div className="flex justify-end">
          {active ? (
            <ConfirmDialog
              trigger="Deactivate user"
              triggerVariant="danger"
              tone="danger"
              title={`Deactivate ${name}?`}
              confirmLabel="Deactivate user"
              action={async () => {
                const r = await setActiveAction(userId, false);
                setError(r.error);
                setDone(r.done ? `${name} deactivated.` : null);
              }}
            >
              {first} will be signed out on all devices and can&apos;t sign in. Cases, tasks and evidence stay as they are.
              {openTasks > 0 && ` ${openTasks} open ${openTasks === 1 ? "task is" : "tasks are"} still assigned.`}
            </ConfirmDialog>
          ) : (
            <ConfirmDialog
              trigger="Reactivate user"
              title={`Reactivate ${name}?`}
              confirmLabel="Reactivate user"
              action={async () => {
                const r = await setActiveAction(userId, true);
                setError(r.error);
                setDone(r.done ? `${name} reactivated.` : null);
              }}
            >
              {first} will be able to sign in again with the existing password.
            </ConfirmDialog>
          )}
        </div>
      )}
    </Section>
  );
}
