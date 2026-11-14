"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, ConfirmDialog, FormField, InlineAlert, Select, TextInput, toast } from "@/components/ui";
import {
  addItem,
  ALL_INSURERS,
  buildSavePayload,
  CLAIM_TYPE_LABELS,
  CLAIM_TYPES,
  DESC_MAX,
  EVIDENCE_TYPE_LABELS,
  EVIDENCE_TYPES,
  findReplaced,
  hasBlockingErrors,
  impactText,
  isDirty,
  MAX_ITEMS,
  moveItem,
  NAME_MAX,
  orderCategories,
  putInUseText,
  removeItem,
  takeOutOfUseText,
  undoRemove,
  updateItem,
  validateChecklist,
  type Category,
  type ClaimType,
  type EditorItem,
  type EditorState,
  type EvidenceType,
  type OtherTemplate,
  type Removed,
  type Validation,
} from "@/lib/checklists";
import { saveChecklistAction, setInUseAction } from "./actions";
import { useUnsavedChangesGuard } from "./unsaved-guard";

const SELECT =
  "h-9 w-full rounded border border-border-input bg-surface px-2 text-sm text-text disabled:bg-slate-100 aria-[invalid=true]:border-danger";
const ICON_BTN =
  "inline-flex size-8 items-center justify-center rounded border border-border-input bg-surface text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40";
const REQUIRED_TIP = "The field operator cannot complete the task until this item is captured or marked not available.";
const CAMERA_TIP = "The field app will not allow picking from the gallery. Gallery uploads that slip through are flagged for review.";
const FORM_ID = "checklist-form";
const EMPTY_VALIDATION: Validation = { fieldErrors: {}, itemErrors: {}, warnings: [] };

let keySeq = 0;
const nextKey = () => `new-${++keySeq}`;

export type EditorProps = {
  initial: EditorState;
  isActive: boolean;
  insurers: { id: string; name: string; is_active: boolean }[];
  categories: Category[];
  relevant: Record<ClaimType, string[]>;
  others: OtherTemplate[];
  /** Open tasks per template id (this one and the one it would replace). */
  openTasks: Record<string, number>;
};

