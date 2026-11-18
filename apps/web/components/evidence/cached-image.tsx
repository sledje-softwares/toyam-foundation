"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fileHref, hasThumbnail } from "@/lib/evidence-view-core";
import { downloadPool, fetchBytes } from "@/lib/file-cache/browser";
import { chooseSource, errorState, type CachedFile, type ImageState } from "@/lib/file-cache/view-core";
import { useFileCache } from "@/components/file-cache/provider";

/**
 * An evidence image loaded once through the browser file cache: hit → shown with no network request; miss → a short
 * link (batched server action → evidence-view), fetch, SHA-256 check against the database's hash, stored, shown via an
 * object URL (revoked on unmount / change). A file that fails the check is never shown. Thumbnails load lazily.
 */
export function CachedImage({
  file,
  purpose,
  alt,
  placeholder,
  className = "size-full object-cover",
  lazy = true,
}: {
  file: CachedFile;
  purpose: "thumb" | "preview";
  alt: string;
  placeholder: React.ReactNode;
  className?: string;
  lazy?: boolean;
}) {
  const ctx = useFileCache();
  const source = chooseSource(file, purpose);
  const key = source ? `${file.evidenceId}:${source.variant}:${source.expectedSha256 ?? ""}` : null;
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(!lazy);
  const [result, setResult] = useState<{ key: string; state: ImageState } | null>(null);

  useEffect(() => {
    if (seen || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = setTimeout(() => setSeen(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen || !source || !key || !ctx) return;
    let cancelled = false;
    let url: string | null = null;
    ctx
      .cache()
      .fetchVerified({
        evidenceId: file.evidenceId,
        caseId: file.caseId,
        variant: source.variant,
        expectedSha256: source.expectedSha256,
        getLink: () => ctx.link(file.evidenceId, source.variant),
        fetchBytes: (u) => downloadPool(() => fetchBytes(u)),
      })
      .then((r) => {
        if (cancelled) return;
        // Only image types go into the object URL; anything else is opaque bytes to the <img>.
        url = URL.createObjectURL(new Blob([r.bytes], { type: hasThumbnail(r.mime) ? r.mime : "application/octet-stream" }));
        setResult({ key, state: { status: "ready", url, fromCache: r.fromCache } });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ key, state: errorState(e) });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `source` is derived from `key` and `file`; `key` changes whenever the bytes asked for change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, key, ctx, file.evidenceId, file.caseId]);

  const state: ImageState = !source || !ctx ? { status: "idle" } : result?.key === key ? result.state : seen ? { status: "loading" } : { status: "idle" };
  return (
    <span ref={ref} className="flex size-full items-center justify-center" aria-busy={state.status === "loading" || undefined}>
      {state.status === "ready" ? (
        // Object URL of verified bytes; next/image cannot take blob: URLs.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.url} alt={alt} className={className} />
      ) : state.status === "error" && state.kind === "integrity" ? (
        <span role="img" aria-label={`${alt}: ${state.message}`} title={state.message} className="px-1 text-center text-[10px] font-semibold uppercase leading-tight text-danger">
          Integrity check failed
        </span>
      ) : state.status === "error" && purpose === "preview" ? (
        <span role="alert" className="p-4 text-center text-sm text-slate-200">
          {state.message}
        </span>
      ) : (
        <span title={state.status === "error" ? state.message : undefined} className="contents">
          {placeholder}
        </span>
      )}
    </span>
  );
}

/**
 * "Preview": the 1600 px copy (or an inline-safe original) in a dialog, from the cache. The original stays one click
 * away through the same-origin /files/... redirect (fresh short link each time).
 */
export function PreviewButton({ file, name }: { file: CachedFile; name: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  if (!chooseSource(file, "preview")) return null;
  return (
    <>
      <button
        type="button"
        className="min-h-8 text-xs text-primary underline hover:no-underline"
        onClick={() => {
          setOpen(true);
          ref.current?.showModal();
        }}
      >
        Preview<span className="sr-only"> {name}</span>
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        className="m-auto w-full max-w-5xl rounded-lg border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <h2 id={titleId} className="truncate text-sm font-semibold" title={name}>
            {name}
          </h2>
          <span className="flex shrink-0 items-center gap-3 text-xs">
            <a href={fileHref("evidence", file.evidenceId)} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:no-underline">
              Open original
            </a>
            <a href={fileHref("evidence", file.evidenceId, { download: true })} className="text-primary underline hover:no-underline">
              Download original
            </a>
            <button type="button" className="min-h-8 rounded border border-border-input px-3" onClick={() => ref.current?.close()}>
              Close
            </button>
          </span>
        </div>
        <div className="flex min-h-64 items-center justify-center bg-slate-900 p-2">
          {open && (
            <CachedImage
              file={file}
              purpose="preview"
              alt={name}
              lazy={false}
              className="max-h-[80vh] max-w-full object-contain"
              placeholder={<span className="text-sm text-slate-300">Loading…</span>}
            />
          )}
        </div>
      </dialog>
    </>
  );
}
