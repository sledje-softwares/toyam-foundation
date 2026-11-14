const CONTROL =
  "h-9 w-full rounded border border-border-input bg-surface px-3 text-sm text-text placeholder:text-text-muted disabled:bg-slate-100 aria-[invalid=true]:border-danger";

export function TextInput({ className = "", ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export type SelectOption = { value: string; label: string };

export function Select({
  options,
  placeholder,
  className = "",
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[]; placeholder?: string }) {
  return (
    <select className={`${CONTROL} ${className}`} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Textarea({ className = "", rows = 4, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={`${CONTROL} h-auto py-2 ${className}`} {...rest} />;
}

/** Checkbox with its own label (not wrapped in FormField). */
export function Checkbox({ label, className = "", ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={`inline-flex min-h-8 items-center gap-2 text-sm text-text ${className}`}>
      <input type="checkbox" className="size-4 rounded border-border-input" {...rest} />
      {label}
    </label>
  );
}
