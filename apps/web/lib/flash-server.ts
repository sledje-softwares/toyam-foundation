import { cookies } from "next/headers";
import { encodeFlash, FLASH_COOKIE, type FlashKind } from "@/lib/flash";

/** Call from a server action before redirect(); the Toaster shows it once and clears it. */
export async function setFlash(message: string, kind: FlashKind = "success") {
  const store = await cookies();
  store.set(FLASH_COOKIE, encodeFlash({ kind, message }), {
    path: "/",
    maxAge: 30,
    sameSite: "lax",
    httpOnly: false, // read by the Toaster in the browser
  });
}
