import { describe, expect, it } from "vitest";
import { workloadMaps } from "./workload";

describe("workloadMaps", () => {
  it("splits staff_workload rows into case and task maps, dropping zeros and null ids", () => {
    const w = workloadMaps([
      { profile_id: "office-1", open_cases: 3, open_tasks: 0 },
      { profile_id: "field-1", open_cases: 0, open_tasks: 2 },
      { profile_id: null, open_cases: 9, open_tasks: 9 },
    ]);
    expect([...w.openCases]).toEqual([["office-1", 3]]);
    expect([...w.openTasks]).toEqual([["field-1", 2]]);
  });
  it("is empty for no rows", () => {
    const w = workloadMaps([]);
    expect(w.openCases.size + w.openTasks.size).toBe(0);
  });
});
