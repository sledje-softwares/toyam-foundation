"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole, STAFF_ROLES } from "@/lib/auth";
import { setFlash } from "@/lib/flash-server";
import { createClient } from "@/lib/supabase/server";
import { mapDbError } from "@/lib/validation/db-errors";

const RetryInput = z.object({ email_id: z.guid() });

/** Queues a failed email for reprocessing: public.request_intake_retry(p_email_id uuid) (D39). */
export async function requestRetry(formData: FormData): Promise<void> {
  await requireRole(STAFF_ROLES);
  const parsed = RetryInput.safeParse({ email_id: String(formData.get("email_id") ?? "") });
  if (!parsed.success) {
    await setFlash("Not queued. Reload the page and try again.", "error");
    return;
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_intake_retry", { p_email_id: parsed.data.email_id });
  if (error) {
    await setFlash(mapDbError(error).message, "error");
  } else {
    await setFlash("Retry queued; it runs within 10 minutes");
  }
  revalidatePath("/intake", "layout");
}
