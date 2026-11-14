"use client";

import { useActionState } from "react";
import { FIELD_PREFIX, type ReviewFieldModel } from "@/lib/intake-review";
import { Badge, ConfirmDialog, FormField, InlineAlert, Select, SubmitButton, Textarea, TextInput } from "@/components/ui";
import { confirmIntake, rejectIntake, type ConfirmState } from "./actions";

const INITIAL: ConfirmState = { error: null, fieldErrors: {}, values: {} };

function Field({ f, value, error }: { f: ReviewFieldModel; value: string; error?: string }) {
  const hint = [f.issue?.message, f.help].filter(Boolean).join(" ") || undefined;
  const ring =
    f.issue?.kind === "missing"
      ? "border-l-4 border-danger bg-danger-soft/40 pl-3"
      : f.issue?.kind === "low_confidence"
        ? "border-l-4 border-amber-400 bg-warning-soft/40 pl-3"
        : "pl-4";
  const name = `${FIELD_PREFIX}${f.key}`;
  return (
    <div className={`rounded py-2 pr-2 ${ring}`}>
      {f.issue && (
        <p className="mb-1">
          <Badge tone={f.issue.kind === "missing" ? "danger" : "warning"}>
            {f.issue.kind === "missing" ? "Missing" : "Low confidence"}
          </Badge>
        </p>
      )}
      <FormField label={f.label} required={f.required} hint={hint} error={error}>
        {(p) =>
          f.type === "long_text" ? (
            <Textarea {...p} name={name} defaultValue={value} rows={3} />
          ) : f.options ? (
            <Select
              {...p}
              name={name}
              defaultValue={value}
              // A parsed value outside the options is kept as its own choice, so nothing is lost silently.
              options={(value && !f.options.includes(value) ? [value, ...f.options] : f.options).map((o) => ({ value: o, label: o }))}
              placeholder="—"
            />
          ) : (
            <TextInput {...p} name={name} defaultValue={value} autoComplete="off" />
          )
        }
      </FormField>
    </div>
  );
}

/** The pre-filled intake fields of the chosen template; submits to confirm_intake(). */
export function ReviewForm({
  extractionId,
  templateId,
  claim,
  fields,
}: {
  extractionId: string;
  templateId: string;
  claim: ReviewFieldModel;
  fields: ReviewFieldModel[];
}) {
  const [state, action] = useActionState(confirmIntake, INITIAL);
  const submitted = Object.keys(state.values).length > 0;
  // After a failed attempt the form shows what was typed, not the parser's values.
  const valueOf = (f: ReviewFieldModel) => (submitted ? (state.values[f.key] ?? "") : f.value);

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="extraction_id" value={extractionId} />
      <input type="hidden" name="template_id" value={templateId} />
      {state.error && <InlineAlert tone="danger" title="The case was not created">{state.error}</InlineAlert>}

      <Field f={claim} value={valueOf(claim)} error={state.fieldErrors[claim.key]} />

      {fields.map((f, i) => {
        const heading = f.section && (i === 0 || fields[i - 1].section !== f.section) ? f.section : null;
        return (
          <div key={f.key}>
            {heading && <h3 className="mb-1 mt-4 text-sm font-semibold uppercase tracking-wide text-text-muted">{heading}</h3>}
            <Field f={f} value={valueOf(f)} error={state.fieldErrors[f.key]} />
          </div>
        );
      })}

      <div className="flex justify-end border-t border-border pt-4">
        <SubmitButton pendingLabel="Creating case…">Create case</SubmitButton>
      </div>
    </form>
  );
}

/** Dismiss with a required reason: reject_intake(). */
export function RejectDialog({ extractionId }: { extractionId: string }) {
  return (
    <ConfirmDialog trigger="Dismiss…" title="Dismiss this email?" confirmLabel="Dismiss email" tone="danger" action={rejectIntake}>
      <p>No case is created. The email stays on record.</p>
      <input type="hidden" name="extraction_id" value={extractionId} />
      <div className="mt-4 text-text">
        <FormField label="Reason" required hint="For example: duplicate of an existing case, not a claim, spam.">
          {(p) => <Textarea {...p} name="reason" required minLength={3} maxLength={500} rows={3} />}
        </FormField>
      </div>
    </ConfirmDialog>
  );
}
