import { describe, expect, it } from "vitest";
import {
  approvalModel,
  bestMatchScores,
  buildWorkspace,
  comparable,
  dueLabel,
  editLock,
  focusSection,
  latestApproval,
  normaliseValue,
  parseMulti,
  planSectionSave,
  readSectionForm,
  rendersNatively,
  reportStage,
  sectionEvidence,
  sumProgress,
  toIsoDate,
  workspaceTotals,
  type FieldDef,
  type SaveFieldDef,
  type SectionDef,
  type VersionLite,
} from "./reports";

describe("reportStage", () => {
  it("maps case statuses to stages", () => {
    expect(reportStage("office_review", [])).toBe("in_progress");
    expect(reportStage("received", null)).toBe("in_progress");
    expect(reportStage("submitted", [])).toBe("sent");
    expect(reportStage("closed", [])).toBe("sent");
    expect(reportStage("cancelled", [])).toBeNull();
  });

  it("splits orchestrator_review by the latest approval", () => {
    const approved = { decision: "approved" as const, requested_at: "2026-11-10T00:00:00Z" };
    const pending = { decision: "pending" as const, requested_at: "2026-11-12T00:00:00Z" };
    expect(reportStage("orchestrator_review", [approved])).toBe("approved");
    expect(reportStage("orchestrator_review", [approved, pending])).toBe("awaiting_approval");
    expect(reportStage("orchestrator_review", [])).toBe("awaiting_approval");
    expect(latestApproval([pending, approved])).toBe(pending);
  });
});

describe("sumProgress", () => {
  it("sums sections per case and treats nulls as 0", () => {
    const m = sumProgress([
      { case_id: "a", required_total: 3, required_filled: 1, fields_total: 5, fields_filled: 2 },
      { case_id: "a", required_total: 2, required_filled: 2, fields_total: 4, fields_filled: null },
      { case_id: "b", required_total: null, required_filled: null, fields_total: 1, fields_filled: 1 },
    ]);
    expect(m.get("a")).toEqual({ requiredTotal: 5, requiredFilled: 3, fieldsTotal: 9, fieldsFilled: 2 });
    expect(m.get("b")).toEqual({ requiredTotal: 0, requiredFilled: 0, fieldsTotal: 1, fieldsFilled: 1 });
  });
});

describe("value formats", () => {
  it("converts dd/mm/yyyy and validates ISO dates", () => {
    expect(toIsoDate("12/11/2026")).toBe("2026-11-12");
    expect(toIsoDate("1.2.2026")).toBe("2026-02-01");
    expect(toIsoDate("2026-11-12")).toBe("2026-11-12");
    expect(toIsoDate("31/02/2026")).toBeNull();
    expect(toIsoDate("2026-13-01")).toBeNull();
    expect(toIsoDate("tomorrow")).toBeNull();
  });

  it("normalises numbers, amounts and choices", () => {
    expect(normaliseValue("number", ["1,200"], [], false)).toEqual({ value: "1200", error: null });
    expect(normaliseValue("number", ["abc"], [], false).error).toBeTruthy();
    expect(normaliseValue("currency", ["₹1,85,000.50"], [], false)).toEqual({ value: "185000.50", error: null });
    expect(normaliseValue("currency", ["-5"], [], false).error).toBeTruthy();
    expect(normaliseValue("choice", ["Yes"], ["Yes", "No"], false).value).toBe("Yes");
    expect(normaliseValue("choice", ["Maybe"], ["Yes", "No"], false).error).toBeTruthy();
    expect(normaliseValue("boolean", ["No"], [], false).value).toBe("No");
    expect(normaliseValue("boolean", ["true"], [], false).error).toBeTruthy();
  });

  it("normalises dates, datetimes, text and empties", () => {
    expect(normaliseValue("date", ["05/11/2026"], [], false).value).toBe("2026-11-05");
    expect(normaliseValue("datetime", ["2026-11-05T14:30"], [], false).value).toBe("2026-11-05T14:30");
    expect(normaliseValue("datetime", ["2026-11-05T25:30"], [], false).error).toBeTruthy();
    expect(normaliseValue("text", ["  x  "], [], false).value).toBe("x");
    expect(normaliseValue("text", ["x".repeat(4001)], [], false).error).toBeTruthy();
    expect(normaliseValue("long_text", ["x".repeat(4001)], [], false).error).toBeNull();
    expect(normaliseValue("text", ["   "], [], false)).toEqual({ value: null, error: null });
    expect(normaliseValue("text", [""], [], true).error).toBeTruthy();
  });

  it("stores multi_choice as a JSON array and reads legacy values as one item", () => {
    expect(normaliseValue("multi_choice", ["a", "b", "a"], ["a", "b"], false).value).toBe('["a","b"]');
    expect(normaliseValue("multi_choice", [], ["a"], false).value).toBeNull();
    expect(parseMulti('["a","b"]')).toEqual(["a", "b"]);
    expect(parseMulti("a, b")).toEqual(["a, b"]);
    expect(parseMulti(null)).toEqual([]);
    expect(comparable("multi_choice", '["a"]')).toBe(comparable("multi_choice", ["a"]));
  });

  it("knows which stored values the native input would lose", () => {
    expect(rendersNatively("date", "2026-11-12")).toBe(true);
    expect(rendersNatively("date", "12.11.2026")).toBe(false);
    expect(rendersNatively("number", "1,200")).toBe(false);
    expect(rendersNatively("boolean", "Y")).toBe(false);
    expect(rendersNatively("text", "anything")).toBe(true);
    expect(rendersNatively("date", "")).toBe(true);
  });
});

