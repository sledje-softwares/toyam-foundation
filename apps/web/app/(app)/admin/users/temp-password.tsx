"use client";

import { useState } from "react";
import { Button, InlineAlert } from "@/components/ui";

/** Shows a temporary password. It lives only in the caller's React state: not in the URL, a cookie or a log. */
export function TempPassword({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-text-muted">Temporary password</span>
        <code className="rounded bg-slate-100 px-3 py-1 font-mono text-lg" data-testid="temp-password">
          {password}
        </code>
        <Button variant="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <span role="status" className="sr-only">
          {copied ? "Password copied" : ""}
        </span>
      </div>
      <InlineAlert tone="warning">
        Share this by phone or in person. It will not be shown again. Ask them to change it after signing in.
      </InlineAlert>
    </div>
  );
}
