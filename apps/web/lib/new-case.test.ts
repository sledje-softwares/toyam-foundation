import { describe, expect, it } from "vitest";
import {
  AUTO_OWNER,
  canChooseOwner,
  CLAIM_NO_KEY,
  groupBySection,
  newCaseFields,
  NOTE_MAX,
  placeCreateError,
  readNewCaseForm,
  templateLabel,
  validateNewCase,
  type NewCaseField,
} from "./new-case";

const TPL = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const row = (key: string, extra: Partial<Parameters<typeof newCaseFields>[0][number]> = {}) => ({
  key,
  label: key,
  field_type: "text" as const,
  is_required: false,
  options: [],
  help_text: null,
  position: 1,
  section_position: 1,
  section_title: "Insured",
  ...extra,
});

const FIELDS: NewCaseField[] = newCaseFields([
  row("insured_name", { label: "Insured name", is_required: true, position: 2 }),
  row(CLAIM_NO_KEY, { label: "Claim no", position: 1 }),
  row("loss_date", { label: "Date of loss", field_type: "date", position: 1, section_position: 2, section_title: "Loss" }),
  row("burnt", { label: "Vehicle burnt", field_type: "choice", options: ["Yes", "No"], position: 2, section_position: 2, section_title: "Loss" }),
  row("flags", { label: "Flags", field_type: "multi_choice", options: ["A", "B"], position: 3, section_position: 2, section_title: "Loss" }),
]);

function fd(entries: [string, string][]) {
  return readNewCaseForm(entries);
}

describe("newCaseFields", () => {
  it("orders by section then position and makes the claim no. required", () => {
    expect(FIELDS.map((f) => f.key)).toEqual([CLAIM_NO_KEY, "insured_name", "loss_date", "burnt", "flags"]);
    expect(FIELDS[0].required).toBe(true);
  });
  it("adds a claim no. field when the template has none", () => {
    const f = newCaseFields([row("insured_name")]);
    expect(f[0]).toMatchObject({ key: CLAIM_NO_KEY, required: true, type: "text" });
    expect(f).toHaveLength(2);
  });
  it("groups consecutive fields by section", () => {
    expect(groupBySection(FIELDS).map((g) => [g.title, g.fields.length])).toEqual([
      ["Insured", 2],
      ["Loss", 3],
    ]);
  });
});

describe("templateLabel", () => {
  it("shows claim type, variant and version", () => {
    expect(templateLabel({ claim_type: "motor", variant: "od", version: 3 })).toBe("Motor · OD · v3");
    expect(templateLabel({ claim_type: "health", variant: "reimbursement", version: 1 })).toBe("Health · Reimbursement · v1");
  });
});

describe("canChooseOwner", () => {
  it("is for orchestrators and admins", () => {
    expect(canChooseOwner("orchestrator")).toBe(true);
    expect(canChooseOwner("admin")).toBe(true);
    expect(canChooseOwner("office")).toBe(false);
    expect(canChooseOwner("field")).toBe(false);
  });
});

describe("validateNewCase", () => {
  const ctx = { role: "orchestrator" as const, ownerIds: new Set([OWNER]) };
  const base: [string, string][] = [
    ["template_id", TPL],
    [`f:${CLAIM_NO_KEY}`, "  CL-1 "],
    ["f:insured_name", "R Sharma"],
  ];

  it("builds the RPC input with normalised values, automatic owner and no note", () => {
    const r = validateNewCase(fd([...base, ["f:loss_date", "12/11/2026"], ["f:flags", "A"], ["f:flags", "B"], ["owner", AUTO_OWNER], ["note", "  "]]), FIELDS, ctx);
    expect(r.errors).toEqual({});
    expect(r.input).toEqual({
      p_template_id: TPL,
      p_values: { [CLAIM_NO_KEY]: "CL-1", insured_name: "R Sharma", loss_date: "2026-11-12", flags: '["A","B"]' },
      p_owner_id: null,
      p_note: null,
    });
  });
  it("keeps a chosen owner and the note", () => {
    const r = validateNewCase(fd([...base, ["owner", OWNER], ["note", "Called in\r\n"]]), FIELDS, ctx);
    expect(r.input?.p_owner_id).toBe(OWNER);
    expect(r.input?.p_note).toBe("Called in");
  });
  it("refuses an owner that was not offered", () => {
    const r = validateNewCase(fd([...base, ["owner", OTHER]]), FIELDS, ctx);
    expect(r.input).toBeNull();
    expect(r.errors.owner).toBeTruthy();
  });
  it("ignores an owner sent by an office employee (the database makes them the owner)", () => {
    const r = validateNewCase(fd([...base, ["owner", OTHER]]), FIELDS, { role: "office", ownerIds: new Set() });
    expect(r.input?.p_owner_id).toBeNull();
  });
  it("flags missing required fields, bad dates, unknown choices and a long note", () => {
    const r = validateNewCase(
      fd([["template_id", TPL], ["f:loss_date", "31/02/2026"], ["f:burnt", "Maybe"], ["note", "n".repeat(NOTE_MAX + 1)]]),
      FIELDS,
      ctx,
    );
    expect(r.input).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual(["burnt", "insured_name", CLAIM_NO_KEY, "loss_date", "note"]);
    expect(r.formError).toBe("Check the highlighted fields.");
  });
  it("needs a template id", () => {
    const r = validateNewCase(fd(base.slice(1)), FIELDS, ctx);
    expect(r.formError).toMatch(/Reload/);
  });
});

describe("placeCreateError", () => {
  it("puts a duplicate claim no. next to the field", () => {
    const r = placeCreateError("23505", "Case INV-2026-000001 already has claim number CL-1 for this insurer", FIELDS);
    expect(r.fieldErrors[CLAIM_NO_KEY]).toMatch(/INV-2026-000001/);
  });
  it("maps the required-fields message to the fields by label", () => {
    const r = placeCreateError("22023", "Required fields are empty: Insured name, Date of loss", FIELDS);
    expect(r.fieldErrors).toEqual({ insured_name: "This field is required.", loss_date: "This field is required." });
  });
  it("asks for a reload when the template changed", () => {
    expect(placeCreateError("22023", "Unknown field: colour", FIELDS).formError).toMatch(/Reload/);
    expect(placeCreateError("22023", "Choose a template that is in use", FIELDS).formError).toMatch(/Reload/);
  });
  it("puts an owner problem on the owner select", () => {
    expect(placeCreateError("22023", "The owner must be an active office, orchestrator or admin user", FIELDS).fieldErrors.owner).toBeTruthy();
  });
  it("passes other messages through", () => {
    expect(placeCreateError("42501", "Only office staff can create cases", FIELDS)).toEqual({
      formError: "Only office staff can create cases",
      fieldErrors: {},
    });
  });
});
