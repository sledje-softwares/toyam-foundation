"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Responsive frame for the staff app.
 * lg and up: a fixed sidebar that scrolls on its own. Below lg: a sticky top bar with a menu button
 * that opens the same sidebar as a drawer (closes on navigation, Escape, or a tap outside).
 * `sidebar` is server-rendered and passed in, so nav data never moves to the client.
 */
export function AppShell({
  brand,
  sidebar,
  children,
}: {
  brand: React.ReactNode;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);

  // Close the drawer after each navigation.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Keep the page behind the drawer still.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <div className="min-h-screen lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to main content
      </a>

      {/* Top bar, below lg only. */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-2 backdrop-blur lg:hidden">
        <button
          ref={menuButton}
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="app-sidebar"
          onClick={() => setOpen(true)}
          className="inline-flex h-10 w-10 items-center justify-center rounded text-text hover:bg-slate-100"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="min-w-0 truncate">{brand}</div>
      </header>

      {/* Backdrop for the drawer. */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-slate-900/50 transition-opacity lg:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />

      <div
        id="app-sidebar"
        ref={drawer}
        className={`fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-border bg-surface shadow-xl transition-[translate,visibility] duration-200 lg:static lg:z-auto lg:w-60 lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:shadow-none ${
          // Closed below lg: off screen and `invisible`, so it leaves the tab order and the accessibility tree.
          open ? "translate-x-0" : "-translate-x-full max-lg:invisible"
        }`}
      >
        {/* Inner box: viewport-tall and sticky at lg; the outer column stretches so its background and border span long pages. */}
        <div className="flex h-full flex-col lg:sticky lg:top-0 lg:h-screen">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 lg:h-auto lg:border-b-0 lg:pt-5">
            <div className="min-w-0">{brand}</div>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => {
                setOpen(false);
                menuButton.current?.focus();
              }}
              className="inline-flex h-10 w-10 items-center justify-center rounded text-text-muted hover:bg-slate-100 lg:hidden"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
            {sidebar}
          </div>
        </div>
      </div>

      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full min-w-0 max-w-screen-2xl flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:p-8"
      >
        {children}
      </main>
    </div>
  );
}
