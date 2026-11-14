"use client";

import { Button } from "./button";

/** Use as the body of a route segment's error.tsx: <ErrorState what="Users" reset={reset} />. */
export function ErrorState({ what, reset }: { what: string; reset?: () => void }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-danger-soft px-6 py-8 text-center">
      <p className="font-medium text-danger">{what} could not be loaded.</p>
      <p className="mt-1 text-sm text-text-muted">Check your connection and try again.</p>
      {reset && (
        <div className="mt-4">
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
