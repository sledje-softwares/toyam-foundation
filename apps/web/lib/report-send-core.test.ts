import { describe, expect, it } from "vitest";
import {
  kickMessage,
  parseAddressList,
  parseKickReply,
  parseModeReply,
  readReportEmail,
  rowActions,
  SendInput,
  sendDefaults,
  sendModel,
  type SendRow,
} from "./report-send-core";

const target = {
  to_addresses: ["claims@insurer.example"],
  cc_addresses: ["boss@insurer.example", "toyaminvestigation@gmail.com"],
  original_subject: "RE: OD Investigation Case No - MOT1 // MH01 // RAVI",
};

const row = (o: Partial<SendRow>): SendRow => ({
  id: "s1",
  report_id: "r1",
  status: "queued",
  formats: ["pdf"],
  to_addresses: ["claims@insurer.example"],
  cc_addresses: [],
  subject: "Re: x",
  requested_at: "2026-11-19T10:00:00Z",
  sent_at: null,
  attempts: 0,
  error: null,
  test_recipient: null,
  requester: null,
  ...o,
});

describe("sendDefaults", () => {
  it("fills subject and file name from the template patterns; one Re: only", () => {
    const d = sendDefaults({
      target,
      reportEmail: readReportEmail({ subject: "Re: {{original_subject}}", attachment_name: "{{insurer_claim_no}}_{{insured_name}}_IR", cc_from_original: true }),
      values: { insurer_claim_no: "MOT1", insured_name: "Ravi Kumar" },
      caseRef: "INV-2026-000001",
      allowedFormats: ["pdf", "docx"],
      generatedFormats: ["pdf", "docx"],
      defaultFormat: "pdf",
    });
    expect(d.to).toBe("claims@insurer.example");
    expect(d.cc).toBe("boss@insurer.example, toyaminvestigation@gmail.com");
    expect(d.subject).toBe("Re: OD Investigation Case No - MOT1 // MH01 // RAVI");
    expect(d.attachmentName).toBe("MOT1_Ravi_Kumar_IR");
    expect(d.formats).toEqual(["pdf"]);
    expect(d.body).toContain("claim no. MOT1 (Ravi Kumar).");
    expect(d.body.split("\n")[0]).toBe("Dear Sir/Madam,");
  });

  it("no Cc when the template says so; file name falls back to the case ref; format falls back to what was generated", () => {
    const d = sendDefaults({
      target,
      reportEmail: { cc_from_original: false },
      values: {},
      caseRef: "INV-2026-000001",
      allowedFormats: ["pdf", "docx"],
      generatedFormats: ["docx"],
      defaultFormat: "pdf",
    });
    expect(d.cc).toBe("");
    expect(d.attachmentName).toBe("INV-2026-000001_IR");
    expect(d.formats).toEqual(["docx"]);
  });

  it("readReportEmail ignores junk", () => {
    expect(readReportEmail(null)).toEqual({});
    expect(readReportEmail({ subject: 3, cc_from_original: "yes" })).toEqual({ subject: undefined, attachment_name: undefined, body: undefined, cc_from_original: undefined });
  });
});

describe("sendModel", () => {
  const base = {
    canManage: true,
    caseStatus: "orchestrator_review" as const,
    approvalState: "approved" as const,
    latestReportId: "r1",
    sends: [] as SendRow[],
    hasTarget: true,
    usableFormats: ["pdf"],
  };
  it("offers the form for an approved latest version with a reply target", () => {
    expect(sendModel(base)).toEqual({ canSend: true, blocked: null, open: null });
    expect(sendModel({ ...base, approvalState: "not_required", caseStatus: "office_review" }).canSend).toBe(true);
  });
  it("nothing for people who do not manage the case, unapproved versions or sent cases", () => {
    expect(sendModel({ ...base, canManage: false })).toEqual({ canSend: false, blocked: null, open: null });
    expect(sendModel({ ...base, approvalState: "pending" }).canSend).toBe(false);
    expect(sendModel({ ...base, caseStatus: "submitted" }).canSend).toBe(false);
  });
  it("an open send of the latest version blocks a new one; a test run or an old version's send does not", () => {
    const open = row({ status: "unknown" });
    expect(sendModel({ ...base, sends: [open] })).toEqual({ canSend: false, blocked: null, open });
    expect(sendModel({ ...base, sends: [row({ status: "test_sent" })] }).canSend).toBe(true);
    expect(sendModel({ ...base, sends: [row({ status: "queued", report_id: "old" })] }).canSend).toBe(true);
  });
  it("explains a missing reply target, open field work and missing formats", () => {
    expect(sendModel({ ...base, hasTarget: false }).blocked).toMatch(/no insurer email/);
    expect(sendModel({ ...base, caseStatus: "field_in_progress" }).blocked).toMatch(/Field work/);
    expect(sendModel({ ...base, usableFormats: [] }).blocked).toMatch(/format/);
  });
});

