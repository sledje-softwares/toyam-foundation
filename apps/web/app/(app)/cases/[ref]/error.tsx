"use client";

import { ErrorState } from "@/components/ui";

export default function CaseError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="This case" reset={reset} />;
}
