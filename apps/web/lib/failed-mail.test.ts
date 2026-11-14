import { describe, expect, it } from "vitest";
import { failureReason, truncateError } from "./failed-mail";

describe("failureReason", () => {
  it("detects parser errors", () => expect(failureReason("parser: boom")).toBe("parser"));
  it("treats everything else as decode", () => {
    expect(failureReason("bad MIME")).toBe("decode");
    expect(failureReason(null)).toBe("decode");
  });
});

describe("truncateError", () => {
  it("returns a dash for empty", () => expect(truncateError("  ")).toBe("—"));
  it("keeps short text and collapses whitespace", () => expect(truncateError("a\n  b")).toBe("a b"));
  it("cuts long text with an ellipsis", () => {
    const out = truncateError("x".repeat(200), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
});
