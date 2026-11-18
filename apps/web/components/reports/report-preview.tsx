"use client";

import { useEffect, useState } from "react";
import { useFileCache } from "@/components/file-cache/provider";
import { Button, buttonClass, InlineAlert } from "@/components/ui";
import { previewFileName, progressText, userMessage, type Progress } from "@/lib/report-build/ui";

type State =
  | { status: "loading"; progress: Progress }
  | { status: "ready"; url: string; size: number; warnings: string[] }
  | { status: "error"; message: string };

/**
 * The report PDF as Generate would write it now, built in this browser (7.7, D51) from prepare_report_preview (any
 * case status; nothing is stored or recorded), the 384 px / 1600 px photo copies from the file cache and the writers
 * in the worker. Shown from a blob: URL in an iframe without `sandbox` (Chrome refuses its PDF viewer in a sandboxed
 * frame; the PDF is our own output, made from bytes, and pdfmake fetches nothing). The URL is revoked on unmount.
 */
export function ReportPreview({ caseId, caseRef }: { caseId: string; caseRef: string }) {
  const files = useFileCache();
  const [run, setRun] = useState(0);
  const [state, setState] = useState<State>({ status: "loading", progress: { phase: "preparing" } });

  useEffect(() => {
    if (!files) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const { browserRunDeps, runPreview } = await import("@/lib/report-build/browser");
        const r = await runPreview(browserRunDeps(files, caseId), caseId, (progress) => {
          if (!cancelled) setState({ status: "loading", progress });
        });
        if (cancelled) return;
        if (!r.ok) {
          setState({ status: "error", message: userMessage(r.failure) });
          return;
        }
        url = URL.createObjectURL(new Blob([r.pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
        setState({ status: "ready", url, size: r.pdf.length, warnings: r.warnings });
      } catch {
        if (!cancelled) setState({ status: "error", message: "The preview could not be made. Reload the page and try again." });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [files, caseId, run]);

  const again = () => {
    setState({ status: "loading", progress: { phase: "preparing" } });
    setRun((n) => n + 1);
  };

  if (state.status === "loading") {
    return (
      <div role="status" aria-live="polite" className="flex h-[60vh] items-center justify-center rounded border border-border bg-surface text-sm text-text-muted">
        <span>
          <span className="font-medium text-text">{progressText(state.progress)}</span> Building the PDF in this browser.
        </span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <InlineAlert tone="warning" title="No preview">
        <p>{state.message}</p>
        <Button variant="secondary" className="mt-2" onClick={again}>
          Try again
        </Button>
      </InlineAlert>
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          This is a draft of the current values ({(state.size / (1024 * 1024)).toFixed(1)} MB). Nothing has been saved; use Generate report to make a version.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={again}>
            Refresh
          </Button>
          <a href={state.url} download={previewFileName(caseRef)} className={buttonClass("secondary")}>
            Download PDF
          </a>
        </div>
      </div>
      {state.warnings.length > 0 && (
        <div className="mb-3">
          <InlineAlert tone="warning" title="Check before generating">
            <ul className="list-disc pl-5">
              {state.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </InlineAlert>
        </div>
      )}
      <iframe title={`Preview of the report for ${caseRef}`} src={state.url} className="h-[80vh] w-full rounded border border-border bg-white" />
    </>
  );
}
