"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { generateButtonState, INITIAL_GENERATE_STATE, type GenerateState } from "@/lib/report-generate-core";
import { buttonClass } from "@/components/ui";

/**
 * "Generate report" and "Preview" for the workspace header. One request at a time: the button is disabled while the
 * server action runs (up to ~60 s for the PDF) and during a rate-limit countdown. The result (version, warnings, or a
 * clear error) shows under the buttons; the versions list refreshes through revalidation.
 */
export function GenerateReport({
  caseId,
  caseRef,
  previewHref,
  action,
}: {
  caseId: string;
  caseRef: string;
  previewHref: string;
  action: (prev: GenerateState, fd: FormData) => Promise<GenerateState>;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_GENERATE_STATE);
  // Rate-limit countdown, restarted by every new answer (state adjusted during render, keyed by the answer's seq).
  const [countdown, setCountdown] = useState({ seq: 0, left: 0 });
  const busy = useRef(false);
  if (countdown.seq !== state.seq) {
    setCountdown({ seq: state.seq, left: state.status === "error" && state.retryAfter ? state.retryAfter : 0 });
  }
  const retryLeft = countdown.left;
  useEffect(() => {
    if (retryLeft <= 0) return;
    const t = setTimeout(() => setCountdown((c) => ({ seq: c.seq, left: Math.max(0, c.left - 1) })), 1000);
    return () => clearTimeout(t);
  }, [retryLeft]);
  useEffect(() => {
    busy.current = pending;
  }, [pending]);

  const btn = generateButtonState({ pending, retryLeft });
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={previewHref} className={buttonClass("secondary")} aria-disabled={pending || undefined}>
          Preview
        </Link>
        <form
          action={formAction}
          onSubmit={(e) => {
            if (busy.current) e.preventDefault();
            busy.current = true;
          }}
        >
          <input type="hidden" name="case_id" value={caseId} />
          <input type="hidden" name="case_ref" value={caseRef} />
          <button type="submit" disabled={btn.disabled} aria-busy={pending} className={buttonClass("primary")}>
            {btn.label}
          </button>
        </form>
      </div>
      <div role="status" aria-live="polite" className="max-w-md text-right text-sm">
        {pending && <p className="text-text-muted">This can take up to a minute. Keep this page open.</p>}
        {!pending && state.status === "ok" && (
          <div>
            <p className="font-medium text-success">{state.message}</p>
            {state.warnings.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-left text-text-muted">
                {state.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!pending && state.status === "error" && (
          <p className="text-danger">{retryLeft > 0 && state.retryAfter ? `Too many requests. Try again in ${retryLeft} s.` : state.message}</p>
        )}
      </div>
    </div>
  );
}
