"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog, InlineAlert, SubmitButton, toast } from "@/components/ui";
import { checkTemplateFile } from "@/lib/template-file";
import { setInsurerActiveAction, templateLinkAction, uploadTemplateAction, type TemplateState } from "../actions";

const IDLE: TemplateState = { error: null, uploaded: false };

export function TemplateSection({ insurerId, fileName, uploadedAt }: { insurerId: string; fileName: string | null; uploadedAt: string | null }) {
  const [state, action] = useActionState(uploadTemplateAction, IDLE);
  const [clientError, setClientError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.uploaded) {
      toast("Template uploaded.");
      formRef.current?.reset();
    }
  }, [state]);

  async function download() {
    setBusy(true);
    const r = await templateLinkAction(insurerId);
    setBusy(false);
    setLinkError(r.error);
    if (r.url) window.location.assign(r.url);
  }

  return (
    <section className="max-w-3xl space-y-3 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">Report template</h2>
      {fileName ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            {fileName}
            {uploadedAt && ` · uploaded ${uploadedAt}`}
          </span>
          <Button variant="secondary" onClick={download} disabled={busy}>
            {busy ? "Preparing…" : "Download"}
          </Button>
        </div>
      ) : (
        <InlineAlert tone="warning">No template has been uploaded yet.</InlineAlert>
      )}
      <form ref={formRef} action={action} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="insurer_id" value={insurerId} />
        <label className="sr-only" htmlFor="template-file">
          Choose .docx file
        </label>
        <input
          id="template-file"
          name="file"
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="text-sm"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            setClientError(f ? checkTemplateFile({ name: f.name, size: f.size, type: f.type }) : null);
          }}
        />
        <SubmitButton pendingLabel="Uploading…">Upload template</SubmitButton>
      </form>
      <p className="text-xs text-text-muted">Word .docx only, up to 10 MB. Earlier files are kept; the newest upload is used.</p>
      <div role="status">
        {(clientError ?? state.error ?? linkError) && <p className="text-sm text-danger">{clientError ?? state.error ?? linkError}</p>}
      </div>
    </section>
  );
}

export function ActiveSection({ insurerId, name, isActive, openCases }: { insurerId: string; name: string; isActive: boolean; openCases: number }) {
  const [error, setError] = useState<string | null>(null);
  const run = async (active: boolean) => {
    const r = await setInsurerActiveAction(insurerId, active);
    setError(r.error);
    if (r.done) toast(active ? `${name} reactivated.` : `${name} deactivated.`);
  };
  return (
    <section className="max-w-3xl space-y-2 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">Status</h2>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {isActive ? (
        <ConfirmDialog
          trigger="Deactivate insurer"
          triggerVariant="danger"
          tone="danger"
          title={`Deactivate ${name}?`}
          confirmLabel="Deactivate insurer"
          action={() => run(false)}
        >
          It will no longer be offered when cases are created. Its {openCases} open {openCases === 1 ? "case continues" : "cases continue"} as normal. Incoming emails from its domains are still
          matched but marked for review.
        </ConfirmDialog>
      ) : (
        <ConfirmDialog trigger="Reactivate insurer" title={`Reactivate ${name}?`} confirmLabel="Reactivate insurer" action={() => run(true)}>
          It will be offered again when cases are created.
        </ConfirmDialog>
      )}
    </section>
  );
}
