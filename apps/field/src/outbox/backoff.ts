export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Delay before retry number `failures` (1 = first failure): exponential from 30 s, capped at 30 min,
 * with "equal jitter" (between half and all of the step) so phones do not retry in lock-step.
 * `random` returns [0, 1).
 */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return 0;
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(step / 2 + (step / 2) * r);
}
