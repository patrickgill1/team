// Thread pre-warm cache.
//
// When a user hovers a thread row on desktop OR opens the chat list on
// mobile, we kick off a background fetch of the first page of messages
// for each visible thread. By the time they tap to open, the snapshot
// is already in memory (or in Firestore's local cache via the SDK's
// persistentLocalCache) so the chat view renders instantly instead of
// flashing empty for ~200–400ms while the live subscription connects.
//
// We don't try to be a full second-level cache here — Firestore's
// persistentLocalCache already does that across sessions. This module
// just makes sure we've TOUCHED each visible thread so the SDK has
// the data warm before the user asks for it.

import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { db } from './firebase';

const warmed = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** Pre-warm the first page of messages for a thread. Idempotent — once
 *  warmed, calls are no-ops until the warmed set is cleared. Failures
 *  are swallowed; this is a perf hint, not a critical fetch.
 *
 *  `isGroup` selects between the top-level chat_messages collection
 *  (team / DM / club / coach) and the subcollection
 *  chat_group_threads/{id}/messages (groups). Callers who don't know
 *  can leave it undefined; the top-level query will still succeed
 *  even against a group thread id but returns nothing useful. */
export function prewarmThread(threadId: string, pageSize: number = 50, isGroup: boolean = false): Promise<void> {
  if (!threadId || warmed.has(threadId)) return Promise.resolve();
  const existing = inflight.get(threadId);
  if (existing) return existing;
  const p = (async () => {
    try {
      const q = isGroup
        ? query(
            collection(db, 'chat_group_threads', threadId, 'messages'),
            orderBy('timestamp', 'desc'),
            limit(pageSize),
          )
        : query(
            collection(db, 'chat_messages'),
            where('threadId', '==', threadId),
            orderBy('timestamp', 'desc'),
            limit(pageSize),
          );
      await getDocs(q);
      warmed.add(threadId);
    } catch {
      /* swallow — the live subscription will retry */
    } finally {
      inflight.delete(threadId);
    }
  })();
  inflight.set(threadId, p);
  return p;
}

/** Pre-warm a batch of threads. Used when the thread list first loads
 *  so the top N threads are ready for instant open. Accepts either
 *  string ids (top-level) or {id, isGroup} tuples so the group path
 *  hits the subcollection cache correctly. */
export function prewarmThreads(
  threads: Array<string | { id: string; isGroup?: boolean }>,
  opts?: { topN?: number },
): void {
  const top = opts?.topN ?? 5;
  for (const t of threads.slice(0, top)) {
    if (typeof t === 'string') {
      void prewarmThread(t);
    } else {
      void prewarmThread(t.id, 50, !!t.isGroup);
    }
  }
}

/** Forget a thread's warm state. Call when the user logs out or the
 *  thread is deleted. */
export function clearPrewarmCache(threadId?: string): void {
  if (threadId) {
    warmed.delete(threadId);
    inflight.delete(threadId);
  } else {
    warmed.clear();
    inflight.clear();
  }
}
