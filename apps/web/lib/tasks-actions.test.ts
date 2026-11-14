import { describe, expect, it } from "vitest";
import {
  canManageTask,
  canReassignOnCase,
  editDefaults,
  parseCancelForm,
  parseReassignForm,
  readEditForm,
  validateEditForm,
} from "./tasks-actions";

const TASK = "11111111-1111-4111-8111-111111111111";
const OP1 = "22222222-2222-4222-8222-222222222222";
const OP2 = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-11-15T10:00:00Z");

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("canManageTask (D44)", () => {
  it("orchestrator and admin manage every open task", () => {
    expect(canManageTask({ role: "orchestrator", userId: ME, caseOwnerId: OP1, taskStatus: "pending" })).toBe(true);
    expect(canManageTask({ role: "admin", userId: ME, caseOwnerId: null, taskStatus: "in_progress" })).toBe(true);
  });
  it("office manages tasks only on its own cases", () => {
    expect(canManageTask({ role: "office", userId: ME, caseOwnerId: ME, taskStatus: "pending" })).toBe(true);
    expect(canManageTask({ role: "office", userId: ME, caseOwnerId: OP1, taskStatus: "pending" })).toBe(false);
    expect(canManageTask({ role: "office", userId: ME, caseOwnerId: null, taskStatus: "pending" })).toBe(false);
  });
  it("closed tasks and field users never", () => {
    expect(canManageTask({ role: "admin", userId: ME, caseOwnerId: ME, taskStatus: "completed" })).toBe(false);
    expect(canManageTask({ role: "admin", userId: ME, caseOwnerId: ME, taskStatus: "cancelled" })).toBe(false);
    expect(canManageTask({ role: "field", userId: ME, caseOwnerId: ME, taskStatus: "pending" })).toBe(false);
  });
  it("no reassignment on closed or cancelled cases", () => {
    expect(canReassignOnCase("field_in_progress")).toBe(true);
    expect(canReassignOnCase("closed")).toBe(false);
    expect(canReassignOnCase("cancelled")).toBe(false);
  });
});

describe("cancel form", () => {
  it("needs a reason of 3-500 characters", () => {
    expect(parseCancelForm(fd({ task_id: TASK, reason: "  Insured withdrew  " })).input).toEqual({ p_task_id: TASK, p_reason: "Insured withdrew" });
    expect(parseCancelForm(fd({ task_id: TASK, reason: "no" })).errors.reason).toMatch(/3 to 500/);
    expect(parseCancelForm(fd({ task_id: TASK, reason: "r".repeat(501) })).errors.reason).toMatch(/3 to 500/);
    expect(parseCancelForm(fd({ task_id: "x", reason: "Insured withdrew" })).errors.task_id).toBeDefined();
  });
});

describe("reassign form", () => {
  const ctx = { operatorIds: new Set([OP1, OP2]), currentAssigneeId: OP1 };
  it("maps to reassign_field_task arguments", () => {
    expect(parseReassignForm(fd({ task_id: TASK, assignee_id: OP2, reason: "On leave" }), ctx).input).toEqual({
      p_task_id: TASK,
      p_assignee_id: OP2,
      p_reason: "On leave",
    });
  });
  it("refuses the current operator, unlisted operators and a missing reason", () => {
    expect(parseReassignForm(fd({ task_id: TASK, assignee_id: OP1, reason: "On leave" }), ctx).errors.assignee_id).toMatch(/already/);
    expect(parseReassignForm(fd({ task_id: TASK, assignee_id: ME, reason: "On leave" }), ctx).errors.assignee_id).toMatch(/listed/);
    expect(parseReassignForm(fd({ task_id: TASK, assignee_id: "", reason: "On leave" }), ctx).errors.assignee_id).toMatch(/Choose/);
    expect(parseReassignForm(fd({ task_id: TASK, assignee_id: OP2, reason: "" }), ctx).errors.reason).toBeDefined();
  });
});

describe("edit form", () => {
  const task = { title: "Visit the garage", instructions: "Check damage", due_at: "2026-11-10T12:30:00+00:00", location_text: "Pune" };
  const ctx = { now: NOW, isRequest: false, currentDueAt: task.due_at };

  it("shows the current values, due in India time", () => {
    expect(editDefaults(task)).toEqual({ title: "Visit the garage", instructions: "Check damage", due_at: "2026-11-10T18:00", location: "Pune" });
    expect(editDefaults({ ...task, instructions: null, due_at: null, location_text: null })).toEqual({
      title: "Visit the garage",
      instructions: "",
      due_at: "",
      location: "",
    });
  });

  it("keeps an unchanged (even past) due time as stored", () => {
    const { input } = validateEditForm(TASK, editDefaults(task), ctx);
    expect(input).toEqual({ p_task_id: TASK, p_title: "Visit the garage", p_instructions: "Check damage", p_due_at: task.due_at, p_location_text: "Pune" });
  });

  it("checks a changed due time and omits cleared values", () => {
    const v = readEditForm(fd({ title: "Visit the garage", instructions: "", due_at: "2026-11-20T18:00", location: " " }));
    expect(validateEditForm(TASK, v, ctx).input).toEqual({ p_task_id: TASK, p_title: "Visit the garage", p_due_at: "2026-11-20T12:30:00.000Z" });
    expect(validateEditForm(TASK, { ...v, due_at: "2026-11-15T15:00" }, ctx).errors.due_at).toMatch(/future/);
    expect(validateEditForm(TASK, { ...v, due_at: "2028-01-01T10:00" }, ctx).errors.due_at).toMatch(/within a year/);
    expect(validateEditForm(TASK, { ...v, due_at: "soon" }, ctx).errors.due_at).toMatch(/valid/);
  });

  it("limits lengths and keeps a re-investigation request", () => {
    const v = editDefaults(task);
    const e = validateEditForm(TASK, { ...v, title: "ab", instructions: "x".repeat(4001), location: "y".repeat(301) }, ctx).errors;
    expect(Object.keys(e).sort()).toEqual(["instructions", "location", "title"]);
    expect(validateEditForm(TASK, { ...v, instructions: "short" }, { ...ctx, isRequest: true }).errors.instructions).toMatch(/at least 10/);
  });
});
