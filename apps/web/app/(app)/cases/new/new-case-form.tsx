"use client";

import { useActionState } from "react";
import { BOOLEAN_OPTIONS, FIELD_PREFIX } from "@/lib/reports";
import { AUTO_OWNER, groupBySection, NEW_CASE_IDLE, NOTE_MAX, type NewCaseField } from "@/lib/new-case";
import { ButtonLink, Checkbox, FormField, InlineAlert, Select, SubmitButton, Textarea, TextInput } from "@/components/ui";
import { createCaseAction } from "./actions";

function Control({ f, values, error }: { f: NewCaseField; values: string[]; error?: string }) {
  const name = `${FIELD_PREFIX}${f.key}`;
  const value = values[0] ?? "";

  if (f.type === "multi_choice") {
    return (
      <fieldset className="space-y-1" aria-describedby={error ? `${f.key}-err` : undefined}>
        <legend className="text-sm font-medium text-text">
          {f.label}
          {f.required && (
            <>
              <span aria-hidden="true" className="text-danger"> *</span>
              <span className="sr-only"> (required)</span>
            </>
          )}
        </legend>
        {f.help && <p className="text-xs text-text-muted">{f.help}</p>}
        <div className="flex flex-wrap gap-x-4">
          {f.options.map((o) => (
            <Checkbox key={o} name={name} value={o} label={o} defaultChecked={values.includes(o)} />
          ))}
        </div>
        {error && (
          <p id={`${f.key}-err`} className="text-sm text-danger">
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  return (
    <FormField label={f.label} required={f.required} hint={f.help ?? undefined} error={error}>
      {(p) => {
        switch (f.type) {
          case "long_text":
            return <Textarea {...p} name={name} defaultValue={value} rows={3} />;
          case "number":
          case "currency":
            return <TextInput {...p} name={name} defaultValue={value} inputMode="decimal" autoComplete="off" />;
          case "date":
            return <TextInput {...p} name={name} type="date" defaultValue={value} />;
          case "datetime":
            return <TextInput {...p} name={name} type="datetime-local" defaultValue={value} />;
          case "boolean":
            return <Select {...p} name={name} defaultValue={value} placeholder="—" options={BOOLEAN_OPTIONS.map((o) => ({ value: o, label: o }))} />;
          case "choice":
            return f.options.length ? (
              <Select {...p} name={name} defaultValue={value} placeholder="—" options={f.options.map((o) => ({ value: o, label: o }))} />
            ) : (
              <TextInput {...p} name={name} defaultValue={value} autoComplete="off" />
            );
          default:
            return <TextInput {...p} name={name} defaultValue={value} autoComplete="off" />;
        }
      }}
    </FormField>
  );
}

/** Step 2 of /cases/new: the template's intake fields, owner (orchestrator / admin) and an optional staff note. */
export function NewCaseForm({
  templateId,
  fields,
  owners,
  cancelHref,
}: {
  templateId: string;
  fields: NewCaseField[];
  /** null: the caller is an office employee and becomes the owner. */
  owners: { value: string; label: string }[] | null;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState(createCaseAction, NEW_CASE_IDLE);
  // Remount after each failed attempt so the fields show what was submitted.
  const attempt = state.attempt ?? 0;
  const v = (key: string) => state.values[key] ?? [];

  return (
    <form key={attempt} action={formAction} noValidate className="max-w-3xl space-y-6">
      <input type="hidden" name="template_id" value={templateId} />
      {state.error && (
        <InlineAlert tone="danger" title="Case not created">
          {state.error}
        </InlineAlert>
      )}

      {groupBySection(fields).map((g, i) => (
        <section key={`${i}-${g.title ?? ""}`} className="rounded border border-border bg-surface p-4">
          {g.title && <h2 className="mb-3 text-base font-semibold">{g.title}</h2>}
          <div className="grid gap-4 md:grid-cols-2">
            {g.fields.map((f) => (
              <div key={f.key} className={f.type === "long_text" || f.type === "multi_choice" ? "md:col-span-2" : undefined}>
                <Control f={f} values={v(f.key)} error={state.fieldErrors[f.key]} />
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-4 rounded border border-border bg-surface p-4">
        <h2 className="text-base font-semibold">Assignment</h2>
        {owners ? (
          <FormField
            label="Owner"
            hint="Automatic assignment follows the assignment rules and availability."
            error={state.fieldErrors.owner}
          >
            {(p) => (
              <Select
                {...p}
                name="owner"
                defaultValue={v("owner")[0] ?? AUTO_OWNER}
                options={[{ value: AUTO_OWNER, label: "Assign automatically" }, ...owners]}
              />
            )}
          </FormField>
        ) : (
          <p className="text-sm text-text">This case will be assigned to you.</p>
        )}
        <FormField
          label="Staff note (optional)"
          hint={`Shown in the case thread to office staff only. At most ${NOTE_MAX} characters.`}
          error={state.fieldErrors.note}
        >
          {(p) => <Textarea {...p} name="note" defaultValue={v("note")[0] ?? ""} rows={3} maxLength={NOTE_MAX} />}
        </FormField>
      </section>

      <div className="flex items-center justify-end gap-2">
        <ButtonLink variant="secondary" href={cancelHref}>
          Cancel
        </ButtonLink>
        <SubmitButton pendingLabel="Creating…">Create case</SubmitButton>
      </div>
    </form>
  );
}
