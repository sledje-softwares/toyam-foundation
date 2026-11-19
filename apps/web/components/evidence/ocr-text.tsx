"use client";

import { useId, useState } from "react";
import type { OcrDisplay } from "@/lib/ocr-display";

/**
 * Gap 35: the short description of a file (made on the field phone from the operator's tag and the text of
 * the 1600 px copy) and, on demand, the full OCR text with a copy button. Staff only: the rows come from an
 * RLS read that field users cannot make.
 */
export function OcrText({ ocr, compact = false }: { ocr: OcrDisplay; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  async function copy() {
    if (!ocr.text) return;
    try {
      await navigator.clipboard.writeText(ocr.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="min-w-0 space-y-1 text-xs">
      {ocr.summary && (
        <p className={`${compact ? "line-clamp-2" : ""} text-text-muted`} title={ocr.summary}>
          {ocr.summary}
        </p>
      )}
      {ocr.text && (
        <>
          <span className="flex flex-wrap items-center gap-x-3">
            <button type="button" className="text-primary underline hover:no-underline" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
              {open ? "Hide text" : "Show text"}
            </button>
            {open && (
              <button type="button" className="text-primary underline hover:no-underline" onClick={copy}>
                {copied ? "Copied" : "Copy text"}
              </button>
            )}
            <span className="text-text-muted">
              Read by {ocr.engine ?? "OCR"}
              {ocr.confidence !== null ? ` · ${Math.round(ocr.confidence * 100)}%` : ""}
            </span>
            <span role="status" className="sr-only">
              {copied ? "Text copied" : ""}
            </span>
          </span>
          {open && (
            <pre id={id} className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-100 p-2 font-mono text-xs text-text">
              {ocr.text}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
