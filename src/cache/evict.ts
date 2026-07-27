import type { SessionCache } from './SessionCache.js';

/** Default cap on how many sessions' materialized turns the cache retains. */
export const DEFAULT_CACHE_LIMIT = 50;

/**
 * LRU eviction of cached turn models, bounded by `updatedAt` (most-recently
 * touched sessions survive). Pure over the keys — testable without a live DB.
 * Returns the sessionIds to evict (the oldest beyond `limit`).
 */
export function selectEvictions(
  keys: { sessionId: string; updatedAt: string }[],
  limit = DEFAULT_CACHE_LIMIT,
): string[] {
  if (keys.length <= limit) return [];
  const sorted = keys
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return sorted.slice(limit).map((k) => k.sessionId);
}

/** Enforce the cache bound: evict the oldest turn models beyond `limit`. */
export async function enforceCacheBound(
  cache: SessionCache,
  limit = DEFAULT_CACHE_LIMIT,
): Promise<string[]> {
  const keys = await cache.turnKeys();
  const victims = selectEvictions(keys, limit);
  for (const id of victims) await cache.evictTurns(id);
  return victims;
}
