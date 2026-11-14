"use client";

import { ErrorState } from "@/components/ui";

export default function TasksError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Tasks" reset={reset} />;
}
