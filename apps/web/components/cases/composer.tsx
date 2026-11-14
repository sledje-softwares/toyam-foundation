"use client";

import { useRef, useState } from "react";
import { FormField, InlineAlert, SubmitButton, Textarea, toast } from "@/components/ui";
import type { CaseActionResult, ComposerMode } from "@/lib/cases";

type Action = (fd: FormData) => Promise<CaseActionResult>;

/**
 * 4.7 thread composer. "Staff note" (default) is staff-only (D32); "Message to field" is visible to the
 * field operators on the case. One client_message_id per draft: a retry after an error cannot store a second copy.
 */
export function Composer({ caseId, caseRef, action, maxLength }: { caseId: string; caseRef: string; action: Action; maxLength: number }) {
  const [mode, setMode] = useState<ComposerMode>("staff");
  const [body, setBody] = useState("");
  const [state, setState] = useState<CaseActionResult>({ error: null, fieldErrors: {} });
  const draftId = useRef<string | null>(null);
  const staff = mode === "staff";

  return (
    <form
      noValidate
      className={`space-y-3 rounded border p-4 ${staff ? "border-amber-300 bg-warning-soft" : "border-border bg-surface"}`}
      action={async (fd) => {
        draftId.current ??= crypto.randomUUID();
        fd.set("client_message_id", draftId.current);
        const res = await action(fd);
        setState(res);
        if (!res.error) {
          draftId.current = null;
          setBody("");
          toast(res.message ?? "Sent.");
        }
      }}
    >
      <input type="hidden" name="case_id" value={caseId} />
      <input type="hidden" name="case_ref" value={caseRef} />
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Send as</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex min-h-8 items-center gap-2">
            <input type="radio" name="mode" value="staff" checked={staff} onChange={() => setMode("staff")} />
            Staff note <span className="text-text-muted">(office only, never shown in the field app)</span>
          </label>
          <label className="inline-flex min-h-8 items-center gap-2">
            <input type="radio" name="mode" value="field" checked={!staff} onChange={() => setMode("field")} />
            Message to field operator
          </label>
        </div>
      </fieldset>
      {state.error && !state.fieldErrors.body && <InlineAlert tone="danger">{state.error}</InlineAlert>}
      <FormField label={staff ? "Staff note" : "Message"} required error={state.fieldErrors.body}>
        {(p) => (
          <Textarea
            {...p}
            name="body"
            rows={3}
            maxLength={maxLength}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              // An edited draft is a new message.
              if (state.error) draftId.current = null;
            }}
          />
        )}
      </FormField>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {staff ? "The case owner and the orchestrator are notified." : "Everyone on the case, including field operators, sees this."}
        </p>
        <SubmitButton pendingLabel="Sending…">{staff ? "Add staff note" : "Send to field"}</SubmitButton>
      </div>
    </form>
  );
}
