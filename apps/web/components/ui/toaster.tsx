"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FLASH_COOKIE, readFlashFromCookieString, type Flash } from "@/lib/flash";

type Item = Flash & { id: number };
let counter = 0;

/** Client-side toast: toast("Saved") / toast("Could not save", "error"). */
export function toast(message: string, kind: Flash["kind"] = "success") {
  window.dispatchEvent(new CustomEvent<Flash>("app:toast", { detail: { kind, message } }));
}

const STYLES: Record<Flash["kind"], string> = {
  success: "border-green-300 bg-success-soft text-success",
  info: "border-blue-300 bg-primary-soft text-blue-900",
  error: "border-red-300 bg-danger-soft text-danger",
};

/** Mount once in the app layout. Shows server-action flash cookies after redirects, plus toast() calls. */
export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  const pathname = usePathname();

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((i) => i.id !== id)), []);
  const add = useCallback(
    (f: Flash) => {
      const id = ++counter;
      setItems((l) => [...l, { ...f, id }]);
      if (f.kind !== "error") setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );

  useEffect(() => {
    const onToast = (e: Event) => add((e as CustomEvent<Flash>).detail);
    window.addEventListener("app:toast", onToast);
    return () => window.removeEventListener("app:toast", onToast);
  }, [add]);

  // Read (and clear) the flash cookie on first load and after each navigation.
  useEffect(() => {
    const flash = readFlashFromCookieString(document.cookie);
    if (flash) {
      document.cookie = `${FLASH_COOKIE}=; path=/; max-age=0`;
      const t = setTimeout(() => add(flash), 0);
      return () => clearTimeout(t);
    }
  }, [pathname, add]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:left-auto sm:w-80">
      {items.map((i) => (
        <div key={i.id} role={i.kind === "error" ? "alert" : "status"} className={`pointer-events-auto flex items-start gap-3 rounded border px-4 py-3 text-sm shadow ${STYLES[i.kind]}`}>
          <p className="flex-1">{i.message}</p>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(i.id)} className="min-h-8 min-w-8 text-lg leading-none">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
