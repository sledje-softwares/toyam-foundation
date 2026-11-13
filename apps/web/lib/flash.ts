/** Flash messages: set by server actions, shown once by <Toaster /> after the next navigation. */
export type FlashKind = "success" | "error" | "info";
export type Flash = { kind: FlashKind; message: string };

export const FLASH_COOKIE = "flash";

export function encodeFlash(flash: Flash): string {
  return encodeURIComponent(JSON.stringify(flash));
}

export function decodeFlash(raw: string | null | undefined): Flash | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<Flash>;
    if (typeof v.message !== "string" || !v.message) return null;
    const kind: FlashKind = v.kind === "error" || v.kind === "info" ? v.kind : "success";
    return { kind, message: v.message.slice(0, 300) };
  } catch {
    return null;
  }
}

export function readFlashFromCookieString(cookie: string): Flash | null {
  const m = new RegExp(`(?:^|;\\s*)${FLASH_COOKIE}=([^;]*)`).exec(cookie);
  return m ? decodeFlash(m[1]) : null;
}