describe("planSectionSave", () => {
  const fields: SaveFieldDef[] = [
    { id: "F1", key: "driver_name", field_type: "text", is_required: true },
    { id: "F2", key: "dl_valid_till", field_type: "date", is_required: false },
    { id: "F3", key: "negative_area", field_type: "choice", is_required: false, options: ["Yes", "No"] },
    { id: "F4", key: "insurer_claim_no", field_type: "text", is_required: true },
    { id: "F5", key: "tags", field_type: "multi_choice", is_required: false, options: ["a", "b"] },
  ];
  const form = (entries: [string, string][]) => readSectionForm(entries);

  it("writes only changed fields, normalised", () => {
    const plan = planSectionSave(
      fields,
      form([
        ["p:driver_name", ""], ["o:driver_name", "Ramesh"], ["f:driver_name", "Ramesh"],
        ["p:dl_valid_till", ""], ["o:dl_valid_till", ""], ["f:dl_valid_till", "01/12/2027"],
      ]),
      new Map([["driver_name", "Ramesh"]]),
    );
    expect(plan).toEqual({ writes: [{ field_id: "F2", key: "dl_valid_till", value: "2027-12-01" }], errors: {}, conflicts: {} });
  });

  it("allows clearing a value (including a required one)", () => {
    const plan = planSectionSave(fields, form([["p:driver_name", ""], ["o:driver_name", "Ramesh"], ["f:driver_name", ""]]), new Map([["driver_name", "Ramesh"]]));
    expect(plan.writes).toEqual([{ field_id: "F1", key: "driver_name", value: null }]);
  });

  it("reports a conflict when the stored value changed since loading", () => {
    const plan = planSectionSave(fields, form([["p:driver_name", ""], ["o:driver_name", "Ramesh"], ["f:driver_name", "Suresh"]]), new Map([["driver_name", "Mahesh"]]));
    expect(plan.writes).toEqual([]);
    expect(plan.conflicts).toEqual({ driver_name: "Mahesh" });
  });

  it("reports invalid values and keeps going", () => {
    const plan = planSectionSave(
      fields,
      form([["p:dl_valid_till", ""], ["o:dl_valid_till", ""], ["f:dl_valid_till", "soon"], ["p:negative_area", ""], ["o:negative_area", ""], ["f:negative_area", "No"]]),
      new Map(),
    );
    expect(Object.keys(plan.errors)).toEqual(["dl_valid_till"]);
    expect(plan.writes).toEqual([{ field_id: "F3", key: "negative_area", value: "No" }]);
  });

  it("keeps a stored choice outside the options selectable", () => {
    const plan = planSectionSave(
      fields,
      form([["p:negative_area", ""], ["o:negative_area", "Partly"], ["f:negative_area", "Partly"], ["p:driver_name", ""], ["o:driver_name", ""], ["f:driver_name", "A"]]),
      new Map([["negative_area", "Partly"]]),
    );
    expect(plan.errors).toEqual({});
  });

  it("ignores read-only, unknown and unrendered fields", () => {
    const plan = planSectionSave(
      fields,
      form([["p:insurer_claim_no", ""], ["o:insurer_claim_no", "MOT1"], ["f:insurer_claim_no", "MOT2"], ["p:other", ""], ["f:other", "x"], ["f:driver_name", "Z"]]),
      new Map(),
    );
    expect(plan).toEqual({ writes: [], errors: {}, conflicts: {} });
  });

  it("treats a multi_choice with every box cleared as a change", () => {
    const plan = planSectionSave(fields, form([["p:tags", ""], ["o:tags", '["a"]']]), new Map([["tags", '["a"]']]));
    expect(plan.writes).toEqual([{ field_id: "F5", key: "tags", value: null }]);
  });
});

