import type { SortDir } from "./list-params";

export type InsurerRow = {
  id: string;
  name: string;
  code: string;
  sender_domains: string[];
  tat_days: number;
  submission_channel: string;
  has_template: boolean;
  is_active: boolean;
};
export const INSURER_SORT_KEYS = ["name", "code", "tat", "submission"] as const;
export type InsurerStatus = "active" | "inactive" | "all";

export function parseInsurerStatus(raw: string | string[] | undefined): InsurerStatus {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v === "inactive" || v === "all" ? v : "active";
}

export function filterInsurers(rows: InsurerRow[], f: { q: string; status: InsurerStatus; channel: string | null }): InsurerRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === "all" || (f.status === "active") === r.is_active) &&
      (!f.channel || r.submission_channel === f.channel) &&
      (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) || r.sender_domains.some((d) => d.includes(q))),
  );
}

export function sortInsurers(rows: InsurerRow[], key: string, dir: SortDir): InsurerRow[] {
  const val = (r: InsurerRow): string | number =>
    key === "code" ? r.code : key === "tat" ? r.tat_days : key === "submission" ? r.submission_channel : r.name.toLowerCase();
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sign;
  });
}
