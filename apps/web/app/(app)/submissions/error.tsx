"use client";

import { ErrorState } from "@/components/ui";

export default function SubmissionsError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Submissions" reset={reset} />;
}