describe("buildWorkspace / focusSection", () => {
  const sections: SectionDef[] = [
    { id: "S2", key: "driver", title: "Driver", position: 2, guidance: null },
    { id: "S1", key: "insured", title: "Insured", position: 1, guidance: null },
  ];
  const def = (id: string, section_id: string, key: string, position: number, extra: Partial<FieldDef> = {}): FieldDef => ({
    id, section_id, key, position, label: key, field_type: "text", is_required: false, source: "office", help_text: null, options: [], ...extra,
  });
  const fields = [
    def("A", "S1", "insured_name", 1, { is_required: true, source: "intake" }),
    def("B", "S1", "insurer_claim_no", 2, { is_required: true, source: "intake" }),
    def("C", "S2", "driver_name", 2, { is_required: true }),
    def("D", "S2", "dl_valid_till", 1, { field_type: "date" }),
  ];
  const ws = buildWorkspace(sections, fields, [
    { field_id: "A", value: "Sample Traders", source: "email_parser", updated_at: "2026-11-10T00:00:00Z" },
    { field_id: "B", value: "MOT1", source: "email_parser", updated_at: "2026-11-11T00:00:00Z" },
    { field_id: "D", value: "12.11.2027", source: "email_parser", updated_at: "2026-11-09T00:00:00Z" },
  ]);

  it("orders sections and fields and computes progress", () => {
    expect(ws.map((s) => s.key)).toEqual(["insured", "driver"]);
    expect(ws[1].fields.map((f) => f.key)).toEqual(["dl_valid_till", "driver_name"]);
    expect(ws[0]).toMatchObject({ filled: 2, total: 2, requiredFilled: 2, requiredTotal: 2, lastUpdatedAt: "2026-11-11T00:00:00Z" });
    expect(ws[1]).toMatchObject({ filled: 1, total: 2, requiredFilled: 0, requiredTotal: 1 });
    expect(workspaceTotals(ws)).toEqual({ requiredFilled: 2, requiredTotal: 3, filled: 3, total: 4 });
  });

  it("marks mirrored and non-native values", () => {
    expect(ws[0].fields[1]).toMatchObject({ key: "insurer_claim_no", readOnly: true, source: "email_parser", fromIntake: true });
    expect(ws[1].fields[0]).toMatchObject({ key: "dl_valid_till", asText: true });
    expect(ws[1].fields[1]).toMatchObject({ value: "", source: null });
  });

  it("changes the section version when a value is saved", () => {
    const again = buildWorkspace(sections, fields, [{ field_id: "C", value: "X", source: "office", updated_at: "2026-11-12T00:00:00Z" }]);
    expect(again[1].version).not.toBe(ws[1].version);
  });

  it("focuses the requested section, else the first with a required gap", () => {
    expect(focusSection(ws, "insured")?.key).toBe("insured");
    expect(focusSection(ws, "nope")?.key).toBe("driver");
    expect(focusSection(ws, null)?.key).toBe("driver");
    expect(focusSection([], null)).toBeNull();
  });
});

describe("editLock", () => {
  it("lets office and admin edit active cases only", () => {
    expect(editLock("office", "office_review").editable).toBe(true);
    expect(editLock("admin", "field_in_progress").editable).toBe(true);
    expect(editLock("orchestrator", "office_review").editable).toBe(false);
    expect(editLock("office", "orchestrator_review").editable).toBe(false);
    expect(editLock("office", "submitted").editable).toBe(false);
    expect(editLock("office", "cancelled").editable).toBe(false);
  });
});

