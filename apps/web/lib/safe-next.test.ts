import { describe, expect, it } from "vitest";
import { loginPathFor, safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each([
    ["/reports/INV-2026-000008", "/reports/INV-2026-000008"],
    ["/cases?status=open&page=2", "/cases?status=open&page=2"],
    ["/tasks/new?case=INV-2026-000008&kind=reinvestigation", "/tasks/new?case=INV-2026-000008&kind=reinvestigation"],
    ["/cases/INV-1#thread", "/cases/INV-1#thread"],
    ["/cases?q=a%20b", "/cases?q=a%20b"],
    ["/dashboard", "/dashboard"],
    ["/loginx", "/loginx"],
    ["/a/../cases", "/cases"],
  ])("accepts %s", (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    // protocol-relative and backslash variants
    "//evil.com",
    "//evil.com/path",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/cases\\..\\evil",
    // percent-encoded variants
    "/%2F%2Fevil.com",
    "/%2f/evil.com",
    "/%5Cevil.com",
    "/%5cevil.com",
    "/%252F%252Fevil.com",
    "/%E0%A4%A",
    // absolute URLs and schemes
    "https://evil.com",
    "http://evil.com/dashboard",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "evil.com",
    "dashboard",
    // whitespace / control characters (the URL parser strips tab / CR / LF)
    "\t/evil",
    " /dashboard",
    "/\t/evil.com",
    "/\n/evil.com",
    "/cases\r\nSet-Cookie:x=1",
    "/cases?x=%0d%0aSet-Cookie",
    // dot segments that normalise to "//host"
    "/.//evil.com",
    "/a/..//evil.com",
    // login itself (loop)
    "/login",
    "/login?next=/cases",
    "/login/",
    "/login/anything",
    "/%6Cogin",
    // empty
    "",
  ])("rejects %j", (raw) => {
    expect(safeNext(raw)).toBe("/dashboard");
  });

  it.each([undefined, null, 42, {}, ["/cases"], true])("rejects non-string %j", (raw) => {
    expect(safeNext(raw)).toBe("/dashboard");
  });

  it("rejects very long values", () => {
    expect(safeNext("/cases?q=" + "a".repeat(2048))).toBe("/dashboard");
    const atLimit = "/cases?q=" + "a".repeat(2048 - "/cases?q=".length);
    expect(safeNext(atLimit)).toBe(atLimit);
  });

  it("result always stays on the same origin", () => {
    for (const raw of ["/cases", "//evil.com", "/\\evil.com", "/.//evil.com", "/%2F%2Fevil.com"]) {
      expect(new URL(safeNext(raw), "http://x").origin).toBe("http://x");
    }
  });
});

describe("loginPathFor", () => {
  it("adds an encoded next for a real page", () => {
    expect(loginPathFor("/reports/INV-2026-000008")).toBe("/login?next=%2Freports%2FINV-2026-000008");
    expect(loginPathFor("/cases?status=open&page=2")).toBe("/login?next=%2Fcases%3Fstatus%3Dopen%26page%3D2");
  });

  it("skips next for /, /dashboard, missing and unsafe paths", () => {
    for (const p of ["/", "/dashboard", null, undefined, "", "//evil.com", "/login"]) {
      expect(loginPathFor(p)).toBe("/login");
    }
  });

  it("round-trips through the query string and safeNext", () => {
    const target = "/tasks/new?case=INV-2026-000008&kind=reinvestigation";
    const next = new URL(loginPathFor(target), "http://x").searchParams.get("next");
    expect(safeNext(next)).toBe(target);
  });
});
