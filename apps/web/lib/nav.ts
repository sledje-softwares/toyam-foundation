import type { Enums } from "@/lib/database.types";

type UserRole = Enums<"user_role">;

export type NavBadge = "intake" | "reports" | "failedMail";

export type NavItem = {
  href: string;
  label: string;
  milestone: string;
  roles: UserRole[];
  group?: "Admin";
  /** Count shown next to the label; the layout supplies the numbers (see NavLinks `badges`). */
  badge?: NavBadge;
  /** Badge colour; defaults to the primary colour. */
  badgeTone?: "danger";
};

const ALL: UserRole[] = ["admin", "orchestrator", "office"];

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", milestone: "M8", roles: ALL },
  { href: "/intake", label: "Intake", milestone: "M3", roles: ["admin", "orchestrator", "office"], badge: "intake" },
  { href: "/intake/failed", label: "Failed mail", milestone: "M3", roles: ["admin", "orchestrator", "office"], badge: "failedMail", badgeTone: "danger" },
  { href: "/cases", label: "Cases", milestone: "M4", roles: ALL },
  { href: "/tasks", label: "Tasks", milestone: "M4", roles: ALL },
  { href: "/reports", label: "Reports", milestone: "M7", roles: ["admin", "office", "orchestrator"], badge: "reports" },
  { href: "/submissions", label: "Submissions", milestone: "M8", roles: ALL },
  { href: "/admin/users", label: "Users", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/admin/insurers", label: "Insurers", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/admin/checklists", label: "Checklists", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/admin/audit-log", label: "Audit log", milestone: "M9", roles: ["admin"], group: "Admin" },
];

export function findNavItem(href: string) {
  return NAV_ITEMS.find((i) => i.href === href);
}
