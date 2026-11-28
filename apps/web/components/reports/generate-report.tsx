"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { revalidateWorkspace } from "@/app/(app)/reports/[caseRef]/actions";
import { useFileCache } from "@/components/file-cache/provider";
import { buttonClass } from "@/components/ui";
import type { Attempt } from "@/lib/report-build/core";
import { buttonState, doneText, IDLE, progressText, splitWarnings, userMessage, type GenerateUi } from "@/lib/report-build/ui";

/**
 * "Generate report" and "Preview" for the workspace header (7.7, D51). The report is built in this browser: the
 * template, values and photo list come from prepare_report_version under the user's own session, photos from the
 * hash-checked file cache, the PDF / Word files from the writers in a Web Worker; they are uploaded and recorded as
 * a new version with the same session. The code for all that loads on the first click only. One run at a time; a
 * transient failure keeps the built files for a retry. The versions list refreshes when the version is recorded.
 */
export function GenerateReport({ caseId, caseRef, previewHref }: { caseId: string; caseRef: string; previewHref: string }) {
  const files = useFileCache();
  const router = useRouter();
  const [ui, setUi] = useState<GenerateUi>(IDLE);
  const running = useRef(false);
  const attempt = useRef<Attempt | null>(null);

  // Leaving the page mid-run loses the work: ask first.
  const busy = ui.status === "running";
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  // The version was written from the browser, so drop the server's cached render of the workspace, then refresh.
  async function refreshWorkspace() {
    try {
      await revalidateWorkspace(caseRef);
    } catch {
      // the refresh below still runs
    }
    startTransition(() => router.refresh());
  }

  async function generate() {
    if (running.current || !files) return;
    running.current = true;
    setUi({ status: "running", progress: { phase: attempt.current ? "uploading" : "preparing" } });
    try {
      const { browserRunDeps, runGenerate } = await import("@/lib/report-build/browser");
      const r = await runGenerate(browserRunDeps(files, caseId), { caseId, attempt: attempt.current }, (progress) =>
        setUi({ status: "running", progress }),
      );
      if (r.ok) {
        attempt.current = null;
        setUi({ status: "done", version: r.version, warnings: r.warnings });
        await refreshWorkspace();
      } else {
        attempt.current = r.attempt;
        setUi({ status: "error", message: userMessage(r.failure, !!r.attempt), warnings: r.warnings, resumable: !!r.attempt });
        if (r.failure.error.code === "values_changed" || r.failure.error.code === "not_editable") await refreshWorkspace();
      }
    } catch {
      // the code chunk did not load (offline, new deployment): nothing was stored
      attempt.current = null;
      setUi({ status: "error", message: "The report could not be generated. Reload the page and try again.", warnings: [], resumable: false });
    } finally {
      running.current = false;
    }
  }

  const btn = buttonState(ui, !!files);
  const { masking, other: warnings } = splitWarnings(ui.status === "done" || ui.status === "error" ? ui.warnings : []);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href={previewHref} className={buttonClass("secondary")} aria-disabled={busy || undefined}>
          Preview
        </Link>
        <button type="button" onClick={() => void generate()} disabled={btn.disabled} aria-busy={busy} className={buttonClass("primary")}>
          {btn.label}
        </button>
      </div>
      <div role="status" aria-live="polite" className="max-w-md text-right text-sm">
        {ui.status === "running" && (
          <p className="text-text-muted">
            <span className="font-medium text-text">{progressText(ui.progress)}</span> Keep this page open.
          </p>
        )}
        {ui.status === "done" && <p className="font-medium text-success">{doneText(ui.version)}</p>}
        {ui.status === "error" && <p className="text-danger">{ui.message}</p>}
        {masking.length > 0 && (
          <div className="mt-1 rounded border border-border p-2 text-left">
            <p className="font-medium text-warning">Aadhaar numbers that were not masked</p>
            <ul className="list-disc pl-5 text-text">
              {masking.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-left text-text-muted">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
