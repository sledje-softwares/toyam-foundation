import { describe, expect, it } from "vitest";
import {
  asNumberMap,
  asOptions,
  asStringMap,
  buildReviewForm,
  CLAIM_KEY,
  confirmedElsewhereMessage,
  isReviewReason,
  readSubmittedValues,
  requiredErrors,
  reviewReason,
  templateLabel,
  type TemplateFieldDef,
} from "./intake-review";

describe("confirmedElsewhereMessage", () => {
  it("names the case when the reference is known", () => {
    expect(confirmedElsewhereMessage("INV-2026-000042")).toBe(
      "Intake confirmed: case INV-2026-000042. It is assigned to another office employee, so it does not open for you.",
    );
  });
  it("still confirms without a reference", () => {
    expect(confirmedElsewhereMessage(null)).toBe("Intake confirmed. The case is assigned to another office employee.");
  });
});

describe("reviewReason", () => {
  it("puts replies without a case first", () => {
    expect(reviewReason({ parser_action: "attach_to_case", template_id: null, missing_required: ["x"] })).toBe("reply_no_case");
  });
  it("then no template, missing fields, uncertain", () => {
    expect(reviewReason({ parser_action: "review", template_id: null, missing_required: [] })).toBe("no_template");
    expect(reviewReason({ parser_action: "review", template_id: "t", missing_required: ["policy_no"] })).toBe("missing_fields");
    expect(reviewReason({ parser_action: "review", template_id: "t", missing_required: [] })).toBe("uncertain");
    expect(reviewReason({ parser_action: null, template_id: "t", missing_required: null })).toBe("uncertain");
  });
  it("validates reason strings", () => {
    expect(isReviewReason("missing_fields")).toBe(true);
    expect(isReviewReason("all")).toBe(false);
    expect(isReviewReason(undefined)).toBe(false);
  });
});

describe("jsonb readers", () => {
  it("reads extracted values", () => {
    expect(asStringMap({ a: "x", b: 3, c: true, d: null, e: { z: 1 } })).toEqual({ a: "x", b: "3", c: "true" });
    expect(asStringMap(null)).toEqual({});
    expect(asStringMap(["a"])).toEqual({});
  });
  it("reads and clamps confidences", () => {
    expect(asNumberMap({ a: 0.5, b: "0.9", c: 2, d: -1, e: "x" })).toEqual({ a: 0.5, b: 0.9, c: 1, d: 0 });
  });
  it("reads options", () => {
    expect(asOptions(["Yes", "No"])).toEqual(["Yes", "No"]);
    expect(asOptions([{ value: "A", label: "a" }, 3])).toEqual(["A"]);
    expect(asOptions({})).toBeNull();
    expect(asOptions([])).toBeNull();
  });
});

const FIELDS: TemplateFieldDef[] = [
  { key: "policy_no", label: "Policy number", field_type: "text", is_required: true, section_position: 1, position: 2 },
  { key: CLAIM_KEY, label: "Claim no", field_type: "text", is_required: true, section_position: 1, position: 1 },
  { key: "loss_datetime", label: "Loss date", field_type: "datetime", is_required: false, section_position: 2, position: 1 },
  { key: "insured_name", label: "Insured", field_type: "text", is_required: true, section_position: 0, position: 1 },
  { key: "cause", label: "Cause", field_type: "long_text", is_required: false, section_position: 2, position: 2, options: null },
];

describe("buildReviewForm", () => {
  it("separates the claim number and keeps template order", () => {
    const f = buildReviewForm(FIELDS, { insurer_claim_no: "C1" }, {}, []);
    expect(f.claim.key).toBe(CLAIM_KEY);
    expect(f.claim.label).toBe("Claim no");
    expect(f.claim.value).toBe("C1");
    expect(f.fields.map((x) => x.key)).toEqual(["insured_name", "policy_no", "loss_datetime", "cause"]);
  });

  it("flags missing required and low-confidence values", () => {
    const f = buildReviewForm(
      FIELDS,
      { insurer_claim_no: "C1", insured_name: "A B", loss_datetime: "1 Jan" },
      { insurer_claim_no: 1, insured_name: 0.55, loss_datetime: 0.95 },
      ["policy_no"],
    );
    const by = Object.fromEntries(f.fields.map((x) => [x.key, x]));
    expect(by.policy_no.issue).toEqual({ kind: "missing", message: "Required, and not found in the email." });
    expect(by.insured_name.issue?.kind).toBe("low_confidence");
    expect(by.insured_name.issue?.message).toContain("55%");
    expect(by.loss_datetime.issue).toBeNull();
    expect(by.cause.issue).toBeNull(); // optional and empty
    expect(f.claim.issue).toBeNull();
    expect(f.issueCount).toBe(2);
  });

  it("adds a required claim field when the template has none", () => {
    const f = buildReviewForm(FIELDS.filter((x) => x.key !== CLAIM_KEY), {}, {}, []);
    expect(f.claim).toMatchObject({ key: CLAIM_KEY, required: true, value: "" });
    expect(f.claim.issue?.kind).toBe("missing");
    // claim + insured_name + policy_no
    expect(f.issueCount).toBe(3);
  });

  it("treats whitespace-only values as missing", () => {
    const f = buildReviewForm(FIELDS, { insurer_claim_no: "  " }, { insurer_claim_no: 0.1 }, []);
    expect(f.claim.issue?.kind).toBe("missing");
  });
});

describe("readSubmittedValues", () => {
  it("keeps only allowed, well-formed, non-empty field entries", () => {
    const entries: [string, unknown][] = [
      ["f:insurer_claim_no", "  C1 "],
      ["f:policy_no", ""],
      ["f:other", "x"],
      ["f:Bad-Key", "x"],
      ["template_id", "t"],
      ["f:insured_name", "A"],
      ["f:file", { name: "blob" }],
    ];
    expect(readSubmittedValues(entries, [CLAIM_KEY, "policy_no", "insured_name", "file"])).toEqual({
      insurer_claim_no: "C1",
      insured_name: "A",
    });
  });
});

describe("requiredErrors", () => {
  it("reports the claim number and required template fields", () => {
    expect(requiredErrors(FIELDS, { insured_name: "A" })).toEqual({
      insurer_claim_no: "Enter the claim number.",
      policy_no: "This field is required.",
    });
    expect(requiredErrors(FIELDS, { insurer_claim_no: "C", insured_name: "A", policy_no: "P" })).toEqual({});
  });
});

describe("templateLabel", () => {
  it("formats name, variant and version", () => {
    expect(templateLabel({ name: "IGI Motor OD", variant: "standard", version: 3 })).toBe("IGI Motor OD · standard v3");
    expect(templateLabel({ name: "X", variant: "v" })).toBe("X · v");
  });
});
