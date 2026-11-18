import { describe, expect, it } from "vitest";
import {
  AckInput,
  formatsLabel,
  isAckFilter,
  isChannel,
  latestPerCase,
  ManualInput,
  recipientsSummary,
  ReopenInput,
  canCloseWithoutAck,
  CloseInput,
  rowActions,
  safeBack,
  submissionState,
} from "./submissions";

describe("reopened mark", () => {
  it("is reopened when reopen_case() marked the submission, even after the case is closed again", () => {
    expect(submissionState({ id: "a", submitted_at: "2026-11-10T10:00:00Z", reopened_at: "2026-11-12T10:00:00Z" }, "closed", "a")).toBe("reopened");
  });
});

describe("rowActions", () => {
  const base = { canManage: true, acknowledged: false, state: "sent" as const, caseStatus: "submitted" as const };
  it("offers acknowledgement once and reopen on the latest submission of a submitted case", () => {
    expect(rowActions(base)).toEqual({ ack: true, reopen: true, close: false });
    expect(rowActions({ ...base, acknowledged: true })).toEqual({ ack: false, reopen: true, close: "acknowledged" });
    expect(rowActions({ ...base, state: "resent" }).reopen).toBe(false);
    expect(rowActions({ ...base, caseStatus: "office_review", state: "reopened" }).reopen).toBe(false);
  });
  it("offers close after the acknowledgement; orchestrators / admins may close without one", () => {
    expect(rowActions(base).close).toBe(false);
    expect(rowActions({ ...base, canCloseWithoutAck: true }).close).toBe("without_ack");
    expect(rowActions({ ...base, acknowledged: true, state: "resent" }).close).toBe(false);
    expect(rowActions({ ...base, acknowledged: true, caseStatus: "closed", state: "closed" }).close).toBe(false);
    expect(canCloseWithoutAck("orchestrator")).toBe(true);
    expect(canCloseWithoutAck("admin")).toBe(true);
    expect(canCloseWithoutAck("office")).toBe(false);
  });
  it("offers nothing to office staff who do not own the case", () => {
    expect(rowActions({ ...base, canManage: false, acknowledged: true })).toEqual({ ack: false, reopen: false, close: false });
  });
});

describe("close input", () => {
  const id = "3d000000-0000-4000-8000-000000000001";
  it("needs a reason only without an acknowledgement", () => {
    expect(CloseInput.parse({ case_id: id, without_ack: false, note: "  " })).toEqual({ case_id: id, without_ack: false, note: "" });
    expect(CloseInput.safeParse({ case_id: id, without_ack: true, note: "ok" }).success).toBe(false);
    expect(CloseInput.parse({ case_id: id, without_ack: true, note: " Portal never confirms " }).note).toBe("Portal never confirms");
    expect(CloseInput.safeParse({ case_id: id, without_ack: false, note: "x".repeat(501) }).success).toBe(false);
    expect(CloseInput.safeParse({ case_id: "x", without_ack: false, note: "" }).success).toBe(false);
  });
});

describe("action inputs", () => {
  const id = "3d000000-0000-4000-8000-000000000001";
  it("reads acknowledgement time as India time; empty = now", () => {
    expect(AckInput.parse({ submission_id: id, ack_at: "2026-11-15T10:30", insurer_reference: "", note: " ok " })).toEqual({
      submission_id: id,
      ack_at: "2026-11-15T05:00:00.000Z",
      insurer_reference: null,
      note: "ok",
    });
    expect(AckInput.parse({ submission_id: id, ack_at: "", insurer_reference: "R1", note: "" }).ack_at).toBeNull();
    expect(AckInput.safeParse({ submission_id: id, ack_at: "2026-02-31T10:00", insurer_reference: "", note: "" }).success).toBe(false);
  });
  it("needs a portal reference for portal and a note for other", () => {
    const m = { case_ref: "INV-2026-000123", channel: "portal", formats: ["pdf"], submitted_at: "", insurer_reference: "", note: "" };
    expect(ManualInput.safeParse(m).error?.issues[0]?.message).toMatch(/portal reference/);
    expect(ManualInput.safeParse({ ...m, insurer_reference: "P-1" }).success).toBe(true);
    expect(ManualInput.safeParse({ ...m, channel: "other" }).error?.issues[0]?.message).toMatch(/how the report was delivered/);
    expect(ManualInput.safeParse({ ...m, channel: "email", insurer_reference: "P-1" }).success).toBe(false);
    expect(ManualInput.safeParse({ ...m, formats: [], insurer_reference: "P-1" }).success).toBe(false);
  });
  it("needs a reopen reason", () => {
    expect(ReopenInput.safeParse({ case_id: id, reason: " a " }).success).toBe(false);
    expect(ReopenInput.parse({ case_id: id, reason: " Insurer query " }).reason).toBe("Insurer query");
  });
  it("redirects back only to the submissions list", () => {
    expect(safeBack("/submissions?ack=awaiting&page=2")).toBe("/submissions?ack=awaiting&page=2");
    expect(safeBack("https://evil.example/")).toBe("/submissions");
    expect(safeBack("/submissions//evil")).toBe("/submissions");
    expect(safeBack(null)).toBe("/submissions");
  });
});

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
    expect(submissionState(rows[2], "closed", latest.get("c2"))).toBe("closed");
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
