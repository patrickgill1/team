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

/** Catch unhandled Firestore promise rejections globally so a missed
 *  try/catch somewhere doesn't fail silently. Logs the same way
 *  manual catches do. */
export function installFirestoreErrorHandler(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', (event) => {
    const reason: any = event.reason;
    if (reason instanceof FirebaseError) {
      logFirestoreError('unhandled', reason.customData ? String((reason.customData as any).path || '?') : '?', reason);
      // Don't preventDefault — let other handlers see it too.
    }
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
