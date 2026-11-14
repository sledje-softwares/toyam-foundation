"use client";

import { ErrorState } from "@/components/ui";

export default function ReportWorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="This report" reset={reset} />;
}
