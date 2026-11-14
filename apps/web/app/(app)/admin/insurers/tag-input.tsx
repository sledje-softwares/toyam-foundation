"use client";

import { useState } from "react";
import { TextInput } from "@/components/ui";
import type { FieldControlProps } from "@/components/ui";

export type TagAdd = (existing: string[], typed: string) => { values: string[]; error: string | null; note: string | null };

/** Tags with a text box: Enter, comma or paste adds. `onAdd` normalises and validates. */
export function TagInput({
  id,
  values,
  onChange,
  onAdd,
  placeholder,
  label,
  describedBy,
  invalid,
}: {
  id?: string;
  values: string[];
  onChange: (v: string[]) => void;
  onAdd: TagAdd;
  placeholder: string;
  label: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ error: string | null; note: string | null }>({ error: null, note: null });

  function commit(raw: string) {
    if (!raw.trim()) return;
    const r = onAdd(values, raw);
    onChange(r.values);
    setMsg({ error: r.error, note: r.note });
    setText(r.error ? raw : "");
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={label}>
          {values.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pl-2 pr-1 text-sm">
              {t}
              <button type="button" aria-label={`Remove ${t}`} className="rounded px-1 text-text-muted hover:text-danger" onClick={() => onChange(values.filter((x) => x !== t))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <TextInput
        id={id}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        aria-label={id ? undefined : label}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onPaste={(e) => {
          e.preventDefault();
          commit(e.clipboardData.getData("text"));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(text);
          }
        }}
      />
      <div role="status" aria-live="polite">
        {msg.error && <p className="text-sm text-danger">{msg.error}</p>}
        {!msg.error && msg.note && <p className="text-xs text-text-muted">{msg.note}</p>}
      </div>
    </div>
  );
}

export type { FieldControlProps };
