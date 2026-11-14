"use client";

import { useActionState, useEffect, useState } from "react";
import {
  BOOLEAN_OPTIONS,
  FIELD_PREFIX,
  INITIAL_SECTION_STATE,
  ORIGINAL_PREFIX,
  parseMulti,
  PRESENT_PREFIX,
  VALUE_SOURCES,
  type SectionState,
  type WorkspaceField,
} from "@/lib/reports";
import { Badge, Button, Checkbox, FormField, InlineAlert, Select, SubmitButton, Textarea, TextInput } from "@/components/ui";
import { toast } from "@/components/ui/toaster";
import { useUnsavedChangesGuard } from "./unsaved-guard";

type SaveAction = (prev: SectionState, fd: FormData) => Promise<SectionState>;

export function SourceBadge({ f }: { f: WorkspaceField }) {
  if (!f.source) return null;
  const s = VALUE_SOURCES[f.source];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function ConflictNote({ value }: { value: string }) {
  return (
    <p className="mt-1 rounded bg-warning-soft px-2 py-1 text-xs text-warning">
      Saved meanwhile by someone else: {value ? <strong className="break-words">{value}</strong> : <em>cleared</em>}
    </p>
  );
}

function Control({ f, values, error, conflict }: { f: WorkspaceField; values: string[]; error?: string; conflict?: string }) {
  const name = `${FIELD_PREFIX}${f.key}`;
  const value = values[0] ?? "";
  const hint =
    [f.asText ? `Stored as "${f.value}", which is not in the expected format. Correct it if needed.` : null, f.help]
      .filter(Boolean)
      .join(" ") || undefined;

  if (f.type === "multi_choice") {
    const options = [...f.options, ...values.filter((v) => !f.options.includes(v))];
    return (
      <fieldset className="space-y-1" aria-describedby={error ? `${f.key}-err` : undefined}>
        <legend className="text-sm font-medium text-text">
          {f.label}
          {f.required && <span aria-hidden="true" className="text-danger"> *</span>}
        </legend>
        {f.help && <p className="text-xs text-text-muted">{f.help}</p>}
        <div className="flex flex-wrap gap-x-4">
          {options.map((o) => (
            <Checkbox key={o} name={name} value={o} label={o} defaultChecked={values.includes(o)} />
          ))}
        </div>
        {error && (
          <p id={`${f.key}-err`} className="text-sm text-danger">
            {error}
          </p>
        )}
        {conflict !== undefined && <ConflictNote value={conflict} />}
      </fieldset>
    );
  }

  return (
    <>
      <FormField label={f.label} required={f.required} hint={hint} error={error}>
        {(p) => {
          if (f.asText || f.type === "text") return <TextInput {...p} name={name} defaultValue={value} autoComplete="off" />;
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
            case "choice": {
              // A stored value outside the options stays as its own choice, so nothing is lost silently.
              const opts = value && !f.options.includes(value) ? [value, ...f.options] : f.options;
              return <Select {...p} name={name} defaultValue={value} placeholder="—" options={opts.map((o) => ({ value: o, label: o }))} />;
            }
            default:
              return <TextInput {...p} name={name} defaultValue={value} autoComplete="off" />;
          }
        }}
      </FormField>
      {conflict !== undefined && <ConflictNote value={conflict} />}
    </>
  );
}

/** Read view of a value (locked workspace, mirrored fields). */
export function ValueText({ f }: { f: WorkspaceField }) {
  if (!f.value.trim()) return <span className="text-text-muted">—</span>;
  if (f.type === "multi_choice") return <>{parseMulti(f.value).join(", ")}</>;
  return <span className="whitespace-pre-wrap break-words">{f.value}</span>;
}

/**
 * One section's form. Posts every rendered field (p: marker, f: value, o: value as loaded); saveSection writes only
 * the changed ones and refuses values changed underneath. `version` changes after a save, which remounts the form
 * with the stored values.
 */
export function SectionEditor({
  caseId,
  sectionId,
  version,
  fields,
  action,
}: {
  caseId: string;
  sectionId: string;
  version: string;
  fields: WorkspaceField[];
  action: SaveAction;
}) {
  const [state, formAction] = useActionState(action, INITIAL_SECTION_STATE);
  const [dirty, setDirty] = useState(false);
  // Discard remounts the form with the stored values and ignores a failed attempt's typed values.
  const [resets, setResets] = useState(0);
  const [discarded, setDiscarded] = useState<SectionState | null>(null);
  const [seenSavedAt, setSeenSavedAt] = useState(state.savedAt);
  if (state.savedAt !== seenSavedAt) {
    setSeenSavedAt(state.savedAt);
    setDirty(false);
  }
  useUnsavedChangesGuard(dirty);
  useEffect(() => {
    if (state.savedAt) toast(state.saved ? `Saved ${state.saved} ${state.saved === 1 ? "field" : "fields"}.` : "No changes to save.", state.saved ? "success" : "info");
  }, [state.savedAt, state.saved]);

  const failed = state.error !== null && discarded !== state;
  const discard = () => {
    setDiscarded(state);
    setResets((n) => n + 1);
    setDirty(false);
  };
  const valuesOf = (f: WorkspaceField): string[] =>
    failed && f.key in state.values ? state.values[f.key] : f.type === "multi_choice" ? parseMulti(f.value) : [f.value];

  return (
    <form key={`${version}:${resets}`} action={formAction} noValidate onChange={() => setDirty(true)} className="space-y-4">
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="section_id" value={sectionId} />
      {failed && (
        <InlineAlert tone={Object.keys(state.conflicts).length ? "warning" : "danger"} title="Not saved">
          {state.error}
        </InlineAlert>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map((f) => {
          const wide = f.type === "long_text" || f.type === "multi_choice";
          return (
            <div key={f.key} className={wide ? "md:col-span-2" : undefined}>
              {f.readOnly ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-text">
                    {f.label}
                    {f.required && <span aria-hidden="true" className="text-danger"> *</span>}
                  </p>
                  <p className="text-xs text-text-muted">Kept in step with the case record, so it is not edited here.</p>
                  <p className="min-h-9 rounded border border-border bg-slate-50 px-3 py-2 text-sm">
                    <ValueText f={f} />
                  </p>
                </div>
              ) : (
                <>
                  <input type="hidden" name={`${PRESENT_PREFIX}${f.key}`} value="" />
                  <input
                    type="hidden"
                    name={`${ORIGINAL_PREFIX}${f.key}`}
                    value={failed && f.key in state.conflicts ? state.conflicts[f.key] : f.value}
                  />
                  <Control
                    f={f}
                    values={valuesOf(f)}
                    error={failed ? state.fieldErrors[f.key] : undefined}
                    conflict={failed ? state.conflicts[f.key] : undefined}
                  />
                </>
              )}
              {f.source && (
                <p className="mt-1">
                  <SourceBadge f={f} />
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {dirty && <span className="mr-auto text-sm text-text-muted">Unsaved changes</span>}
        <Button variant="secondary" disabled={!dirty && !failed} onClick={discard}>
          Discard
        </Button>
        <SubmitButton pendingLabel="Saving…">Save section</SubmitButton>
      </div>
    </form>
  );
}
