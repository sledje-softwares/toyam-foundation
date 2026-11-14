import { describe, expect, it } from "vitest";
import {
  addItem,
  buildSavePayload,
  copyState,
  filterTemplates,
  findReplaced,
  groupTemplates,
  hasBlockingErrors,
  impactText,
  isDirty,
  moveItem,
  newItem,
  openTaskCounts,
  orderCategories,
  overridesAllInsurers,
  putInUseText,
  removeItem,
  SavePayloadSchema,
  takeOutOfUseText,
  undoRemove,
  updateItem,
  validateChecklist,
  type EditorItem,
  type EditorState,
  type OtherTemplate,
  type TemplateRow,
} from "./checklists";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const INS = "33333333-3333-4333-8333-333333333333";
const CAT = "44444444-4444-4444-8444-444444444444";

const item = (key: string, over: Partial<EditorItem> = {}): EditorItem => ({ ...newItem(key), description: `Item ${key}`, category_id: CAT, ...over });
const state = (over: Partial<EditorState> = {}): EditorState => ({
  id: ID1,
  version: 3,
  name: "Hospital visit",
  claim_type: "health",
  insurer_id: "",
  items: [item("a", { id: ID2 }), item("b"), item("c")],
  ...over,
});
const keys = (items: EditorItem[]) => items.map((i) => i.key).join("");

describe("reorder / add / remove", () => {
  const items = state().items;
  it("moves up and down and stops at the ends", () => {
    expect(keys(moveItem(items, "b", -1))).toBe("bac");
    expect(keys(moveItem(items, "b", 1))).toBe("acb");
    expect(moveItem(items, "a", -1)).toBe(items);
    expect(moveItem(items, "c", 1)).toBe(items);
    expect(moveItem(items, "zz", 1)).toBe(items);
  });
  it("removes with undo at the same place", () => {
    const r = removeItem(items, "b");
    expect(keys(r.items)).toBe("ac");
    expect(keys(undoRemove(r.items, r.removed!))).toBe("abc");
    expect(undoRemove(items, r.removed!)).toBe(items);
  });
  it("adds up to 50 items, camera only on for a new photo", () => {
    const added = addItem(items, "d");
    expect(added.at(-1)).toMatchObject({ key: "d", id: null, required_evidence_type: "photo", is_mandatory: true, camera_only: true });
    const full = Array.from({ length: 50 }, (_, i) => item(`k${i}`));
    expect(addItem(full, "x")).toBe(full);
  });
  it("type change resets camera only; Note never camera only", () => {
    let l = updateItem(items, "a", { required_evidence_type: "document" });
    expect(l[0].camera_only).toBe(false);
    l = updateItem(l, "a", { required_evidence_type: "photo" });
    expect(l[0].camera_only).toBe(true);
    l = updateItem(l, "a", { required_evidence_type: "note" });
    expect(l[0].camera_only).toBe(false);
    l = updateItem(l, "a", { camera_only: true });
    expect(l[0].camera_only).toBe(false);
  });
});

