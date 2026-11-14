import { describe, expect, it } from "vitest";
import { formatsLabel, isAckFilter, isChannel, latestPerCase, recipientsSummary, submissionState } from "./submissions";

describe("latestPerCase / submissionState", () => {
  const rows = [
    { id: "a", case_id: "c1", submitted_at: "2026-11-10T10:00:00Z" },
    { id: "b", case_id: "c1", submitted_at: "2026-11-12T10:00:00Z" },
    { id: "c", case_id: "c2", submitted_at: "2026-11-11T10:00:00Z" },
  ];
  const latest = latestPerCase(rows);

  it("keeps the newest submission per case", () => {
    expect(latest.get("c1")).toBe("b");
    expect(latest.get("c2")).toBe("c");
  });

  it("marks older submissions of the same case as superseded", () => {
    expect(submissionState(rows[0], "submitted", latest.get("c1"))).toBe("resent");
    expect(submissionState(rows[1], "submitted", latest.get("c1"))).toBe("sent");
  });

  it("is reopened when the case is active again after sending", () => {
    expect(submissionState(rows[2], "office_review", latest.get("c2"))).toBe("reopened");
    expect(submissionState(rows[2], "closed", latest.get("c2"))).toBe("sent");
  });

  it("breaks ties on the same timestamp deterministically", () => {
    const tie = latestPerCase([
      { id: "x", case_id: "c", submitted_at: "2026-11-10T10:00:00Z" },
      { id: "y", case_id: "c", submitted_at: "2026-11-10T10:00:00Z" },
    ]);
    expect(tie.get("c")).toBe("y");
  });
});

describe("recipientsSummary", () => {
  it("shows the first address and a count", () => {
    expect(recipientsSummary(["a@x.in"], ["b@x.in", "c@x.in"])).toEqual({ short: "a@x.in +2", full: "To: a@x.in\nCc: b@x.in, c@x.in" });
  });
  it("handles one or none", () => {
    expect(recipientsSummary(["a@x.in"], []).short).toBe("a@x.in");
    expect(recipientsSummary(null, undefined)).toEqual({ short: "—", full: "" });
  });
});

describe("filters and labels", () => {
  it("accepts only known channels and acknowledgement filters", () => {
    expect(isChannel("portal")).toBe(true);
    expect(isChannel("fax")).toBe(false);
    expect(isAckFilter("awaiting")).toBe(true);
    expect(isAckFilter("all")).toBe(false);
  });
  it("labels formats", () => {
    expect(formatsLabel(["pdf", "docx"])).toBe("PDF, DOCX");
    expect(formatsLabel([])).toBe("—");
  });
});
