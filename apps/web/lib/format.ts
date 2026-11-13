import type { UserRole } from "@/lib/database.types";

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  orchestrator: "Orchestrator",
  office: "Office staff",
  field: "Field operator",
};

const TZ = "Asia/Kolkata";

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: get("day"),
    month: get("month").replace(".", ""),
    year: get("year"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

const EMPTY = "—";

/** "12 Nov 2026" in IST. */
export function formatDate(v: DateInput): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  const p = istParts(d);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "12 Nov 2026, 14:05" in IST. */
export function formatDateTime(v: DateInput): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  const p = istParts(d);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

function istDayKey(d: Date): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .split("-")
    .map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]) / 86_400_000;
}

/** "Today 14:05", "Yesterday", "2 Nov" (same year) or "2 Nov 2025" (other year). IST. */
export function formatRelativeDay(v: DateInput, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  const diff = istDayKey(now) - istDayKey(d);
  const p = istParts(d);
  if (diff === 0) return `Today ${p.hour}:${p.minute}`;
  if (diff === 1) return "Yesterday";
  const nowYear = istParts(now).year;
  return p.year === nowYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

/** "₹1,85,000" (Indian digit grouping, no decimals unless the value has paise). */
export function formatINR(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return EMPTY;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return EMPTY;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .format(n)
    .replace(/ /g, "");
}

/**
 * Reduces user input to a bare 10-digit Indian mobile number, or null if it is not one.
 * Accepts spaces/dashes, a leading 0, +91 or 91.
 */
export function normalizeIndianMobile(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** "+91 98000 00001" for any recognisable Indian mobile (also E.164 or bare digits); other input returned as is. */
export function formatPhone(v: string | null | undefined): string {
  if (!v) return EMPTY;
  const n = normalizeIndianMobile(v);
  if (!n) return v;
  return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
}

/** E.164 form "+919800000001", or null. */
export function toE164(input: string | null | undefined): string | null {
  const n = normalizeIndianMobile(input);
  return n ? `+91${n}` : null;
}
