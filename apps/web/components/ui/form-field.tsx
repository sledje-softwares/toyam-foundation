"use client";

import { useId } from "react";

/**
 * Label + hint + error around any control. The control is rendered by a function so it receives the ids:
 *   <FormField label="Name" required error={e}>{(p) => <TextInput {...p} name="name" />}</FormField>
 */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

export function FormField({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="text-danger"> *</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      {hint && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {error && (
        <p id={errId} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