describe("sectionEvidence", () => {
  const ev = (id: string, at: string, categoryIds: string[], relevance: "unreviewed" | "relevant" | "not_relevant" = "unreviewed") => ({
    id, server_received_at: at, categoryIds, relevance,
  });
  const files = [
    ev("dl1", "2026-11-10", ["DL"]),
    ev("dl2", "2026-11-12", ["DL"]),
    ev("rc", "2026-11-11", ["RC"]),
    ev("new", "2026-11-13", []),
    ev("old", "2026-11-01", []),
    ev("junk", "2026-11-02", ["DL"], "not_relevant"),
    ev("matchOnly", "2026-11-03", ["RC"]),
  ];

  it("groups by category, field match, unlabelled and not relevant", () => {
    const g = sectionEvidence(files, ["DL"], bestMatchScores([{ evidence_id: "matchOnly", score: 0.9 }, { evidence_id: "rc", score: 0.2 }]));
    expect(g.matched.map((e) => e.id)).toEqual(["matchOnly", "dl2", "dl1"]);
    expect(g.unlabelled.map((e) => e.id)).toEqual(["new", "old"]);
    expect(g.notRelevant.map((e) => e.id)).toEqual(["junk"]);
  });

  it("shows only unlabelled files for a section without categories", () => {
    const g = sectionEvidence(files, [], new Map());
    expect(g.matched).toEqual([]);
    expect(g.unlabelled.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("keeps the best score per file", () => {
    expect(bestMatchScores([{ evidence_id: "a", score: 0.3 }, { evidence_id: "a", score: 0.7 }]).get("a")).toBe(0.7);
  });
});

describe("approvalModel", () => {
  const v = (version: number, decision: "pending" | "approved" | "changes_requested" | null): VersionLite => ({
    id: `R${version}`,
    version,
    approval: decision ? { id: `A${version}`, decision, requested_by: "U", requested_at: `2026-11-1${version}T00:00:00Z` } : null,
  });
  const base = { role: "office" as const, requiresApproval: true, status: "office_review" as const, versions: [] as VersionLite[], requiredMissing: 0 };

  it("needs a version before approval can be requested", () => {
    const m = approvalModel(base);
    expect(m.state).toBe("no_version");
    expect(m.canRequest).toBe(false);
    expect(m.requestBlocked).toMatch(/Generate/);
  });

  it("allows the request on the latest unrequested version in office review", () => {
    const m = approvalModel({ ...base, versions: [v(1, "changes_requested"), v(2, null)] });
    expect(m).toMatchObject({ state: "not_requested", canRequest: true, requestBlocked: null, canDecide: false });
    expect(m.latest?.id).toBe("R2");
  });

  it("blocks the request when required fields are empty, field work is open, or changes were requested", () => {
    expect(approvalModel({ ...base, versions: [v(1, null)], requiredMissing: 2 }).requestBlocked).toMatch(/2 required fields/);
    expect(approvalModel({ ...base, versions: [v(1, null)], status: "field_in_progress" }).requestBlocked).toMatch(/Field work/);
    expect(approvalModel({ ...base, versions: [v(1, "changes_requested")] }).requestBlocked).toMatch(/new version/);
    expect(approvalModel({ ...base, role: "orchestrator", versions: [v(1, null)] }).canRequest).toBe(false);
  });

  it("lets orchestrators and admins decide a pending approval", () => {
    expect(approvalModel({ ...base, role: "orchestrator", status: "orchestrator_review", versions: [v(1, "pending")] }).canDecide).toBe(true);
    expect(approvalModel({ ...base, role: "admin", status: "orchestrator_review", versions: [v(1, "pending")] }).canDecide).toBe(true);
    expect(approvalModel({ ...base, status: "orchestrator_review", versions: [v(1, "pending")] }).canDecide).toBe(false);
  });

  it("says when the template does not require approval", () => {
    expect(approvalModel({ ...base, requiresApproval: false, versions: [v(1, null)] })).toMatchObject({ state: "not_required", canRequest: false, requestBlocked: null });
  });
});

describe("dueLabel", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  it("counts whole days left or overdue", () => {
    expect(dueLabel("2026-11-18T13:00:00Z", now)).toEqual({ text: "3 days left", overdue: false });
    expect(dueLabel("2026-11-15T20:00:00Z", now)).toEqual({ text: "due today", overdue: false });
    expect(dueLabel("2026-11-14T11:00:00Z", now)).toEqual({ text: "1 day overdue", overdue: true });
    expect(dueLabel(null, now)).toBeNull();
  });
});
