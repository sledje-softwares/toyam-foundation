import { describe, expect, it } from "vitest";
import { reparseForTemplate, type ReparseTemplate } from "./intake-reparse";

const template: ReparseTemplate = {
  id: "t1",
  insurer_id: "i1",
  insurer_code: "IGI",
  claim_type: "motor_od",
  variant: "standard",
  version: 1,
  intake_rules: { subject_pattern: "^(?<x>OD)\\s*\\|\\|\\s*(\\d+)", subject_groups: { insurer_claim_no: 2 } },
  fields: [
    { key: "insurer_claim_no", label: "Claim no.", field_type: "text", is_required: true, extract: { labels: ["Claim Number"] } },
    { key: "policy_no", label: "Policy no.", field_type: "text", is_required: true, extract: { labels: ["Policy Number"] } },
    { key: "insured_name", label: "Insured", field_type: "text", is_required: true, extract: { labels: ["Insured Name"] } },
    { key: "mobile", label: "Mobile", field_type: "text", is_required: false, extract: { labels: ["Mobile Number"] } },
    { key: "garage", label: "Garage", field_type: "text", is_required: true, extract: { labels: ["Garage Name"] } },
  ],
};

const body = [
  "Policy Number: P-000111",
  "Claim Number: C-999000",
  "Insured Name: Test Person",
  "Mobile Number: 9000000000",
].join("\n");

describe("reparseForTemplate", () => {
  it("reads the plain-text rows when only the body is known, even if the subject matches no pattern", async () => {
    const r = await reparseForTemplate(
      { subject: "THEFT || 1234 || X", from_address: "a@insurer.test", received_at: "2026-01-01T00:00:00Z", body_text: body },
      null,
      template,
    );
    expect(r.source).toBe("body");
    expect(r.values.policy_no).toBe("P-000111");
    expect(r.values.insurer_claim_no).toBe("C-999000");
    expect(r.values.insured_name).toBe("Test Person");
    expect(r.confidence.policy_no).toBeLessThan(0.95);
    expect(r.missing).toEqual(["garage"]);
  });

  it("decodes a raw .eml with an HTML table", async () => {
    const eml = [
      "From: a@insurer.test",
      "To: b@firm.test",
      "Subject: THEFT || 1234",
      "Message-ID: <m1@test>",
      "Date: Thu, 01 Jan 2026 10:00:00 +0000",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<table><tr><td>Policy Number</td><td>P-777</td></tr><tr><td>Garage Name</td><td>Test Garage</td></tr></table>",
    ].join("\r\n");
    const r = await reparseForTemplate(
      { subject: "THEFT || 1234", from_address: "a@insurer.test", received_at: "2026-01-01T00:00:00Z", body_text: "" },
      new TextEncoder().encode(eml),
      template,
    );
    expect(r.source).toBe("raw");
    expect(r.values.policy_no).toBe("P-777");
    expect(r.values.garage).toBe("Test Garage");
    expect(r.missing).toContain("insured_name");
  });
});