describe("rowActions", () => {
  it("retry on a failed latest send; send now on queued; settle on unknown for orchestrator / admin only", () => {
    expect(rowActions({ role: "office", canManage: true, status: "failed", isLatest: true })).toEqual({ retry: true, sendNow: false, settle: false });
    expect(rowActions({ role: "office", canManage: true, status: "failed", isLatest: false }).retry).toBe(false);
    expect(rowActions({ role: "office", canManage: true, status: "queued", isLatest: true }).sendNow).toBe(true);
    expect(rowActions({ role: "office", canManage: true, status: "unknown", isLatest: true }).settle).toBe(false);
    expect(rowActions({ role: "orchestrator", canManage: true, status: "unknown", isLatest: true }).settle).toBe(true);
    expect(rowActions({ role: "admin", canManage: false, status: "unknown", isLatest: true }).settle).toBe(false);
  });
});

describe("form input", () => {
  it("parseAddressList splits, lower-cases and de-duplicates; reports the first bad one", () => {
    expect(parseAddressList("A@x.co; b@y.co,\n a@X.co ")).toEqual({ list: ["a@x.co", "b@y.co"], bad: null });
    expect(parseAddressList("a@x.co, Name <b@y.co>").bad).toBe("Name");
    expect(parseAddressList("")).toEqual({ list: [], bad: null });
  });
  const ok = {
    case_id: "3f000000-0000-4000-8000-000000000001",
    case_ref: "INV-2026-000001",
    formats: ["pdf"],
    to: "claims@insurer.example",
    cc: "",
    subject: "Re: x",
    body: "Please find the report",
    attachment_name: "IR_1",
  };
  it("accepts a complete form", () => {
    const r = SendInput.safeParse(ok);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.to).toEqual(["claims@insurer.example"]);
  });
  it("refuses no To, a bad Cc, no format, a duplicate format, more than 30 recipients", () => {
    expect(SendInput.safeParse({ ...ok, to: " " }).success).toBe(false);
    expect(SendInput.safeParse({ ...ok, cc: "not-an-address" }).error?.issues[0].message).toMatch(/Cc: "not-an-address"/);
    expect(SendInput.safeParse({ ...ok, formats: [] }).success).toBe(false);
    expect(SendInput.safeParse({ ...ok, formats: ["pdf", "pdf"] }).success).toBe(false);
    expect(SendInput.safeParse({ ...ok, formats: ["html"] }).success).toBe(false);
    const many = Array.from({ length: 30 }, (_, i) => `c${i}@x.co`).join(",");
    expect(SendInput.safeParse({ ...ok, cc: many }).success).toBe(false);
  });
});

describe("function replies", () => {
  it("kick: accepted with the mode, or an error code", () => {
    expect(parseKickReply({ ok: true, accepted: true, mode: "test", test_to: "dev@example.com" })).toEqual({ ok: true, mode: "test", testTo: "dev@example.com" });
    expect(parseKickReply({ ok: false, error: { code: "not_configured" } })).toEqual({ ok: false, code: "not_configured" });
    expect(parseKickReply(null)).toEqual({ ok: false, code: "unavailable" });
  });
  it("messages name the test address in test mode", () => {
    expect(kickMessage({ ok: true, mode: "test", testTo: "dev@example.com" })).toMatch(/dev@example\.com only, not to the insurer/);
    expect(kickMessage({ ok: true, mode: "live", testTo: null })).toMatch(/insurer now/);
    expect(kickMessage({ ok: false, code: "unavailable" })).toMatch(/within 10 minutes/);
  });
  it("mode reply", () => {
    expect(parseModeReply({ ok: true, configured: true, mode: "live", test_to: null })).toEqual({ configured: true, mode: "live", testTo: null });
    expect(parseModeReply({ ok: true, configured: false, mode: null, test_to: null })).toEqual({ configured: false, mode: null, testTo: null });
    expect(parseModeReply({ ok: false })).toBeNull();
  });
});
