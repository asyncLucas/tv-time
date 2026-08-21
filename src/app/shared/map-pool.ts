/**
 * Map over `items` with bounded concurrency, preserving input order in the
 * result. TMDB rate-limits, so the fan-out stays small; order is preserved
 * because callers use it to lay out their rails and grids.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Cap the fan-out at TMDB so a large library can't melt the rate limit. */
export const MAX_SHOWS_PROBED = 40;
/** How many TMDB requests are in flight at once — gentle on the API. */
export const TMDB_CONCURRENCY = 5;
