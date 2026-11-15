import { describe, expect, it } from "vitest";
import {
  availabilityNote,
  canRaiseTask,
  noFieldWorkReason,
  checklistProgress,
  defaultKind,
  dueBounds,
  formatBytes,
  hasScopeChoice,
  isCaseRef,
  isOverdue,
  istDayStart,
  lateUploadWindow,
  openTaskCounts,
  parseScope,
  parseStatusFilter,
  progressLabel,
  settingInt,
  sortChecklistOptions,
} from "./tasks";

const NOW = new Date("2026-11-15T10:00:00Z"); // 15:30 IST

describe("tasks list filters", () => {
  it("defaults status to open and accepts one status or all", () => {
    expect(parseStatusFilter(undefined)).toEqual({ value: "", statuses: ["pending", "in_progress"] });
    expect(parseStatusFilter("bogus").statuses).toEqual(["pending", "in_progress"]);
    expect(parseStatusFilter("completed")).toEqual({ value: "completed", statuses: ["completed"] });
    expect(parseStatusFilter(["all"])).toEqual({ value: "all", statuses: null });
  });

  it("defaults scope by role", () => {
    expect(parseScope(undefined, "office")).toBe("mine");
    expect(parseScope(undefined, "orchestrator")).toBe("all");
    expect(parseScope(undefined, "admin")).toBe("all");
    expect(parseScope("all", "office")).toBe("mine"); // D44: office only ever sees its own cases
    expect(parseScope("mine", "admin")).toBe("mine");
    expect(parseScope("x", "office")).toBe("mine");
  });

  it("offers the scope choice to orchestrators and admins only", () => {
    expect(hasScopeChoice("office")).toBe(false);
    expect(hasScopeChoice("orchestrator")).toBe(true);
    expect(hasScopeChoice("admin")).toBe(true);
  });

  it("computes the IST day start", () => {
    expect(istDayStart(NOW).toISOString()).toBe("2026-11-14T18:30:00.000Z");
    // 23:00 UTC is already the next day in India
    expect(istDayStart(new Date("2026-11-15T23:00:00Z")).toISOString()).toBe("2026-11-15T18:30:00.000Z");
  });

  it("builds due bounds", () => {
    expect(dueBounds("overdue", NOW)).toEqual({ lt: NOW.toISOString(), openOnly: true });
    expect(dueBounds("today", NOW)).toEqual({ gte: "2026-11-14T18:30:00.000Z", lt: "2026-11-15T18:30:00.000Z" });
    expect(dueBounds("week", NOW)).toEqual({ gte: NOW.toISOString(), lt: "2026-11-22T10:00:00.000Z" });
    expect(dueBounds("none", NOW)).toEqual({ isNull: true });
  });

  it("flags overdue only for open tasks", () => {
    expect(isOverdue({ status: "pending", due_at: "2026-11-15T09:00:00Z" }, NOW)).toBe(true);
    expect(isOverdue({ status: "completed", due_at: "2026-11-15T09:00:00Z" }, NOW)).toBe(false);
    expect(isOverdue({ status: "in_progress", due_at: "2026-11-15T11:00:00Z" }, NOW)).toBe(false);
    expect(isOverdue({ status: "pending", due_at: null }, NOW)).toBe(false);
  });

  it("accepts plausible case refs only", () => {
    expect(isCaseRef("INV-2026-000123")).toBe(true);
    expect(isCaseRef("")).toBe(false);
    expect(isCaseRef("a,b)")).toBe(false);
    expect(isCaseRef("x".repeat(41))).toBe(false);
  });
});

describe("checklist progress", () => {
  const items = [
    { status: "captured", is_mandatory: true, evidence_count: 0 },
    { status: "pending", is_mandatory: true, evidence_count: 2 }, // matched by label (D41)
    { status: "pending", is_mandatory: true, evidence_count: 0 },
    { status: "pending", is_mandatory: false, evidence_count: null },
    { status: "waived", is_mandatory: false, evidence_count: 0 },
  ];
  it("counts ticked, matched and waived items as done", () => {
    expect(checklistProgress(items)).toEqual({ done: 3, total: 5, mandatoryDone: 2, mandatoryTotal: 3 });
    expect(progressLabel(items)).toBe("3 / 5");
    expect(progressLabel([])).toBeNull();
    expect(progressLabel(undefined)).toBeNull();
  });
});

