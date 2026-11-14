import { describe, expect, it } from "vitest";
import {
  ageingByInsurer,
  bucketFor,
  casesLink,
  formatDuration,
  median,
  stageTurnaround,
  totalBuckets,
  workload,
} from "./dashboard";

// 14 Nov 2026, 10:00 IST
const NOW = new Date("2026-11-14T04:30:00Z");

describe("bucketFor", () => {
  it("handles missing and invalid dates", () => {
    expect(bucketFor(null, NOW)).toBe("none");
    expect(bucketFor("nope", NOW)).toBe("none");
  });
  it("uses IST calendar days", () => {
    expect(bucketFor("2026-11-15T00:00:00Z", NOW)).toBe("ontime");
    expect(bucketFor("2026-11-14T20:00:00Z", NOW)).toBe("ontime"); // 15 Nov 01:30 IST
    expect(bucketFor("2026-11-14T01:00:00Z", NOW)).toBe("today"); // earlier today is still today
    expect(bucketFor("2026-11-13T12:00:00Z", NOW)).toBe("1-2");
    expect(bucketFor("2026-11-12T12:00:00Z", NOW)).toBe("1-2");
    expect(bucketFor("2026-11-11T12:00:00Z", NOW)).toBe("3plus");
  });
});

describe("ageingByInsurer", () => {
  const insurers = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];
  it("counts per bucket, sorts by overdue, totals", () => {
    const rows = ageingByInsurer(
      [
        { insurer_id: "a", due_at: "2026-11-20T00:00:00Z" },
        { insurer_id: "b", due_at: "2026-11-01T00:00:00Z" },
        { insurer_id: "b", due_at: "2026-11-13T00:00:00Z" },
        { insurer_id: "c", due_at: null },
      ],
      insurers,
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["Beta", "Alpha", "Unknown"]);
    expect(rows[0].counts).toEqual({ ontime: 0, today: 0, "1-2": 1, "3plus": 1, none: 0 });
    expect(rows[0].total).toBe(2);
    expect(totalBuckets(rows)).toEqual({ ontime: 1, today: 0, "1-2": 1, "3plus": 1, none: 1 });
  });
});

describe("workload", () => {
  const people = [
    { id: "1", full_name: "Zed" },
    { id: "2", full_name: "Amy" },
    { id: "3", full_name: "Bob" },
  ];
  it("keeps zero rows, sorts, puts unassigned first", () => {
    const rows = workload(["2", "2", "1", null, "9"], people, "Unassigned");
    expect(rows.map((r) => [r.name, r.count])).toEqual([
      ["Unassigned", 1],
      ["Amy", 2],
      ["Former user", 1],
      ["Zed", 1],
      ["Bob", 0],
    ]);
  });
  it("omits the unassigned row when empty", () => {
    expect(workload(["1"], people, "Unassigned")[0].name).toBe("Zed");
  });
});

describe("stageTurnaround", () => {
  const h = (case_id: string, to_status: string, changed_at: string) => ({ case_id, to_status, changed_at });
  it("measures gaps, skips the open last stay, orders stages", () => {
    const stats = stageTurnaround([
      h("c1", "assigned", "2026-11-01T02:00:00Z"),
      h("c1", "received", "2026-11-01T00:00:00Z"),
      h("c1", "field_in_progress", "2026-11-01T03:00:00Z"),
      h("c2", "received", "2026-11-02T00:00:00Z"),
      h("c2", "assigned", "2026-11-02T04:00:00Z"),
    ]);
    expect(stats.map((s) => s.stage)).toEqual(["received", "assigned"]);
    expect(stats[0]).toMatchObject({ cases: 2, medianMs: 3 * 3_600_000, meanMs: 3 * 3_600_000 });
    expect(stats[1]).toMatchObject({ cases: 1, medianMs: 3_600_000 });
  });
  it("is empty without history", () => expect(stageTurnaround([])).toEqual([]));
});

describe("median", () => {
  it("works for odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats ranges", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(10_000)).toBe("< 1 min");
    expect(formatDuration(45 * 60_000)).toBe("45 min");
    expect(formatDuration(200 * 60_000)).toBe("3 h 20 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
    expect(formatDuration(52 * 3_600_000)).toBe("2 d 4 h");
    expect(formatDuration(48 * 3_600_000)).toBe("2 d");
  });
});

describe("casesLink", () => {
  it("always scopes to open and skips empty values", () => {
    expect(casesLink()).toBe("/cases?scope=open");
    expect(casesLink({ due: "overdue", owner: undefined })).toBe("/cases?scope=open&due=overdue");
  });
});
