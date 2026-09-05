// Structured logging for Firestore errors. The default Firebase SDK
// emits raw 'Missing or insufficient permissions' style messages with
// zero context — you have no idea which collection, which operation,
// or which document blew up. This wrapper produces a single line per
// failure with the operation, the path, the error code, and any
// caller-supplied context, so a regression like the chat_threads
// rule cascade we just dug out is visible in the console at a glance
// instead of buried as 'permission-denied' for the 80th time.

import { FirebaseError } from 'firebase/app';
import { debugWarn } from './debug';

export interface FirestoreErrorInfo {
  code: string;
  message: string;
  isPermissionDenied: boolean;
  isUnauthenticated: boolean;
}

/** Log a Firestore error with structured context. Returns a normalized
 *  shape so callers can branch on permission-denied without
 *  inspecting err.code themselves. */
export function logFirestoreError(
  operation: string,
  path: string,
  err: unknown,
  extra?: Record<string, any>,
): FirestoreErrorInfo {
  const isFirebase = err instanceof FirebaseError;
  const code = isFirebase ? err.code : 'unknown';
  const message = isFirebase ? err.message : String((err as any)?.message || err);
  const isPermissionDenied = code === 'permission-denied' || code === 'firestore/permission-denied';
  const isUnauthenticated = code === 'unauthenticated' || code === 'firestore/unauthenticated';

  // One structured console line per failure. The leading tag makes it
  // searchable across DevTools / Sentry / wherever logs end up.
  //
  // permission-denied and unauthenticated both fire routinely during
  // auth transitions (sign-out mid-flight, token rotation) — they
  // do NOT represent broken state. Route them through debugWarn so
  // the prod console stays clean; unexpected codes still go loud.
  const tag = `[firestore:${operation}]`;
  if (isPermissionDenied) {
    debugWarn(`${tag} DENIED ${path}`, { code, message, ...extra });
  } else if (isUnauthenticated) {
    debugWarn(`${tag} UNAUTH ${path}`, { code, message, ...extra });
  } else {
    console.error(`${tag} ${path}`, { code, message, ...extra });
  }

  return { code, message, isPermissionDenied, isUnauthenticated };
}

/** Catch unhandled promise rejections globally so a missed try/catch
 *  somewhere doesn't fail silently. Logs Firestore errors through
 *  logFirestoreError so they get the same structured shape as manual
 *  catches; logs everything else through a single [unhandled] tag so
 *  the whole class of "app looks broken but nothing in the console"
 *  bugs becomes searchable.
 *
 *  2026-09-05 rewrite: was FirebaseError-only, which meant a
 *  swallowed fetch reject, a Cloudflare Stream upload throw, or a
 *  Worker fetch rejection produced ZERO console output. Every
 *  reliability bug I've chased in the last two days (chat "loads
 *  forever", POTM badge no-op, invite dedup silent double-mint) was
 *  invisible for exactly this reason. Now every rejection has at
 *  least one console line I can grep. */
export function installFirestoreErrorHandler(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', (event) => {
    const reason: any = event.reason;
    if (reason instanceof FirebaseError) {
      logFirestoreError('unhandled', reason.customData ? String((reason.customData as any).path || '?') : '?', reason);
      // Don't preventDefault — let other handlers see it too.
      return;
    }
    // Non-Firebase rejection. Emit one structured line so the failure
    // is visible without every caller wiring its own .catch. Fetch
    // rejections, Cloudflare Stream throws, worker network errors,
    // stray async blowups from third-party SDKs all land here.
    // Suppress two known-noisy classes:
    //   - Auth errors during sign-out / token rotation (transient)
    //   - Stale-chunk import rejections (staleChunk.ts already handles
    //     these with a full-page reload)
    const message = String(reason?.message || reason || 'unknown');
    if (
      message.includes('quota-exceeded')
      || message.includes('Loading chunk')
      || message.includes('Failed to fetch dynamically imported module')
    ) {
      return;
    }
    console.warn('[unhandled]', {
      message,
      name: reason?.name || 'unknown',
      code: reason?.code || undefined,
      stack: reason?.stack ? String(reason.stack).split('\n').slice(0, 3).join(' | ') : undefined,
    });
  });
}

/** Convenience wrapper for try/catch around a Firestore call. Returns
 *  the result on success, or null and logs on failure. Avoid for
 *  writes you actually need to know succeeded — use only when "best
 *  effort + log on fail" is the desired behavior. */
export async function tryFirestore<T>(
  operation: string,
  path: string,
  fn: () => Promise<T>,
  extra?: Record<string, any>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logFirestoreError(operation, path, err, extra);
    return null;
  }
}
