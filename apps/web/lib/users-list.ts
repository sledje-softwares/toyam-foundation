/** Pure helpers for the users list (/admin/users): filter, search and sort rows in memory (fewer than ~100 users). */
import { normalizeIndianMobile } from "./format";
import type { SortDir } from "./list-params";

export type UserRow = {
  id: string;
  full_name: string;
  role: "admin" | "orchestrator" | "office" | "field";
  region: string | null;
  is_active: boolean;
  email: string | null;
  phone: string | null;
  last_sign_in_at: string | null;
  open_tasks: number;
};

export const USER_SORT_KEYS = ["name", "role", "region", "last_sign_in"] as const;
export const USER_ROLES = ["admin", "orchestrator", "office", "field"] as const;
export type StatusFilter = "active" | "inactive" | "all";

/** Status filter from the URL: Active is the default. */
export function parseStatus(raw: string | string[] | undefined): StatusFilter {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v === "inactive" || v === "all" ? v : "active";
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Case-insensitive match on name and email; digits-only match on mobile, with or without spaces or +91. */
export function matchesSearch(u: Pick<UserRow, "full_name" | "email" | "phone">, q: string): boolean {
  const term = q.trim().toLowerCase();
  if (!term) return true;
  if (u.full_name.toLowerCase().includes(term) || (u.email ?? "").toLowerCase().includes(term)) return true;
  const d = digits(term);
  if (d.length >= 3 && u.phone) {
    const phone = digits(u.phone);
    const n = normalizeIndianMobile(term);
    return phone.includes(d) || (n !== null && phone.endsWith(n));
  }
  return false;
}

export function filterUsers(
  rows: UserRow[],
  f: { q: string; role: string | null; status: StatusFilter; region: string | null },
): UserRow[] {
  return rows.filter(
    (u) =>
      (f.status === "all" || (f.status === "active") === u.is_active) &&
      (!f.role || u.role === f.role) &&
      (!f.region || u.region === f.region) &&
      matchesSearch(u, f.q),
  );
}

/** Nulls (no region, never signed in) always sort last, whatever the direction. Name is the tiebreaker. */
export function sortUsers(rows: UserRow[], sort: string, dir: SortDir): UserRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: UserRow, b: UserRow) => a.full_name.localeCompare(b.full_name);
  const key = (u: UserRow): string | null =>
    sort === "role" ? u.role : sort === "region" ? u.region : sort === "last_sign_in" ? u.last_sign_in_at : u.full_name;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) return byName(a, b);
    if (ka === null) return 1;
    if (kb === null) return -1;
    const c = sort === "last_sign_in" ? Date.parse(ka) - Date.parse(kb) : ka.localeCompare(kb);
    return c !== 0 ? sign * c : byName(a, b);
  });
}

/** Field operators show mobile first; staff show email first. */
export function contactLines(u: Pick<UserRow, "role" | "email" | "phone">): { kind: "email" | "phone"; value: string }[] {
  const email = u.email ? { kind: "email" as const, value: u.email } : null;
  const phone = u.phone ? { kind: "phone" as const, value: u.phone } : null;
  return (u.role === "field" ? [phone, email] : [email, phone]).filter((x) => x !== null);
}
