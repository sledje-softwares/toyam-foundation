"use client";

import { useEffect } from "react";

const MESSAGE = "Discard unsaved changes?";

/**
 * While `when` is true: warns on reload / tab close (beforeunload) and asks before following an in-app link.
 * Programmatic navigation (router.push after a save) is not intercepted.
 */
export function useUnsavedChangesGuard(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.hasAttribute("download")) return;
      if (a.origin !== window.location.origin) return;
      if (!window.confirm(MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [when]);
}
