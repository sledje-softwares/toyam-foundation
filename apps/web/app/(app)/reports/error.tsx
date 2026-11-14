"use client";

import { ErrorState } from "@/components/ui";

export default function ReportsError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Reports" reset={reset} />;
}
