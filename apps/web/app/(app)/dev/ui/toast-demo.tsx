"use client";

import { Button, toast } from "@/components/ui";

export function ToastDemo() {
  return (
    <>
      <Button variant="secondary" onClick={() => toast("User saved.")}>Success toast</Button>
      <Button variant="secondary" onClick={() => toast("Could not save. Try again.", "error")}>Error toast</Button>
    </>
  );
}