export function ChecklistEditor({ initial, isActive, insurers, categories, relevant, others, openTasks }: EditorProps) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>(initial);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [shown, setShown] = useState<Validation>(EMPTY_VALIDATION);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const focusNext = useRef<{ key: string; field: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const dirty = !saved && isDirty(initial, state);
  useUnsavedChangesGuard(dirty);
  const live = useMemo(() => validateChecklist(state, { isActive, others }), [state, isActive, others]);
  // Errors appear after the first save attempt and then follow the edits; warnings are always live.
  const errors = shown === EMPTY_VALIDATION ? EMPTY_VALIDATION : live;

  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const row = formRef.current?.querySelector<HTMLElement>(`[data-row="${f.key}"]`);
    const el = row?.querySelector<HTMLElement>(`[data-field="${f.field}"]:not(:disabled)`) ?? row?.querySelector<HTMLElement>("[data-field]:not(:disabled)");
    (el ?? (f.field === "undo" ? formRef.current?.querySelector<HTMLElement>("[data-undo]") : null))?.focus();
  });

  const setItems = (fn: (items: EditorItem[]) => EditorItem[]) => setState((s) => ({ ...s, items: fn(s.items) }));
  const move = (key: string, delta: -1 | 1, field: string) => {
    focusNext.current = { key, field };
    setItems((items) => moveItem(items, key, delta));
  };
  const remove = (key: string) => {
    const r = removeItem(state.items, key);
    if (!r.removed) return;
    focusNext.current = { key: "-", field: "undo" };
    setRemoved(r.removed);
    setState((s) => ({ ...s, items: r.items }));
  };
  const add = () => {
    const key = nextKey();
    focusNext.current = { key, field: "description" };
    setItems((items) => addItem(items, key));
  };

  const claim = state.claim_type || null;
  const catGroups = useMemo(
    () => orderCategories(categories, new Set(claim ? relevant[claim] : []), new Set(state.items.map((i) => i.category_id).filter(Boolean))),
    [categories, relevant, claim, state.items],
  );
  const catNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const insurerName = (id: string | null) => (id ? (insurers.find((i) => i.id === id)?.name ?? "Unknown insurer") : null);
  const insurerOptions = [
    { value: "", label: ALL_INSURERS },
    ...insurers.filter((i) => i.is_active || i.id === state.insurer_id || i.id === initial.insurer_id).map((i) => ({ value: i.id, label: i.name })),
  ];

  const save = () => {
    setError(null);
    const v = validateChecklist(state, { isActive, others });
    setShown(v);
    if (hasBlockingErrors(v)) {
      setError("Check the highlighted fields.");
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    startTransition(async () => {
      const r = await saveChecklistAction(buildSavePayload(state));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSaved(true);
      toast(`Checklist saved (version ${r.version}).`);
      if (!initial.id) router.push(`/admin/checklists/${r.id}`);
      else router.refresh();
    });
  };

  const discard = () => {
    setState(initial);
    setRemoved(null);
    setShown(EMPTY_VALIDATION);
    setError(null);
  };

  const changeStatus = async (inUse: boolean) => {
    if (!initial.id) return;
    const r = await setInUseAction(initial.id, inUse);
    if (!r.ok) {
      toast(r.error, "error");
      return;
    }
    toast(inUse ? "Checklist put in use." : "Checklist taken out of use.");
    router.refresh();
  };

  const savedClaim = initial.claim_type || null;
  const replaced = initial.id && savedClaim ? findReplaced(initial, others) : null;
  const ownOpen = initial.id ? (openTasks[initial.id] ?? 0) : 0;

  return (
    <div className="space-y-6">
    <form
      id={FORM_ID}
      ref={formRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-6"
    >
      {initial.id && <InlineAlert tone="info">{impactText(ownOpen)}</InlineAlert>}
      {!initial.id && (
        <InlineAlert tone="info">A new checklist is saved as not in use. After saving you can put it in use; tasks created before that are not affected.</InlineAlert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <section className="grid gap-4 rounded-lg border border-border bg-surface p-5 md:grid-cols-3">
            <FormField label="Name" required error={errors.fieldErrors.name}>
              {(p) => (
                <TextInput {...p} value={state.name} maxLength={NAME_MAX} onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))} />
              )}
            </FormField>
            <FormField label="Claim type" required error={errors.fieldErrors.claim_type}>
              {(p) => (
                <Select
                  {...p}
                  value={state.claim_type}
                  placeholder={state.claim_type ? undefined : "Choose…"}
                  options={CLAIM_TYPES.map((c) => ({ value: c, label: CLAIM_TYPE_LABELS[c] }))}
                  onChange={(e) => setState((s) => ({ ...s, claim_type: e.target.value as ClaimType | "" }))}
                />
              )}
            </FormField>
            <FormField label="Applies to" required>
              {(p) => <Select {...p} value={state.insurer_id} options={insurerOptions} onChange={(e) => setState((s) => ({ ...s, insurer_id: e.target.value }))} />}
            </FormField>
          </section>

          <section aria-labelledby="items-h" className="space-y-3 rounded-lg border border-border bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="items-h" className="text-base font-semibold">
                Items <span className="text-sm font-normal text-text-muted">({state.items.length} of at most {MAX_ITEMS})</span>
              </h2>
              <p className="text-xs text-text-muted">Move a focused row with Alt+↑ / Alt+↓.</p>
            </div>
            <dl className="grid gap-1 text-xs text-text-muted">
              <div>
                <dt className="inline font-medium">Required: </dt>
                <dd className="inline">{REQUIRED_TIP}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Camera only: </dt>
                <dd className="inline">{CAMERA_TIP}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Evidence category: </dt>
                <dd className="inline">The item ticks itself when a file with this label is posted to the task.</dd>
              </div>
            </dl>
            {errors.fieldErrors.items && <p className="text-sm text-danger">{errors.fieldErrors.items}</p>}

            {state.items.length === 0 ? (
              <div className="rounded border border-dashed border-border-input px-4 py-6 text-center text-sm">
                <p>Add the first item the field operator should capture.</p>
              </div>
            ) : (
              <ol className="space-y-2">
                {state.items.map((it, idx) => (
                  <ItemRow
                    key={it.key}
                    item={it}
                    index={idx}
                    count={state.items.length}
                    error={errors.itemErrors[it.key]}
                    catGroups={catGroups}
                    claimLabel={claim ? CLAIM_TYPE_LABELS[claim] : null}
                    onChange={(patch) => setItems((items) => updateItem(items, it.key, patch))}
                    onMove={(d, field) => move(it.key, d, field)}
                    onRemove={() => remove(it.key)}
                  />
                ))}
              </ol>
            )}

            <div role="status" className="min-h-6 text-sm">
              {removed && !state.items.some((x) => x.key === removed.item.key) && (
                <span>
                  Item removed.{" "}
                  <button
                    type="button"
                    data-undo
                    className="font-medium text-primary underline hover:no-underline"
                    onClick={() => {
                      focusNext.current = { key: removed.item.key, field: "description" };
                      setItems((items) => undoRemove(items, removed));
                      setRemoved(null);
                    }}
                  >
                    Undo
                  </button>
                </span>
              )}
            </div>
            <Button variant="secondary" onClick={add} disabled={state.items.length >= MAX_ITEMS}>
              + Add item
            </Button>
          </section>
        </div>

        <Preview state={state} catNames={catNames} />
      </div>

      {live.warnings.length > 0 && (
        <InlineAlert tone="warning">
          <ul className="list-disc pl-5">
            {live.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </InlineAlert>
      )}
      <div role="alert">{error && <InlineAlert tone="danger">{error}</InlineAlert>}</div>
    </form>

      {/* Outside the form: ConfirmDialog renders its own <form>. */}
      <div className="sticky bottom-0 -mx-2 flex flex-wrap items-center gap-2 border-t border-border bg-surface px-4 py-3">
        <span className="mr-auto text-sm text-text-muted" aria-live="polite">
          {dirty ? (
            <>
              <span aria-hidden="true" className="text-warning">● </span>Unsaved changes
            </>
          ) : initial.id ? (
            "All changes saved"
          ) : (
            ""
          )}
        </span>
        {initial.id && (
          <ButtonLink variant="secondary" href={`/admin/checklists/new?copy=${initial.id}`}>
            Duplicate
          </ButtonLink>
        )}
        {initial.id && savedClaim && dirty && (
          <Button variant="secondary" disabled title="Save or discard your changes first.">
            {isActive ? "Take out of use" : "Put in use"}
          </Button>
        )}
        {initial.id && savedClaim && !dirty && !isActive && (
          <ConfirmDialog trigger="Put in use" title="Put checklist in use?" confirmLabel="Put in use" action={() => changeStatus(true)}>
            {putInUseText({
              name: initial.name,
              claim_type: savedClaim,
              insurerName: insurerName(initial.insurer_id || null),
              replaced: replaced ? { version: replaced.version, openTasks: openTasks[replaced.id] ?? 0 } : null,
              openTasks: ownOpen,
            })}
          </ConfirmDialog>
        )}
        {initial.id && !dirty && isActive && (
          <ConfirmDialog trigger="Take out of use" title="Take checklist out of use?" confirmLabel="Take out of use" tone="danger" action={() => changeStatus(false)}>
            {takeOutOfUseText(ownOpen)}
          </ConfirmDialog>
        )}
        {dirty && (
          <Button variant="secondary" onClick={discard}>
            Discard changes
          </Button>
        )}
        <Button type="submit" form={FORM_ID} disabled={pending || (!dirty && Boolean(initial.id))}>
          {pending ? "Saving…" : "Save checklist"}
        </Button>
      </div>
    </div>
  );
}

function ItemRow({
  item,
  index,
  count,
  error,
  catGroups,
  claimLabel,
  onChange,
  onMove,
  onRemove,
}: {
  item: EditorItem;
  index: number;
  count: number;
  error?: string;
  catGroups: { relevant: Category[]; other: Category[] };
  claimLabel: string | null;
  onChange: (patch: Partial<Omit<EditorItem, "key" | "id">>) => void;
  onMove: (delta: -1 | 1, field: string) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const errId = `item-${item.key}-err`;
  const isNote = item.required_evidence_type === "note";
  return (
    <li
      data-row={item.key}
      className="rounded border border-border p-3"
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        onMove(e.key === "ArrowUp" ? -1 : 1, (e.target as HTMLElement).dataset.field ?? "description");
      }}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span className="w-6 pt-2 text-right text-sm tabular-nums text-text-muted" aria-hidden="true">
          {n}
        </span>
        <div className="min-w-48 flex-1">
          <TextInput
            data-field="description"
            aria-label={`Item ${n} description (required)`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            value={item.description}
            maxLength={DESC_MAX}
            placeholder="What should the field operator capture?"
            onChange={(e) => onChange({ description: e.target.value })}
          />
          {error && (
            <p id={errId} className="mt-1 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <select
          data-field="type"
          aria-label={`Item ${n} type`}
          className={`${SELECT} w-32`}
          value={item.required_evidence_type}
          onChange={(e) => onChange({ required_evidence_type: e.target.value as EvidenceType })}
        >
          {EVIDENCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {EVIDENCE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <label className="inline-flex h-9 items-center gap-1 text-sm" title={REQUIRED_TIP}>
          <input data-field="required" type="checkbox" className="size-4" checked={item.is_mandatory} onChange={(e) => onChange({ is_mandatory: e.target.checked })} />
          Required<span className="sr-only"> (item {n})</span>
        </label>
        <label className={`inline-flex h-9 items-center gap-1 text-sm ${isNote ? "text-text-muted" : ""}`} title={CAMERA_TIP}>
          <input
            data-field="camera"
            type="checkbox"
            className="size-4"
            checked={item.camera_only && !isNote}
            disabled={isNote}
            onChange={(e) => onChange({ camera_only: e.target.checked })}
          />
          Camera only<span className="sr-only"> (item {n})</span>
        </label>
        <div className="flex gap-1">
          <button type="button" data-field="up" className={ICON_BTN} aria-label={`Move item ${n} up`} disabled={index === 0} onClick={() => onMove(-1, "up")}>
            ↑
          </button>
          <button type="button" data-field="down" className={ICON_BTN} aria-label={`Move item ${n} down`} disabled={index === count - 1} onClick={() => onMove(1, "down")}>
            ↓
          </button>
          <button type="button" data-field="remove" className={ICON_BTN} aria-label={`Remove item ${n}`} onClick={onRemove}>
            ✕
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-8">
        <label htmlFor={`cat-${item.key}`} className="text-xs font-medium text-text-muted">
          Evidence category<span className="sr-only"> (item {n})</span>
        </label>
        <select
          id={`cat-${item.key}`}
          data-field="category"
          className={`${SELECT} w-72`}
          value={item.category_id}
          onChange={(e) => onChange({ category_id: e.target.value })}
        >
          <option value="">No category (ticked by hand)</option>
          {catGroups.relevant.length > 0 ? (
            <>
              <optgroup label={`Used in ${claimLabel ?? "this claim type"} report templates`}>
                {catGroups.relevant.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_active ? "" : " (inactive)"}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other categories">
                {catGroups.other.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_active ? "" : " (inactive)"}
                  </option>
                ))}
              </optgroup>
            </>
          ) : (
            catGroups.other.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active ? "" : " (inactive)"}
              </option>
            ))
          )}
        </select>
      </div>
    </li>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{children}</span>;
}

