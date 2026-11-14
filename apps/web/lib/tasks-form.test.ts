import { describe, expect, it } from "vitest";
import { emptyTaskForm, parseIstDateTime, parseMode, readTaskForm, toIstInput, validateTaskForm, type TaskFormValues } from "./tasks-form";

const CASE = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";
const CL = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-15T10:00:00Z");
const ctx = { now: NOW, operatorIds: new Set([OP]), checklistIds: new Set([CL]), parentIds: new Set([PARENT]) };

const form = (o: Partial<TaskFormValues>): TaskFormValues => ({
  ...emptyTaskForm("task"),
  case_id: CASE,
  assignee_id: OP,
  kind: "initial",
  title: "Visit the garage",
  ...o,
});

describe("IST date-time input", () => {
  it("reads datetime-local as India time", () => {
    expect(parseIstDateTime("2026-11-20T18:00")?.toISOString()).toBe("2026-11-20T12:30:00.000Z");
    expect(parseIstDateTime("2026-11-20T00:15:30")?.toISOString()).toBe("2026-11-19T18:45:30.000Z");
  });
  it("rejects malformed and impossible dates", () => {
    expect(parseIstDateTime("2026-02-31T10:00")).toBeNull();
    expect(parseIstDateTime("2026-11-20 18:00")).toBeNull();
    expect(parseIstDateTime("2026-11-20T24:00")).toBeNull();
    expect(parseIstDateTime("")).toBeNull();
  });
  it("round-trips", () => {
    expect(toIstInput(new Date("2026-11-20T12:30:00Z"))).toBe("2026-11-20T18:00");
  });
});

describe("task form", () => {
  it("parses the mode", () => {
    expect(parseMode("reinvestigation")).toBe("reinvestigation");
    expect(parseMode(["reinvestigation"])).toBe("reinvestigation");
    expect(parseMode("x")).toBe("task");
    expect(parseMode(undefined)).toBe("task");
  });

  it("reads and trims form data", () => {
    const fd = new FormData();
    fd.set("mode", "reinvestigation");
    fd.set("title", "  Re-investigation  ");
    fd.set("assignee_id", OP);
    const v = readTaskForm(fd);
    expect(v.mode).toBe("reinvestigation");
    expect(v.title).toBe("Re-investigation");
    expect(v.location).toBe("");
  });

  it("builds create_field_task arguments with only the given optionals", () => {
    const { errors, input } = validateTaskForm(form({ due_at: "2026-11-20T18:00", checklist_id: CL, location: "Pune" }), ctx);
    expect(errors).toEqual({});
    expect(input).toEqual({
      p_case_id: CASE,
      p_assignee_id: OP,
      p_title: "Visit the garage",
      p_kind: "initial",
      p_checklist_template_id: CL,
      p_due_at: "2026-11-20T12:30:00.000Z",
      p_location_text: "Pune",
    });
  });

  it("requires an offered operator, a kind and a title", () => {
    const { errors, input } = validateTaskForm(form({ assignee_id: OTHER, kind: "office", title: "ab" }), ctx);
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["assignee_id", "kind", "title"]);
    expect(validateTaskForm(form({ assignee_id: "" }), ctx).errors.assignee_id).toBe("Choose a field operator.");
  });

  it("rejects checklists and parents not offered for the case", () => {
    const { errors } = validateTaskForm(form({ checklist_id: OTHER, parent_task_id: OTHER }), ctx);
    expect(errors.checklist_id).toBeDefined();
    expect(errors.parent_task_id).toBeDefined();
  });

  it("checks the due time", () => {
    expect(validateTaskForm(form({ due_at: "2026-11-15T15:00" }), ctx).errors.due_at).toBe("The due time must be in the future.");
    expect(validateTaskForm(form({ due_at: "2028-01-01T10:00" }), ctx).errors.due_at).toBe("The due date must be within a year.");
    expect(validateTaskForm(form({ due_at: "soon" }), ctx).errors.due_at).toBe("Enter a valid date and time.");
  });

  it("limits lengths", () => {
    const { errors } = validateTaskForm(form({ instructions: "x".repeat(4001), location: "y".repeat(301) }), ctx);
    expect(errors.instructions).toBeDefined();
    expect(errors.location).toBeDefined();
  });

  it("re-investigation: kind is fixed and the request is required", () => {
    const base = form({ mode: "reinvestigation", kind: "", title: "Re-investigation", parent_task_id: PARENT });
    expect(validateTaskForm(base, ctx).errors.instructions).toMatch(/at least 10/);
    const { errors, input } = validateTaskForm({ ...base, instructions: "Get the towing bill and the driver's statement." }, ctx);
    expect(errors).toEqual({});
    expect(input?.p_kind).toBe("re_investigation");
    expect(input?.p_parent_task_id).toBe(PARENT);
    expect(input?.p_instructions).toMatch(/towing bill/);
  });

  it("passes an optional reason of 3-500 characters", () => {
    expect(validateTaskForm(form({}), ctx).input).not.toHaveProperty("p_reason");
    expect(validateTaskForm(form({ reason: "Insurer asked for a spot visit" }), ctx).input?.p_reason).toBe("Insurer asked for a spot visit");
    expect(validateTaskForm(form({ reason: "ab" }), ctx).errors.reason).toMatch(/3 to 500/);
    expect(validateTaskForm(form({ reason: "r".repeat(501) }), ctx).errors.reason).toMatch(/3 to 500/);
  });
});
