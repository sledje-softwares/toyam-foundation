import { describe, expect, it } from "vitest";
import { applyListParams, buildHref, escapeSearchTerm, nextSort, pageCount, parseListParams, rangeLabel, type ListConfig } from "./list-params";

const cfg: ListConfig = {
  sortable: ["name", "created_at"],
  defaultSort: { key: "created_at", dir: "desc" },
  filters: ["role", "status"],
  filterColumns: { status: "state" },
  searchColumns: ["name", "phone"],
};

describe("parseListParams", () => {
  it("uses defaults", () => {
    const p = parseListParams({}, cfg);
    expect(p).toMatchObject({ page: 1, pageSize: 50, from: 0, to: 49, sort: "created_at", dir: "desc", q: "", filters: {} });
  });
  it("parses page, sort, filters; ignores unknown sort and 'all'", () => {
    const p = parseListParams({ page: "3", sort: "name", dir: "asc", role: "admin", status: "all", q: " ab " }, cfg);
    expect(p).toMatchObject({ page: 3, from: 100, to: 149, sort: "name", dir: "asc", q: "ab", filters: { role: "admin" } });
    expect(parseListParams({ sort: "password", dir: "asc" }, cfg)).toMatchObject({ sort: "created_at", dir: "desc" });
  });
  it("rejects bad page numbers and takes the first of repeated params", () => {
    expect(parseListParams({ page: "-2" }, cfg).page).toBe(1);
    expect(parseListParams({ page: "abc" }, cfg).page).toBe(1);
    expect(parseListParams({ role: ["office", "admin"] }, cfg).filters.role).toBe("office");
  });
});

describe("escapeSearchTerm", () => {
  it("removes filter-grammar and LIKE characters", () => {
    expect(escapeSearchTerm('a,b(c)*d%e_f"g')).toBe("a b c d e f g");
  });
});

describe("applyListParams", () => {
  it("chains eq, or, order and range", () => {
    const calls: string[] = [];
    const qb = {
      eq: (c: string, v: string) => (calls.push(`eq ${c}=${v}`), qb),
      or: (f: string) => (calls.push(`or ${f}`), qb),
      order: (c: string, o?: { ascending?: boolean }) => (calls.push(`order ${c} ${o?.ascending ? "asc" : "desc"}`), qb),
      range: (a: number, b: number) => (calls.push(`range ${a}-${b}`), qb),
    };
    applyListParams(qb, parseListParams({ status: "open", q: "ram", page: "2", sort: "name", dir: "asc" }, cfg), cfg);
    expect(calls).toEqual(["eq state=open", "or name.ilike.*ram*,phone.ilike.*ram*", "order name asc", "order id asc", "range 50-99"]);
  });
  it("skips search when the term is empty after escaping", () => {
    const calls: string[] = [];
    const qb = { eq: () => qb, or: () => (calls.push("or"), qb), order: () => qb, range: () => qb };
    applyListParams(qb, parseListParams({ q: "%%" }, cfg), cfg);
    expect(calls).toEqual([]);
  });
});

describe("buildHref", () => {
  it("sets, removes and resets page", () => {
    expect(buildHref("/x", { role: "admin", page: "3" }, { status: "open" })).toBe("/x?role=admin&status=open");
    expect(buildHref("/x", { role: "admin", page: "3" }, { page: 4 })).toBe("/x?role=admin&page=4");
    expect(buildHref("/x", { role: "admin" }, { role: null })).toBe("/x");
    expect(buildHref("/x", {}, { page: 1 })).toBe("/x");
  });
});

describe("misc", () => {
  it("nextSort toggles", () => {
    expect(nextSort({ sort: "a", dir: "asc" }, "b")).toEqual({ sort: "b", dir: "asc" });
    expect(nextSort({ sort: "a", dir: "asc" }, "a")).toEqual({ sort: "a", dir: "desc" });
  });
  it("rangeLabel and pageCount", () => {
    expect(rangeLabel(1, 50, 312)).toBe("1–50 of 312");
    expect(rangeLabel(7, 50, 312)).toBe("301–312 of 312");
    expect(rangeLabel(1, 50, 0)).toBe("0 results");
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
  });
});
