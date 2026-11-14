import { describe, expect, it } from "vitest";
import {
  ageDays,
  assigneeOptions,
  buildHistory,
  caseHref,
  checklistProgress,
  chronological,
  dueConditions,
  dueState,
  intakeFieldRows,
  isCaseRef,
  isAvailable,
  newTaskHref,
  OPEN_STATUSES,
  parseComposerMode,
  parseDueFilter,
  parseEvidenceSource,
  parseOwnerFilter,
  parseStatusFilter,
  type StaffOption,
} from "./cases";

const NOW = new Date("2026-11-15T06:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

describe("case refs and links", () => {
  it("accepts generated refs and rejects path tricks", () => {
    expect(isCaseRef("INV-2026-000123")).toBe(true);
    expect(isCaseRef("")).toBe(false);
    expect(isCaseRef("../x")).toBe(false);
    expect(isCaseRef("a/b")).toBe(false);
    expect(isCaseRef("x".repeat(65))).toBe(false);
  });
  it("builds case and task links", () => {
    expect(caseHref("INV-2026-000123")).toBe("/cases/INV-2026-000123");
    expect(caseHref("INV-2026-000123", "thread")).toBe("/cases/INV-2026-000123/thread");
    expect(newTaskHref("INV-2026-000123")).toBe("/tasks/new?case=INV-2026-000123");
    expect(newTaskHref("INV-2026-000123", "re_investigation")).toBe("/tasks/new?case=INV-2026-000123&kind=re_investigation");
  });
});

describe("list filters", () => {
  it("defaults status to open; accepts all and one status", () => {
    expect(parseStatusFilter(undefined)).toEqual({ kind: "open" });
    expect(parseStatusFilter("bogus")).toEqual({ kind: "open" });
    expect(parseStatusFilter("all")).toEqual({ kind: "all" });
    expect(parseStatusFilter(["submitted"])).toEqual({ kind: "one", status: "submitted" });
    expect(OPEN_STATUSES).not.toContain("submitted");
    expect(OPEN_STATUSES).toContain("field_in_progress");
  });
  it("parses owner: me, none, a uuid, else nothing", () => {
    expect(parseOwnerFilter("me")).toEqual({ kind: "me" });
    expect(parseOwnerFilter("none")).toEqual({ kind: "none" });
    expect(parseOwnerFilter("19000000-0000-4000-8000-0000000000f1")).toEqual({ kind: "user", id: "19000000-0000-4000-8000-0000000000f1" });
    expect(parseOwnerFilter("x),or(1")).toBeNull();
  });
  it("parses due, evidence source and composer mode", () => {
    expect(parseDueFilter("overdue")).toBe("overdue");
    expect(parseDueFilter("toString")).toBeNull();
    expect(parseDueFilter(undefined)).toBeNull();
    expect(parseEvidenceSource("email")).toBe("email");
    expect(parseEvidenceSource("x")).toBeNull();
    expect(parseComposerMode("staff")).toBe("staff");
    expect(parseComposerMode("all")).toBeNull();
  });
  it("turns due filters into due_at conditions", () => {
    expect(dueConditions("overdue", NOW)).toEqual({ conditions: [{ op: "lt", value: NOW.toISOString() }], openOnly: true });
    const soon = dueConditions("soon", NOW);
    expect(soon.openOnly).toBe(true);
    expect(soon.conditions).toEqual([
      { op: "gte", value: NOW.toISOString() },
      { op: "lte", value: hours(48) },
    ]);
    expect(dueConditions("on_track", NOW)).toEqual({ conditions: [{ op: "gt", value: hours(48) }], openOnly: false });
    expect(dueConditions("none", NOW)).toEqual({ conditions: [{ op: "is_null" }], openOnly: false });
  });
});

describe("ageing vs TAT", () => {
  it("labels overdue, soon and on-track cases", () => {
    expect(dueState(hours(-50), "field_in_progress", NOW)).toEqual({ kind: "overdue", label: "Overdue 2 d", tone: "danger" });
    expect(dueState(hours(-0.2), "assigned", NOW).label).toBe("Overdue 1 h");
    expect(dueState(hours(5), "assigned", NOW)).toEqual({ kind: "soon", label: "Due in 5 h", tone: "warning" });
    expect(dueState(hours(30), "assigned", NOW).label).toBe("Due in 1 d");
    expect(dueState(hours(24 * 6), "assigned", NOW)).toEqual({ kind: "on_track", label: "Due in 6 d", tone: "success" });
  });
  it("ignores due dates on finished cases and handles missing dates", () => {
    expect(dueState(hours(-100), "submitted", NOW).kind).toBe("done");
    expect(dueState(null, "assigned", NOW)).toEqual({ kind: "none", label: "No due date", tone: "neutral" });
  });
  it("counts whole days open", () => {
    expect(ageDays(hours(-49), null, NOW)).toBe(2);
    expect(ageDays(hours(-49), hours(-25), NOW)).toBe(1);
  });
});

describe("assignment options", () => {
  const p = (o: Partial<StaffOption>): StaffOption => ({
    id: o.full_name ?? "x", full_name: "A", role: "office", availability: "available", availability_until: null, max_open_cases: null, ...o,
  });
  const staff = [
    p({ full_name: "Busy Office", id: "b" }),
    p({ full_name: "Leave Office", id: "l", availability: "on_leave", availability_until: hours(24) }),
    p({ full_name: "Back Office", id: "k", availability: "on_leave", availability_until: hours(-1) }),
    p({ full_name: "Orch", id: "o", role: "orchestrator", max_open_cases: 5 }),
    p({ full_name: "Owner", id: "w" }),
  ];
  const counts = new Map([["b", 9], ["k", 2], ["o", 1]]);

  it("treats an ended leave as available", () => {
    expect(isAvailable(staff[1], NOW)).toBe(false);
    expect(isAvailable(staff[2], NOW)).toBe(true);
  });
  it("puts available, least-loaded staff first and drops the current owner", () => {
    const opts = assigneeOptions(staff, counts, "w", NOW);
    expect(opts.map((o) => o.value)).toEqual(["o", "k", "b", "l"]);
    expect(opts[0].label).toBe("Orch · 1 open of 5 · Orchestrator");
    expect(opts[3].label).toBe("Leave Office · 0 open · On leave");
  });
});

describe("thread and tasks", () => {
  it("orders messages oldest first", () => {
    const rows = [
      { id: "b", created_at: "2026-11-15T10:00:00Z" },
      { id: "a", created_at: "2026-11-15T09:00:00Z" },
      { id: "c", created_at: "2026-11-15T10:00:00Z" },
    ];
    expect(chronological(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("counts checklist progress per task", () => {
    const m = checklistProgress([
      { task_id: "t1", status: "pending", is_mandatory: true, evidence_count: 0 },
      { task_id: "t1", status: "pending", is_mandatory: true, evidence_count: 2 },
      { task_id: "t1", status: "waived", is_mandatory: false, evidence_count: 0 },
      { task_id: "t2", status: "pending", is_mandatory: false, evidence_count: 0 },
      { task_id: null, status: "pending", is_mandatory: true, evidence_count: 0 },
    ]);
    expect(m.get("t1")).toEqual({ done: 2, total: 3, mandatoryMissing: 1 });
    expect(m.get("t2")).toEqual({ done: 0, total: 1, mandatoryMissing: 0 });
    expect(m.size).toBe(2);
  });
});

describe("intake fields", () => {
  it("orders by section then field and fills values", () => {
    const rows = intakeFieldRows(
      [
        { id: "f2", key: "insured_name", label: "Insured", position: 2, section_position: 1, section_title: "Claim" },
        { id: "f1", key: "insurer_claim_no", label: "Claim no.", position: 1, section_position: 1, section_title: "Claim" },
        { id: "f3", key: "vehicle_no", label: "Vehicle", position: 1, section_position: 0, section_title: "Vehicle" },
      ],
      [
        { field_id: "f1", value: "CL/1", source: "email_parser" },
        { field_id: "f2", value: "  ", source: "office" },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(["vehicle_no", "insurer_claim_no", "insured_name"]);
    expect(rows[1]).toMatchObject({ value: "CL/1", source: "email_parser" });
    expect(rows[2]).toMatchObject({ value: null, source: null });
    expect(rows[0].value).toBeNull();
  });
});

describe("history", () => {
  it("merges status, assignment and field changes newest first", () => {
    const h = buildHistory(
      [{ id: 1, changed_at: "2026-11-12T10:00:00Z", from_status: "received", to_status: "assigned", note: null, actor: null }],
      [
        { id: 7, assigned_at: "2026-11-12T10:00:00Z", method: "auto", reason: "Automatic assignment", assignee: "N Office", actor: null },
        { id: 8, assigned_at: "2026-11-13T09:00:00Z", method: "manual", reason: "On leave", assignee: "M Office", actor: "N Orch" },
      ],
      [{ changed_at: "2026-11-14T09:00:00Z", actor_name: "M Office", action: "UPDATE", field_key: "Insured", old_value: "R Sharma", new_value: "R. Sharma" }],
    );
    expect(h.map((e) => e.kind)).toEqual(["field", "assignment", "assignment", "status"]);
    expect(h[0]).toMatchObject({ title: "Changed Insured", detail: "R Sharma → R. Sharma", actor: "M Office" });
    expect(h[1]).toMatchObject({ title: "Assigned to M Office", detail: "On leave", actor: "N Orch" });
    expect(h[2]).toMatchObject({ title: "Assigned automatically to N Office", detail: null });
    expect(h[3].title).toBe("Status Received → Assigned");
  });
  it("describes inserts and deletes of field values", () => {
    const h = buildHistory([], [], [
      { changed_at: "2026-11-14T09:00:00Z", actor_name: null, action: "INSERT", field_key: "x", old_value: null, new_value: "v" },
      { changed_at: "2026-11-14T08:00:00Z", actor_name: null, action: "DELETE", field_key: null, old_value: "", new_value: null },
    ]);
    expect(h[0]).toMatchObject({ title: "Set x", detail: "v" });
    expect(h[1]).toMatchObject({ title: "Cleared field", detail: "(empty)" });
  });
});
