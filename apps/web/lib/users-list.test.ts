import { describe, expect, it } from "vitest";
import { contactLines, filterUsers, matchesSearch, parseStatus, sortUsers, type UserRow } from "./users-list";

const u = (o: Partial<UserRow>): UserRow => ({
  id: o.full_name ?? "x", full_name: "A", role: "office", region: null, is_active: true,
  email: null, phone: null, last_sign_in_at: null, open_tasks: 0, ...o,
});
const rows = [
  u({ full_name: "Farid Khan", role: "field", region: "Pune", phone: "+919800000001", last_sign_in_at: "2026-11-02T10:00:00Z" }),
  u({ full_name: "Asha Rao", role: "admin", email: "asha@firm.in", last_sign_in_at: "2026-11-14T10:00:00Z" }),
  u({ full_name: "Vijay More", role: "field", region: "Nashik", phone: "+919800000007", is_active: false }),
];

describe("users list", () => {
  it("defaults status to active", () => {
    expect(parseStatus(undefined)).toBe("active");
    expect(parseStatus("bogus")).toBe("active");
    expect(parseStatus("all")).toBe("all");
    expect(parseStatus(["inactive"])).toBe("inactive");
  });
  it("hides inactive by default and filters by role/region", () => {
    const base = { q: "", role: null, status: "active" as const, region: null };
    expect(filterUsers(rows, base).map((r) => r.full_name)).toEqual(["Farid Khan", "Asha Rao"]);
    expect(filterUsers(rows, { ...base, status: "all" })).toHaveLength(3);
    expect(filterUsers(rows, { ...base, status: "inactive" })[0].full_name).toBe("Vijay More");
    expect(filterUsers(rows, { ...base, role: "field", region: "Pune" })).toHaveLength(1);
  });
  it("searches name, email and mobile with or without spaces", () => {
    expect(matchesSearch(rows[0], "farid")).toBe(true);
    expect(matchesSearch(rows[1], "ASHA@")).toBe(true);
    expect(matchesSearch(rows[0], "98000 00001")).toBe(true);
    expect(matchesSearch(rows[0], "+91 98000 00001")).toBe(true);
    expect(matchesSearch(rows[0], "9800000002")).toBe(false);
  });
  it("sorts with nulls last in both directions", () => {
    expect(sortUsers(rows, "region", "asc").map((r) => r.region)).toEqual(["Nashik", "Pune", null]);
    expect(sortUsers(rows, "region", "desc").map((r) => r.region)).toEqual(["Pune", "Nashik", null]);
    expect(sortUsers(rows, "last_sign_in", "desc")[0].full_name).toBe("Asha Rao");
    expect(sortUsers(rows, "name", "asc")[0].full_name).toBe("Asha Rao");
  });
  it("puts mobile first for field operators", () => {
    expect(contactLines(u({ role: "field", email: "e@x.in", phone: "+91 1" })).map((c) => c.kind)).toEqual(["phone", "email"]);
    expect(contactLines(u({ role: "office", email: "e@x.in", phone: "+91 1" })).map((c) => c.kind)).toEqual(["email", "phone"]);
  });
});
