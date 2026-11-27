import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatPhone, formatRelativeDay, ROLE_LABELS } from "@/lib/format";
import { parseListParams, type ListConfig, type SearchParams } from "@/lib/list-params";
import { contactLines, filterUsers, parseStatus, sortUsers, USER_ROLES, USER_SORT_KEYS, type UserRow } from "@/lib/users-list";
import { Badge, ButtonLink, DataTable, EmptyState, ErrorState, FilterBar, PageHeader, type Column } from "@/components/ui";

export const metadata = { title: "Users" };

const BASE = "/admin/users";
const LIST: ListConfig = {
  sortable: [...USER_SORT_KEYS],
  defaultSort: { key: "name", dir: "asc" },
  filters: ["role", "region"],
  pageSize: 1000, // fewer than ~100 users: no pagination
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireRole(["admin"]);
  const sp = await searchParams;
  const list = parseListParams(sp, LIST);
  const status = parseStatus(sp.status);
  const role = (USER_ROLES as readonly string[]).includes(list.filters.role) ? list.filters.role : null;

  const supabase = await createClient();
  // admin_list_users(p_user_id?: uuid) returns profile + sign-in details but no task counts; those come from tasks.
  const [users, tasks] = await Promise.all([
    supabase.rpc("admin_list_users"),
    supabase.from("tasks").select("assignee_id").in("status", ["pending", "in_progress"]).not("assignee_id", "is", null).limit(5000),
  ]);

  if (users.error) {
    return (
      <>
        <PageHeader title="Users" breadcrumbs={[{ label: "Admin" }, { label: "Users" }]} />
        <ErrorState what="Users" />
      </>
    );
  }

  const open = new Map<string, number>();
  for (const t of tasks.data ?? []) if (t.assignee_id) open.set(t.assignee_id, (open.get(t.assignee_id) ?? 0) + 1);
  const all: UserRow[] = (users.data ?? []).map((r) => ({
    id: r.id,
    full_name: r.full_name,
    role: r.role,
    region: r.region,
    is_active: r.is_active,
    email: r.email,
    phone: r.phone,
    last_sign_in_at: r.last_sign_in_at,
    open_tasks: open.get(r.id) ?? 0,
  }));

  const regions = [...new Set(all.map((r) => r.region).filter((x): x is string => Boolean(x)))].sort();
  const region = list.filters.region && regions.includes(list.filters.region) ? list.filters.region : null;
  const rows = sortUsers(filterUsers(all, { q: list.q, role, status, region }), list.sort, list.dir);
  const filtered = Boolean(list.q || role || region || status !== "active");
  const onlyMe = all.every((r) => r.id === me.id);

  const columns: Column<UserRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.full_name}
          {!r.is_active && <Badge tone="neutral">Inactive</Badge>}
        </span>
      ),
    },
    { key: "role", header: "Role", sortable: true, cell: (r) => ROLE_LABELS[r.role] },
    { key: "region", header: "Region", sortable: true, cell: (r) => r.region || "—" },
    {
      key: "contact",
      mobile: "wide",
      header: "Email / Mobile",
      cell: (r) => {
        const lines = contactLines(r);
        if (!lines.length) return "—";
        return (
          <span className="block">
            {lines.map((l) => (
              <span key={l.kind} className="block">
                {l.kind === "phone" ? formatPhone(l.value) : l.value}
              </span>
            ))}
          </span>
        );
      },
    },
    { key: "open_tasks", header: "Open tasks", align: "right", cell: (r) => (r.role === "field" || r.open_tasks ? r.open_tasks : "—") },
    { key: "last_sign_in", header: "Last sign-in", sortable: true, cell: (r) => formatRelativeDay(r.last_sign_in_at) },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        breadcrumbs={[{ label: "Admin" }, { label: "Users" }]}
        actions={<ButtonLink href="/admin/users/new">Add user</ButtonLink>}
      />
      <Suspense>
        <FilterBar
          searchLabel="Search name, email or mobile"
          total={rows.length}
          filters={[
            { name: "role", label: "Role", options: USER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
            {
              name: "status",
              label: "Status",
              allLabel: "Active",
              options: [
                { value: "inactive", label: "Inactive" },
                { value: "all", label: "All" },
              ],
            },
            { name: "region", label: "Region", options: regions.map((r) => ({ value: r, label: r })) },
          ]}
        />
      </Suspense>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `${BASE}/${r.id}`}
        basePath={BASE}
        searchParams={sp}
        list={list}
        caption="Users"
        empty={
          <EmptyState
            filtered={filtered && !onlyMe}
            title={onlyMe ? "Only you have access so far." : "No users match these filters."}
            action={{ label: "Add user", href: "/admin/users/new" }}
          />
        }
      />
    </>
  );
}
