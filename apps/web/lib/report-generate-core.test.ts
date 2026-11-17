import { describe, expect, it } from "vitest";
import {
  cleanRetryAfter,
  errorMessage,
  generateButtonState,
  INITIAL_GENERATE_STATE,
  NOT_SET_UP,
  parseGenerateReply,
  reportDownloadName,
  reportFileHref,
  stateFromResult,
} from "./report-generate-core";

const err = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, message: `server says ${code}`, ...extra } });

describe("errorMessage", () => {
  it("counts down from retry_after", () => {
    expect(errorMessage("rate_limited", "x", 12)).toBe("Try again in 12 s.");
    expect(errorMessage("rate_limited", "x", 3600)).toBe("Try again in 60 min.");
    expect(errorMessage("rate_limited", "x", null)).toMatch(/Too many requests/);
  });
  it("maps the named codes", () => {
    expect(errorMessage("values_changed", null, null)).toBe("Someone changed the report while it was generating. Generate it again.");
    expect(errorMessage("no_layout", null, null)).toBe("This template has no report layout yet.");
    expect(errorMessage("pdf_not_configured", null, null)).toBe(NOT_SET_UP);
    expect(errorMessage("storage_not_configured", null, null)).toBe(NOT_SET_UP);
  });
  it("shows the server's message for the others, a generic one when empty", () => {
    expect(errorMessage("not_editable", "The case is in orchestrator review", null)).toBe("The case is in orchestrator review");
    expect(errorMessage("pdf_failed", "  ", null)).toMatch(/could not be generated/);
  });
});

describe("cleanRetryAfter", () => {
  it("accepts positive numbers and numeric strings, rounds up, caps at a day", () => {
    expect(cleanRetryAfter(9.2)).toBe(10);
    expect(cleanRetryAfter("15")).toBe(15);
    expect(cleanRetryAfter(10 ** 7)).toBe(86400);
  });
  it("rejects the rest", () => {
    for (const v of [0, -1, NaN, "", "abc", null, undefined, {}]) expect(cleanRetryAfter(v)).toBeNull();
  });
});

describe("parseGenerateReply", () => {
  it("reads a generate success", () => {
    const r = parseGenerateReply("generate", { ok: true, report_id: "r1", version: 3, photos: 12, files: [], warnings: ["a", 5, ""] });
    expect(r).toMatchObject({ ok: true, version: 3, reportId: "r1", photos: 12, warnings: ["a"] });
  });
  it("reads a preview success and needs html", () => {
    expect(parseGenerateReply("preview", { ok: true, html: "<p>x</p>", warnings: [] })).toMatchObject({ ok: true, html: "<p>x</p>" });
    expect(parseGenerateReply("preview", { ok: true })).toMatchObject({ ok: false, code: "invalid_reply" });
    expect(parseGenerateReply("generate", { ok: true })).toMatchObject({ ok: false, code: "invalid_reply" });
  });
  it("maps errors with retry_after", () => {
    expect(parseGenerateReply("generate", err("rate_limited", { retry_after: 7 }))).toEqual({
      ok: false,
      code: "rate_limited",
      message: "Try again in 7 s.",
      retryAfter: 7,
    });
    expect(parseGenerateReply("generate", err("values_changed"))).toMatchObject({ code: "values_changed" });
  });
  it("treats a non-object as unavailable", () => {
    expect(parseGenerateReply("generate", null)).toMatchObject({ ok: false, code: "unavailable" });
    expect(parseGenerateReply("generate", "oops")).toMatchObject({ ok: false });
  });
});

describe("button state", () => {
  it("is disabled while generating, with the progress label", () => {
    expect(generateButtonState({ pending: true, retryLeft: 0 })).toEqual({ disabled: true, label: "Generating report…" });
  });
  it("is disabled during a countdown and shows the seconds", () => {
    expect(generateButtonState({ pending: false, retryLeft: 4 })).toEqual({ disabled: true, label: "Generate report (4 s)" });
  });
  it("is enabled otherwise", () => {
    expect(generateButtonState({ pending: false, retryLeft: 0 })).toEqual({ disabled: false, label: "Generate report" });
  });
});

describe("stateFromResult", () => {
  it("carries version and warnings on success, retry on error, and bumps seq", () => {
    const ok = stateFromResult(INITIAL_GENERATE_STATE, { ok: true, mode: "generate", html: null, version: 2, reportId: null, photos: 1, warnings: ["w"] });
    expect(ok).toMatchObject({ seq: 1, status: "ok", version: 2, warnings: ["w"] });
    const bad = stateFromResult(ok, { ok: false, code: "rate_limited", message: "Try again in 9 s.", retryAfter: 9 });
    expect(bad).toMatchObject({ seq: 2, status: "error", retryAfter: 9, message: "Try again in 9 s." });
  });
});

describe("file names and links", () => {
  it("builds <case_ref>_v<n>.<ext> and strips odd characters", () => {
    expect(reportDownloadName("INV-2026-000008", 3, "pdf")).toBe("INV-2026-000008_v3.pdf");
    expect(reportDownloadName("A/B C", 1, "docx")).toBe("A_B_C_v1.docx");
  });
  it("links to the download route", () => {
    expect(reportFileHref("abc", "pdf")).toBe("/files/reports/abc/pdf");
  });
});
