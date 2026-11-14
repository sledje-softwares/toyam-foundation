import type { Enums } from "@/lib/database.types";

type UserRole = Enums<"user_role">;

export type NavItem = {
  href: string;
  label: string;
  milestone: string;
  roles: UserRole[];
  group?: "Admin";
};

const ALL: UserRole[] = ["admin", "orchestrator", "office"];

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", milestone: "M8", roles: ALL },
  { href: "/intake", label: "Intake", milestone: "M3", roles: ["orchestrator", "office"] },
  { href: "/cases", label: "Cases", milestone: "M4", roles: ALL },
  { href: "/reports", label: "Reports", milestone: "M6", roles: ["office", "orchestrator"] },
  { href: "/submissions", label: "Submissions", milestone: "M7", roles: ["orchestrator"] },
  { href: "/admin/users", label: "Users", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/admin/insurers", label: "Insurers", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/admin/checklists", label: "Checklists", milestone: "M2", roles: ["admin"], group: "Admin" },
  { href: "/audit-log", label: "Audit log", milestone: "M9", roles: ["admin"] },
];

export function findNavItem(href: string) {
  return NAV_ITEMS.find((i) => i.href === href);
}