describe("validation", () => {
  it("accepts a valid checklist", () => {
    const v = validateChecklist(state());
    expect(hasBlockingErrors(v)).toBe(false);
    expect(v.warnings).toEqual([]);
  });
  it("flags name, claim type, items and descriptions", () => {
    const v = validateChecklist(state({ name: " ab ", claim_type: "", items: [] }));
    expect(v.fieldErrors).toMatchObject({ name: expect.any(String), claim_type: expect.any(String), items: "Add at least one item." });
    const w = validateChecklist(state({ items: [item("a", { description: "  x " }), item("b", { description: "y".repeat(201) })] }));
    expect(Object.keys(w.itemErrors)).toEqual(["a", "b"]);
    expect(validateChecklist(state({ name: "n".repeat(81) })).fieldErrors.name).toBeTruthy();
  });
  it("warns: no required item, duplicate descriptions, missing categories", () => {
    const v = validateChecklist(
      state({ items: [item("a", { is_mandatory: false, description: "Bill" }), item("b", { is_mandatory: false, description: " bill ", category_id: "" })] }),
    );
    expect(v.warnings).toEqual([
      "No item is required.",
      "Two items have the same description.",
      "1 item has no evidence category, so it will not tick itself when files are labelled.",
    ]);
    expect(hasBlockingErrors(v)).toBe(false);
  });
  it("in-use name clash with another in-use checklist of the same scope", () => {
    const others: OtherTemplate[] = [{ id: ID2, name: "hospital VISIT", claim_type: "health", insurer_id: null, is_active: true, version: 2 }];
    expect(validateChecklist(state(), { isActive: true, others }).fieldErrors.name).toMatch(/has this name/);
    expect(validateChecklist(state(), { isActive: false, others }).fieldErrors.name).toBeUndefined();
    expect(validateChecklist(state({ insurer_id: INS }), { isActive: true, others }).fieldErrors.name).toBeUndefined();
  });
});

describe("save payload", () => {
  it("trims, keeps order and ids, maps empty selects to null, clears camera only on Note", () => {
    const s = state({
      name: "  Hospital visit ",
      insurer_id: INS,
      items: [item("b", { description: " Front ", category_id: "" }), item("a", { id: ID2, required_evidence_type: "note", camera_only: true })],
    });
    const p = buildSavePayload(s);
    expect(p).toEqual({
      id: ID1,
      expected_version: 3,
      name: "Hospital visit",
      claim_type: "health",
      insurer_id: INS,
      items: [
        { description: "Front", required_evidence_type: "photo", is_mandatory: true, camera_only: true, category_id: null },
        { id: ID2, description: "Item a", required_evidence_type: "note", is_mandatory: true, camera_only: false, category_id: CAT },
      ],
    });
    expect(SavePayloadSchema.safeParse(p).success).toBe(true);
  });
  it("new checklist: null id and version, all insurers = null", () => {
    const p = buildSavePayload(state({ id: null, version: null }));
    expect(p).toMatchObject({ id: null, expected_version: null, insurer_id: null });
    expect(SavePayloadSchema.safeParse(p).success).toBe(true);
  });
  it("schema rejects stale shapes", () => {
    const p = buildSavePayload(state());
    expect(SavePayloadSchema.safeParse({ ...p, expected_version: null }).success).toBe(false);
    expect(SavePayloadSchema.safeParse({ ...p, items: [] }).success).toBe(false);
    expect(SavePayloadSchema.safeParse({ ...p, items: [{ ...p.items[0], required_evidence_type: "note", camera_only: true }] }).success).toBe(false);
  });
  it("dirty tracking and duplicate", () => {
    const s = state();
    expect(isDirty(s, { ...s })).toBe(false);
    expect(isDirty(s, { ...s, items: moveItem(s.items, "b", -1) })).toBe(true);
    let n = 0;
    const c = copyState(s, () => `n${++n}`);
    expect(c).toMatchObject({ id: null, version: null, name: "Copy of Hospital visit" });
    expect(c.items.every((i) => i.id === null)).toBe(true);
    expect(keys(c.items)).toBe("n1n2n3");
  });
});

