"use client";

import { useRef } from "react";
import { Button, type ButtonVariant } from "./button";
import { SubmitButton } from "./submit-button";

/**
 * Trigger button + native <dialog> (modal: focus is trapped, Esc closes, focus returns to the trigger).
 * Confirm runs `action` (a server action, via a form) and/or `onConfirm`. For tone="danger" Cancel has focus first.
 */
export function ConfirmDialog({
  trigger,
  triggerVariant = "secondary",
  title,
  children,
  confirmLabel,
  tone = "default",
  action,
  onConfirm,
}: {
  trigger: string;
  triggerVariant?: ButtonVariant;
  title: string;
  children?: React.ReactNode;
  /** A verb, e.g. "Deactivate user". */
  confirmLabel: string;
  tone?: "default" | "danger";
  action?: (formData: FormData) => void | Promise<void>;
  onConfirm?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    ref.current?.close();
    triggerRef.current?.focus();
  };
  const danger = tone === "danger";
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`inline-flex h-9 items-center rounded px-4 text-sm font-medium ${
          triggerVariant === "danger" ? "bg-danger text-white hover:bg-danger-hover" : "border border-border-input bg-surface hover:bg-slate-100"
        }`}
        onClick={() => ref.current?.showModal()}
      >
        {trigger}
      </button>
      <dialog
        ref={ref}
        aria-labelledby="confirm-title"
        onClose={() => triggerRef.current?.focus()}
        className="m-auto w-full max-w-md rounded-lg border border-border bg-surface p-0 text-text shadow-xl"
      >
        <form
          action={async (fd) => {
            onConfirm?.();
            await action?.(fd);
            ref.current?.close();
          }}
          className="p-6"
        >
          <h2 id="confirm-title" className="text-xl font-semibold">
            {title}
          </h2>
          {children && <div className="mt-2 text-sm text-text-muted">{children}</div>}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={close} autoFocus={danger}>
              Cancel
            </Button>
            <SubmitButton variant={danger ? "danger" : "primary"} pendingLabel="Working…">
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