function Preview({ state, catNames }: { state: EditorState; catNames: Map<string, string> }) {
  const required = state.items.filter((i) => i.is_mandatory).length;
  return (
    <aside aria-labelledby="preview-h" className="xl:sticky xl:top-4 xl:self-start">
      <h2 id="preview-h" className="mb-2 text-sm font-semibold">
        Preview (field app)
      </h2>
      <div className="w-full max-w-[360px] rounded-2xl border-4 border-slate-300 bg-surface p-3 shadow-sm">
        <p className="font-semibold">{state.name.trim() || "Untitled checklist"}</p>
        <p className="text-xs text-text-muted">0 of {required} required done</p>
        <hr className="my-2 border-border" />
        {state.items.length === 0 ? (
          <p className="text-sm text-text-muted">No items yet.</p>
        ) : (
          <ol className="space-y-2">
            {state.items.map((it, i) => (
              <li key={it.key} className="text-sm">
                <p>
                  <span className="mr-1 tabular-nums text-text-muted">{i + 1}</span>
                  {it.description.trim() || <span className="italic text-text-muted">No description</span>}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-1 pl-4">
                  <Chip>{EVIDENCE_TYPE_LABELS[it.required_evidence_type]}</Chip>
                  {it.is_mandatory && <Chip>Required</Chip>}
                  {it.camera_only && it.required_evidence_type !== "note" && <Chip>Camera only</Chip>}
                  {it.category_id && <Chip>{catNames.get(it.category_id) ?? "Category"}</Chip>}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="mt-1 text-xs text-text-muted">Approximate — the field app layout may differ slightly.</p>
    </aside>
  );
}
