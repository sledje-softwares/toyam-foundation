"use client";

import { useState, useTransition } from "react";
import type { ActionResult, LinkResult } from "@/lib/reports";
import { Button, Checkbox } from "@/components/ui";
import { toast } from "@/components/ui/toaster";

type FormAction = (fd: FormData) => Promise<ActionResult>;

/** Opens a short-lived signed link in a new tab (insurer attachments; field files need gap G3). */
export function OpenFileButton({ evidenceId, canOpen, link }: { evidenceId: string; canOpen: boolean; link: (id: string) => Promise<LinkResult> }) {
  const [pending, start] = useTransition();
  if (!canOpen) {
    return (
      <span className="text-xs text-text-muted" title="Viewing field files from the office needs the evidence-view function (not built yet).">
        Preview not available yet
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={pending}
      className="min-h-8 text-xs text-primary underline hover:no-underline disabled:opacity-60"
      onClick={() =>
        start(async () => {
          const r = await link(evidenceId);
          if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
          else toast(r.error ?? "Could not open the file.", "error");
        })
      }
    >
      {pending ? "Opening…" : "Open"}
    </button>
  );
}

/** Not relevant ⇄ relevant (evidence.relevance). */
export function RelevanceButton({
  evidenceId,
  caseRef,
  notRelevant,
  action,
}: {
  evidenceId: string;
  caseRef: string;
  notRelevant: boolean;
  action: FormAction;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="min-h-8 text-xs text-primary underline hover:no-underline disabled:opacity-60"
      onClick={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("evidence_id", evidenceId);
          fd.set("case_ref", caseRef);
          fd.set("relevance", notRelevant ? "relevant" : "not_relevant");
          const r = await action(fd);
          if (r.error) toast(r.error, "error");
        })
      }
    >
      {pending ? "Saving…" : notRelevant ? "Mark relevant" : "Not relevant"}
    </button>
  );
}

/** Replaces the active labels with the chosen categories (set_evidence_labels → human labels). */
export function LabelEditor({
  evidenceId,
  caseRef,
  current,
  options,
  action,
}: {
  evidenceId: string;
  caseRef: string;
  current: string[];
  options: { id: string; name: string }[];
  action: FormAction;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} className="text-xs">
      <summary className="min-h-8 cursor-pointer py-1 text-primary underline hover:no-underline">Change label</summary>
      <form
        className="mt-1 space-y-1 rounded border border-border bg-surface p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          fd.set("evidence_id", evidenceId);
          fd.set("case_ref", caseRef);
          start(async () => {
            const r = await action(fd);
            if (r.error) toast(r.error, "error");
            else {
              toast("Label changed.");
              setOpen(false);
            }
          });
        }}
      >
        <div className="max-h-48 overflow-y-auto">
          {options.map((o) => (
            <Checkbox key={o.id} name="category_id" value={o.id} label={o.name} defaultChecked={current.includes(o.id)} className="w-full" />
          ))}
        </div>
        <p className="text-text-muted">Clear every box to remove the label.</p>
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save label"}
          </Button>
        </div>
      </form>
    </details>
  );
}
