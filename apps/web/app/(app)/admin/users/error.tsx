"use client";

import { ErrorState } from "@/components/ui";

export default function UsersError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState what="Users" reset={reset} />;
}
