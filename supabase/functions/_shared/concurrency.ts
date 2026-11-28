// Bounded concurrency helper shared by edge functions and services (pure; runs in Deno and Node).

/**
 * Map `items` with at most `limit` calls of `fn` in flight. Results keep the input order. The first
 * rejection stops new work from starting and is re-thrown once the calls already running have settled.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}
