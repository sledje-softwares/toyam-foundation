export type Workload = { openCases: Map<string, number>; openTasks: Map<string, number> };

/**
 * Rows of public.staff_workload() (open cases per office owner, open tasks per assignee, counted in the
 * database over the rows the caller can see, D44) → per-profile maps (only non-zero counts are kept).
 */
export function workloadMaps(rows: { profile_id: string | null; open_cases: number; open_tasks: number }[]): Workload {
  const openCases = new Map<string, number>();
  const openTasks = new Map<string, number>();
  for (const r of rows) {
    if (!r.profile_id) continue;
    if (r.open_cases > 0) openCases.set(r.profile_id, r.open_cases);
    if (r.open_tasks > 0) openTasks.set(r.profile_id, r.open_tasks);
  }
  return { openCases, openTasks };
}

