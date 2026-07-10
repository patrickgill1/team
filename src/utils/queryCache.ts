// Tiny in-memory query cache with TTL. Purpose: kill the flash that
// happens every time a user navigates back to a screen whose data
// they *just* saw ("cards do that quick verifying thing on every
// home visit" per Patrick 2026-07-10).
//
// The React component re-mounts on every route change and loses its
// useState-held query result. The cache lives OUTSIDE the component
// tree so the next mount can read the last-known-good value
// synchronously — no loading flash — and then quietly refetch in
// the background to pick up any changes.
//
// Not a replacement for SWR / React Query. Just enough for the hot
// Dashboard/PlayerProfile queries. Rules:
//   - Keys are stable strings the caller builds (usually team + season
//     + resource + subject).
//   - Values are plain JSON-serializable objects; do NOT stash
//     React elements or Firestore Timestamps here.
//   - TTL is a soft freshness signal; readCache() always returns the
//     cached value (even if stale) so the caller can render + refetch.
//     isStale() answers "should I refetch now?"

interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

const cache = new Map<string, CacheEntry<any>>();

/** Read the cached value, or undefined if we've never stored one. */
export function readCache<T = unknown>(key: string): T | undefined {
  return cache.get(key)?.value as T | undefined;
}

/** Store a value under the key. Overwrites the previous entry. */
export function writeCache<T>(key: string, value: T): void {
  cache.set(key, { value, storedAt: Date.now() });
}

/** True if the cached entry is older than ttlMs (or missing). Callers
 *  use this to decide whether to trigger a background refetch. */
export function isStale(key: string, ttlMs: number): boolean {
  const entry = cache.get(key);
  if (!entry) return true;
  return Date.now() - entry.storedAt > ttlMs;
}

/** Wipe one key. Useful after a mutation (e.g. save dev-plan → drop
 *  the cached tonight-goal so the next Dashboard visit refetches). */
export function invalidateCache(key: string): void {
  cache.delete(key);
}

/** Wipe every key with a prefix. Use for coarse mutations like
 *  "team changed" that should nuke every team-scoped entry. */
export function invalidateCachePrefix(prefix: string): void {
  const toDelete: string[] = [];
  cache.forEach((_, k) => {
    if (k.startsWith(prefix)) toDelete.push(k);
  });
  for (const k of toDelete) cache.delete(k);
}

/** Clear everything. Used on logout. */
export function clearCache(): void {
  cache.clear();
}
