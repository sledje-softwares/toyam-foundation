import { describe, expect, it } from "vitest";
import { addDomains, domainConflictMessage, emptyInsurerValues, insurerErrors, mergeHints, normaliseDomain, readHints, readInsurerForm } from "./insurer-form";
import { checkTemplateFile, DOCX_MIME, MAX_TEMPLATE_BYTES, safeFileName, templateDisplayName, templatePath } from "./template-file";
import { filterInsurers, sortInsurers, type InsurerRow } from "./insurers-list";

describe("domains", () => {
  it("keeps the domain part of an email address and lower-cases", () => {
    expect(normaliseDomain(" SIU@DemoHealth.Example ")).toEqual({ domain: "demohealth.example", keptDomainPart: true });
    expect(normaliseDomain("https://a.example.in/x").domain).toBe("a.example.in");
  });
  it("splits pasted lists, de-duplicates and sorts", () => {
    const r = addDomains(["b.example.in"], "z.example.in, a.example.in; B.example.in\nx@a.example.in");
    expect(r.domains).toEqual(["a.example.in", "b.example.in", "z.example.in"]);
    expect(r.note).toMatch(/domain part/);
    expect(r.error).toBeNull();
  });
  it("rejects public mail domains and invalid hostnames", () => {
    expect(addDomains([], "me@gmail.com").error).toMatch(/Public email domains/);
    expect(addDomains([], "nodot").error).toMatch(/not a valid/);
    expect(addDomains([], "gmail.com").domains).toEqual([]);
  });
  it("rewrites the trigger conflict message", () => {
    expect(domainConflictMessage("Domain siu.example.in is already used by Test Life Assurance")).toBe("siu.example.in is already used by Test Life Assurance.");
    expect(domainConflictMessage("other")).toBeNull();
  });
});

describe("insurerErrors", () => {
  const ok = { ...emptyInsurerValues(), name: "Demo Health", code: "DHI" };
  it("accepts a minimal insurer", () => expect(insurerErrors(ok)).toEqual({}));
  it("validates code, TAT and name", () => {
    const e = insurerErrors({ ...ok, name: "A", code: "d-1", tat_days: "400" });
    expect(Object.keys(e).sort()).toEqual(["code", "name", "tat_days"]);
    expect(insurerErrors({ ...ok, tat_days: "1.5" }).tat_days).toBeTruthy();
  });
  it("requires a portal address only for Portal, and https", () => {
    expect(insurerErrors({ ...ok, submission_channel: "portal" }).portal_url).toMatch(/Enter the portal/);
    expect(insurerErrors({ ...ok, submission_channel: "email", portal_url: "" })).toEqual({});
    expect(insurerErrors({ ...ok, portal_url: "http://x.in" }).portal_url).toMatch(/https/);
  });
  it("validates email, alias fields and limits", () => {
    expect(insurerErrors({ ...ok, reply_to_email: "nope" }).reply_to_email).toBeTruthy();
    expect(insurerErrors({ ...ok, aliases: [{ field: "bogus", labels: ["x"] }] }).aliases).toBeTruthy();
    expect(insurerErrors({ ...ok, aliases: [{ field: "policy_no", labels: ["a"] }, { field: "policy_no", labels: ["b"] }] }).aliases).toMatch(/once/);
    expect(insurerErrors({ ...ok, aliases: [{ field: "policy_no", labels: Array(11).fill("x") }] }).aliases).toBeTruthy();
  });
});

describe("hints and form reading", () => {
  it("preserves unknown keys and drops empty notes/aliases", () => {
    const merged = mergeHints({ notes: "old", extra: { a: 1 }, aliases: { policy_no: ["P"] } }, "", []);
    expect(merged).toEqual({ extra: { a: 1 } });
    expect(mergeHints({ extra: 1 }, "n", [{ field: "policy_no", labels: ["P", "P"] }])).toEqual({ extra: 1, notes: "n", aliases: { policy_no: ["P"] } });
  });
  it("reads hints back", () => {
    expect(readHints({ notes: "n", aliases: { policy_no: ["P"] } })).toEqual({ notes: "n", aliases: [{ field: "policy_no", labels: ["P"] }] });
    expect(readHints(null)).toEqual({ notes: "", aliases: [] });
  });
  it("reads FormData with JSON fields and upper-cases the code", () => {
    const fd = new FormData();
    fd.set("name", " Demo ");
    fd.set("code", "dhi");
    fd.set("sender_domains", JSON.stringify(["a.example.in"]));
    fd.set("aliases", "not json");
    const v = readInsurerForm(fd);
    expect([v.name, v.code, v.sender_domains, v.aliases]).toEqual(["Demo", "DHI", ["a.example.in"], []]);
  });
});

describe("template file", () => {
  const pk = new Uint8Array([0x50, 0x4b, 3, 4]);
  it("accepts a .docx within the limit", () => expect(checkTemplateFile({ name: "T.DOCX", size: 1000, type: DOCX_MIME }, pk)).toBeNull());
  it("rejects pdf, empty, oversize and non-zip content", () => {
    expect(checkTemplateFile({ name: "a.pdf", size: 10 })).toMatch(/\.docx/);
    expect(checkTemplateFile({ name: "a.docx", size: 0 })).toMatch(/empty/);
    expect(checkTemplateFile({ name: "a.docx", size: MAX_TEMPLATE_BYTES + 1 })).toMatch(/10 MB/);
    expect(checkTemplateFile({ name: "a.docx", size: 5 }, new Uint8Array([1, 2]))).toMatch(/does not look/);
    expect(checkTemplateFile({ name: "a.docx", size: 5, type: "application/pdf" })).toBeTruthy();
  });
  it("builds a safe storage path", () => {
    expect(safeFileName("../My Report (v2)é.docx")).toBe("My-Report-v2-e.docx");
    expect(safeFileName("???.docx")).toBe("template.docx");
    const p = templatePath("abc", "DHI template.docx", new Date(Date.UTC(2026, 10, 12, 9, 5, 7)));
    expect(p).toBe("abc/20261112-090507-DHI-template.docx");
    expect(templateDisplayName(p)).toBe("DHI-template.docx");
  });
});

describe("insurers list", () => {
  const rows: InsurerRow[] = [
    { id: "1", name: "Zeta", code: "ZET", sender_domains: ["zeta.example"], tat_days: 10, submission_channel: "email", has_template: true, is_active: true },
    { id: "2", name: "Alpha", code: "ALP", sender_domains: [], tat_days: 20, submission_channel: "portal", has_template: false, is_active: false },
  ];
  it("filters by status, channel and search", () => {
    expect(filterInsurers(rows, { q: "", status: "active", channel: null }).map((r) => r.id)).toEqual(["1"]);
    expect(filterInsurers(rows, { q: "", status: "all", channel: "portal" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterInsurers(rows, { q: "zeta.ex", status: "all", channel: null }).map((r) => r.id)).toEqual(["1"]);
  });
  it("sorts", () => {
    expect(sortInsurers(rows, "name", "asc").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortInsurers(rows, "tat", "desc").map((r) => r.id)).toEqual(["2", "1"]);
  });
});