describe("list", () => {
  const row = (over: Partial<TemplateRow>): TemplateRow => ({
    id: ID1, name: "Hospital visit", claim_type: "health", insurer_id: null, insurer_name: null,
    is_active: true, version: 1, updated_at: "2026-11-12T00:00:00Z", items: 3, required: 2, ...over,
  });
  const all = [
    row({ id: "a" }),
    row({ id: "b", insurer_id: INS, insurer_name: "Demo Health" }),
    row({ id: "c", name: "Garage visit", claim_type: "motor", is_active: false }),
  ];
  it("filters by claim type, insurer scope and status", () => {
    expect(filterTemplates(all, { claim_type: null, insurer: null, status: "in_use" }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(filterTemplates(all, { claim_type: null, insurer: "none", status: "all" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterTemplates(all, { claim_type: "motor", insurer: null, status: "not_in_use" }).map((r) => r.id)).toEqual(["c"]);
  });
  it("groups every claim type in enum order, all-insurer first", () => {
    const g = groupTemplates([all[1], all[0]], null);
    expect(g.map((x) => x.claim_type)).toEqual(["health", "motor", "death", "personal_accident", "property", "other"]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(g[1].rows).toEqual([]);
    expect(groupTemplates(all, "motor").map((x) => x.claim_type)).toEqual(["motor"]);
  });
  it("override hint only for an in-use insurer checklist with an in-use all-insurer twin", () => {
    expect(overridesAllInsurers(all[1], all)).toBe(true);
    expect(overridesAllInsurers(all[0], all)).toBe(false);
    expect(overridesAllInsurers(all[1], [all[1], { ...all[0], is_active: false }])).toBe(false);
  });
});

describe("categories and impact", () => {
  it("relevant categories first, inactive hidden unless used", () => {
    const cats = [
      { id: "x", name: "Bill", is_active: true },
      { id: "y", name: "Accident spot", is_active: true },
      { id: "z", name: "Old", is_active: false },
      { id: "w", name: "Aadhaar", is_active: true },
    ];
    const o = orderCategories(cats, new Set(["x", "y"]));
    expect(o.relevant.map((c) => c.id)).toEqual(["y", "x"]);
    expect(o.other.map((c) => c.id)).toEqual(["w"]);
    expect(orderCategories(cats, new Set(), new Set(["z"])).other.map((c) => c.id)).toEqual(["w", "y", "x", "z"]);
  });
  it("counts distinct open tasks per template", () => {
    const m = openTaskCounts([
      { task_id: "t1", template_id: "A" },
      { task_id: "t1", template_id: "A" },
      { task_id: "t2", template_id: "A" },
      { task_id: "t3", template_id: "B" },
      { task_id: "t4", template_id: null },
    ]);
    expect(Object.fromEntries(m)).toEqual({ A: 2, B: 1 });
  });
  it("impact and confirm texts", () => {
    expect(impactText(0)).toMatch(/No open task uses a copy/);
    expect(impactText(1)).toMatch(/1 open task uses an earlier copy/);
    expect(impactText(7)).toMatch(/Existing tasks keep their own copy — 7 open tasks use an earlier copy/);
    expect(takeOutOfUseText(0)).toMatch(/No open task uses it/);
    expect(takeOutOfUseText(2)).toMatch(/2 open tasks use a copy of it; existing tasks are not affected/);
    expect(
      putInUseText({ name: "Hospital visit", claim_type: "health", insurerName: "Demo Health Insurance", replaced: { version: 2, openTasks: 4 }, openTasks: 0 }),
    ).toBe(
      'Put "Hospital visit" in use for Demo Health Insurance? It replaces the checklist currently in use with the same name for Health · Demo Health Insurance (version 2). Case templates linked to that checklist switch to this one, so new cases from them get the new items immediately. 4 open tasks use a copy of that checklist. Tasks already created are not affected.',
    );
    expect(putInUseText({ name: "X", claim_type: "motor", insurerName: null, replaced: null, openTasks: 1 })).toBe(
      'Put "X" in use for all insurers? 1 open task uses an earlier copy of this checklist. Tasks already created are not affected.',
    );
  });
  it("finds the checklist that would be replaced", () => {
    const others: OtherTemplate[] = [
      { id: ID2, name: "Hospital Visit", claim_type: "health", insurer_id: INS, is_active: true, version: 2 },
      { id: ID1, name: "Hospital visit", claim_type: "health", insurer_id: INS, is_active: true, version: 5 },
    ];
    expect(findReplaced({ id: ID1, name: "hospital visit", claim_type: "health", insurer_id: INS }, others)?.id).toBe(ID2);
    expect(findReplaced({ id: ID1, name: "hospital visit", claim_type: "health", insurer_id: "" }, others)).toBeNull();
  });
});