describe("late uploads", () => {
  it("is current while the hold is open", () => {
    expect(lateUploadWindow({ held_until: null }, 72, NOW)).toEqual({ state: "current" });
  });
  it("stays open for the grace period after the hold ended", () => {
    const w = lateUploadWindow({ held_until: "2026-11-13T10:00:00Z" }, 72, NOW);
    expect(w).toEqual({ state: "late_open", until: new Date("2026-11-16T10:00:00Z") });
    expect(lateUploadWindow({ held_until: "2026-11-10T10:00:00Z" }, 72, NOW).state).toBe("late_closed");
  });
  it("uses the drain window for a deactivated operator, whichever deadline is earlier", () => {
    // Hold still open, operator deactivated 2 days ago: drain for 7 days from deactivation.
    expect(lateUploadWindow({ held_until: null, deactivated_at: "2026-11-13T10:00:00Z" }, 72, NOW, 7)).toEqual({
      state: "late_open",
      until: new Date("2026-11-20T10:00:00Z"),
    });
    // Hold ended before deactivation: grace (72 h) is earlier than the drain window.
    expect(lateUploadWindow({ held_until: "2026-11-13T10:00:00Z", deactivated_at: "2026-11-14T10:00:00Z" }, 72, NOW, 7)).toEqual({
      state: "late_open",
      until: new Date("2026-11-16T10:00:00Z"),
    });
    // Hold ended (task reassigned) after deactivation: only the drain window counts.
    expect(lateUploadWindow({ held_until: "2026-11-14T12:00:00Z", deactivated_at: "2026-11-01T10:00:00Z" }, 72, NOW, 7).state).toBe("late_closed");
  });
  it("reads integer settings from jsonb", () => {
    expect(settingInt(72, 1)).toBe(72);
    expect(settingInt("48", 72)).toBe(48);
    expect(settingInt(null, 72)).toBe(72);
    expect(settingInt(-1, 72)).toBe(72);
  });
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(34 * 1024 * 1024)).toBe("34.0 MB");
    expect(formatBytes(null)).toBe("");
  });
});

describe("assign form helpers", () => {
  it("blocks submitted (D46), closed and cancelled cases", () => {
    expect(canRaiseTask("office_review")).toBe(true);
    expect(canRaiseTask("orchestrator_review")).toBe(true);
    expect(canRaiseTask("submitted")).toBe(false);
    expect(canRaiseTask("closed")).toBe(false);
    expect(canRaiseTask("cancelled")).toBe(false);
    expect(noFieldWorkReason("submitted")).toMatch(/Reopen it from Submissions/);
    expect(noFieldWorkReason("closed")).toMatch(/closed or cancelled/);
    expect(noFieldWorkReason("office_review")).toBeNull();
  });
  it("defaults to first visit until a field task exists", () => {
    expect(defaultKind([])).toBe("initial");
    expect(defaultKind([{ kind: "initial", status: "cancelled" }])).toBe("initial");
    expect(defaultKind([{ kind: "office", status: "completed" }])).toBe("initial");
    expect(defaultKind([{ kind: "initial", status: "completed" }])).toBe("other");
  });
  it("counts open tasks per operator", () => {
    const m = openTaskCounts([
      { assignee_id: "a", status: "pending" },
      { assignee_id: "a", status: "in_progress" },
      { assignee_id: "a", status: "completed" },
      { assignee_id: null, status: "pending" },
      { assignee_id: "b" },
    ]);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
  });
  it("describes availability", () => {
    expect(availabilityNote("available", null, NOW)).toBeNull();
    expect(availabilityNote("on_leave", "2026-11-18T12:00:00Z", NOW)).toBe("On leave until 18 Nov 2026");
    expect(availabilityNote("on_leave", "2026-11-14T12:00:00Z", NOW)).toBeNull();
    expect(availabilityNote("unavailable", null, NOW)).toBe("Unavailable");
  });
  it("sorts the default checklist first", () => {
    const s = sortChecklistOptions([
      { id: "1", name: "B", items: 1, is_default: false },
      { id: "2", name: "C", items: 1, is_default: true },
      { id: "3", name: "A", items: 1, is_default: false },
    ]);
    expect(s.map((o) => o.id)).toEqual(["2", "3", "1"]);
  });
});
