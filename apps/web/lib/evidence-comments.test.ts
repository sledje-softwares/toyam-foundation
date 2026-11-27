import { describe, expect, it } from "vitest";
import { toFileComments, visibleComments } from "./evidence-comments";

const row = (id: string, at: string, body = "b", author: { full_name: string } | null = { full_name: "Ravi" }) => ({ id, body, created_at: at, author });

describe("toFileComments", () => {
  it("handles null and orders oldest first", () => {
    expect(toFileComments(null)).toEqual([]);
    const out = toFileComments([row("2", "2026-11-02T00:00:00Z"), row("1", "2026-11-01T00:00:00Z")]);
    expect(out.map((c) => c.id)).toEqual(["1", "2"]);
  });
  it("drops blank bodies, trims, falls back on author", () => {
    const out = toFileComments([row("1", "2026-11-01T00:00:00Z", "  "), row("2", "2026-11-01T00:00:00Z", " hi ", null)]);
    expect(out).toEqual([{ id: "2", body: "hi", createdAt: "2026-11-01T00:00:00Z", author: "Operator" }]);
  });
  it("accepts an array author", () => {
    expect(toFileComments([{ ...row("1", "2026-11-01T00:00:00Z"), author: [{ full_name: "Sita" }] }])[0].author).toBe("Sita");
  });
});

describe("visibleComments", () => {
  const all = toFileComments([1, 2, 3, 4, 5].map((n) => row(String(n), `2026-11-0${n}T00:00:00Z`)));
  it("collapses to the newest 3", () => {
    const v = visibleComments(all, false);
    expect(v.shown.map((c) => c.id)).toEqual(["3", "4", "5"]);
    expect(v.hidden).toBe(2);
  });
  it("shows all when expanded or short", () => {
    expect(visibleComments(all, true).shown).toHaveLength(5);
    expect(visibleComments(all.slice(0, 3), false).hidden).toBe(0);
  });
});
