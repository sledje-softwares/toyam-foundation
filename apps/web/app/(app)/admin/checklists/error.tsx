"use client";

import { ErrorState } from "@/components/ui";

export default function ChecklistsError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Checklists" reset={reset} />;
}
