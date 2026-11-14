"use client";

import { useActionState, useEffect, useState } from "react";
import { Button, ButtonLink, FormField, InlineAlert, Select, SubmitButton, TextInput, Textarea, toast } from "@/components/ui";
import {
  addDomains,
  EXTRACTION_FIELDS,
  isPublicMailDomain,
  MAX_ALIAS_LABEL_LENGTH,
  MAX_ALIAS_LABELS,
  MAX_NOTES,
  type Alias,
  type InsurerFormValues,
} from "@/lib/insurer-form";
import { saveInsurerAction, type InsurerSaveState } from "./actions";
import { TagInput } from "./tag-input";

const IDLE: InsurerSaveState = { error: null, fieldErrors: {}, saved: false };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const addLabels = (existing: string[], typed: string) => {
  const out = [...existing];
  let error: string | null = null;
  for (const part of typed.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean)) {
    if (part.length > MAX_ALIAS_LABEL_LENGTH) error = `Labels can be at most ${MAX_ALIAS_LABEL_LENGTH} characters.`;
    else if (out.length >= MAX_ALIAS_LABELS) error = `At most ${MAX_ALIAS_LABELS} labels per field.`;
    else if (!out.includes(part)) out.push(part);
  }
  return { values: out, error, note: null };
};

export function InsurerForm({ insurerId, initial }: { insurerId: string | null; initial: InsurerFormValues }) {
  const [dirty, setDirty] = useState(false);
  const [state, action] = useActionState(async (prev: InsurerSaveState, fd: FormData) => {
    const r = await saveInsurerAction(prev, fd);
    if (r.saved) {
      toast("Insurer saved.");
      setDirty(false);
    }
    return r;
  }, IDLE);
  const [v, setV] = useState(initial);
  const e = state.fieldErrors;
  const set = <K extends keyof InsurerFormValues>(k: K, val: InsurerFormValues[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setDirty(true);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (ev: BeforeUnloadEvent) => ev.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const usedFields = new Set(v.aliases.map((a) => a.field));
  const setAlias = (i: number, patch: Partial<Alias>) => set("aliases", v.aliases.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <form action={action} className="max-w-3xl space-y-4" noValidate>
      <input type="hidden" name="insurer_id" value={insurerId ?? ""} />
      <input type="hidden" name="sender_domains" value={JSON.stringify(v.sender_domains)} />
      <input type="hidden" name="aliases" value={JSON.stringify(v.aliases)} />
      {state.error && <InlineAlert tone="danger">{state.error}</InlineAlert>}

      <Section title="Basics">
        <FormField label="Name" required error={e.name}>
          {(p) => <TextInput {...p} name="name" value={v.name} maxLength={120} autoComplete="off" onChange={(x) => set("name", x.target.value)} />}
        </FormField>
        <FormField label="Short code" required hint="2 to 10 capital letters or digits. Used in file names of reports and portal packs." error={e.code}>
          {(p) => <TextInput {...p} name="code" value={v.code} maxLength={10} autoComplete="off" onChange={(x) => set("code", x.target.value.toUpperCase())} />}
        </FormField>
      </Section>

      <Section title="Incoming email">
        <FormField label="Sender domains" hint="Emails from these domains are matched to this insurer." error={e.sender_domains}>
          {(p) => (
            <TagInput
              id={p.id}
              describedBy={p["aria-describedby"]}
              invalid={Boolean(e.sender_domains)}
              values={v.sender_domains}
              onChange={(d) => set("sender_domains", d)}
              onAdd={(ex, t) => {
                const r = addDomains(ex, t);
                return { values: r.domains, error: r.error, note: r.note };
              }}
              placeholder="Type a domain and press Enter"
              label="Sender domains"
            />
          )}
        </FormField>
        {v.sender_domains.length === 0 && <InlineAlert tone="warning">No sender domain: emails from this insurer will go to the review queue.</InlineAlert>}
        {v.sender_domains.some(isPublicMailDomain) && <InlineAlert tone="danger">Public email domains can&apos;t identify an insurer.</InlineAlert>}
      </Section>

      <Section title="Deadline">
        <FormField label="Turnaround (days)" required hint="Calendar days from receipt. Changing this applies to new cases only." error={e.tat_days}>
          {(p) => <TextInput {...p} name="tat_days" type="number" inputMode="numeric" min={1} max={365} className="max-w-32" value={v.tat_days} onChange={(x) => set("tat_days", x.target.value)} />}
        </FormField>
      </Section>

      <Section title="Report submission">
        <fieldset>
          <legend className="text-sm font-medium">
            Channel <span aria-hidden="true" className="text-danger">*</span>
          </legend>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
            {(["email", "portal", "other"] as const).map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="radio" name="submission_channel" value={c} checked={v.submission_channel === c} onChange={() => set("submission_channel", c)} />
                {c === "email" ? "Email" : c === "portal" ? "Portal" : "Other"}
              </label>
            ))}
          </div>
          {e.submission_channel && <p className="mt-1 text-sm text-danger">{e.submission_channel}</p>}
        </fieldset>
        <FormField label="Report email" error={e.reply_to_email}>
          {(p) => <TextInput {...p} name="reply_to_email" type="email" value={v.reply_to_email} autoComplete="off" onChange={(x) => set("reply_to_email", x.target.value)} />}
        </FormField>
        {/* Kept in the form (value preserved) when the channel is not Portal, but not shown. */}
        <div hidden={v.submission_channel !== "portal"}>
          <FormField label="Portal address" required={v.submission_channel === "portal"} hint="Starts with https://" error={e.portal_url}>
            {(p) => <TextInput {...p} name="portal_url" type="url" value={v.portal_url} autoComplete="off" onChange={(x) => set("portal_url", x.target.value)} />}
          </FormField>
        </div>
      </Section>

      <Section title="Reading instructions for incoming emails">
        <FormField label="Notes" hint={`Up to ${MAX_NOTES} characters.`} error={e.notes}>
          {(p) => <Textarea {...p} name="notes" value={v.notes} maxLength={MAX_NOTES} onChange={(x) => set("notes", x.target.value)} />}
        </FormField>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Other names this insurer uses for a field</h3>
          {v.aliases.map((a, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2 rounded border border-border p-2">
              <Select
                aria-label="Field"
                className="w-48"
                value={a.field}
                placeholder="Choose field"
                options={EXTRACTION_FIELDS.filter((f) => f.key === a.field || !usedFields.has(f.key)).map((f) => ({ value: f.key, label: f.label }))}
                onChange={(x) => setAlias(i, { field: x.target.value })}
              />
              <div className="min-w-60 flex-1">
                <TagInput values={a.labels} onChange={(l) => setAlias(i, { labels: l })} onAdd={addLabels} placeholder="Type a label and press Enter" label="Labels" />
              </div>
              <Button variant="ghost" onClick={() => set("aliases", v.aliases.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          {e.aliases && <p className="text-sm text-danger">{e.aliases}</p>}
          <Button variant="secondary" onClick={() => set("aliases", [...v.aliases, { field: "", labels: [] }])}>
            + Add field
          </Button>
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t border-border bg-bg px-1 py-3">
        <ButtonLink href="/admin/insurers" variant="secondary">
          Cancel
        </ButtonLink>
        <SubmitButton>Save insurer</SubmitButton>
      </div>
    </form>
  );
}
