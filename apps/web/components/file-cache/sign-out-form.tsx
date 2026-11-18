"use client";

import { useEffect } from "react";
import { signOut } from "@/app/login/actions";
import { wipeBrowserFileCache } from "@/lib/file-cache/browser";

/** Sign out: wipes the browser file cache first (bounded wait, never blocks sign-out), then the server action. */
export function SignOutForm({ className }: { className?: string }) {
  return (
    <form
      className={className}
      action={async () => {
        await wipeBrowserFileCache();
        await signOut();
      }}
    >
      <button type="submit" className="text-blue-800 underline hover:no-underline">
        Sign out
      </button>
    </form>
  );
}

/** Backstop on the login page: whatever happened before (expired session, closed tab), no files stay behind. */
export function WipeFileCacheOnMount() {
  useEffect(() => {
    void wipeBrowserFileCache();
  }, []);
  return null;
}
