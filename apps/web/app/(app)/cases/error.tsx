"use client";

import { ErrorState } from "@/components/ui";

export default function CasesError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Cases" reset={reset} />;
}
