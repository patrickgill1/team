// @ts-nocheck
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase';

// Best-effort remote logger for render crashes caught by
// SilentErrorBoundary / ErrorBoundary. Writes to crash_logs so
// Patrick can open Firestore Console after a user reports an issue
// and see the actual error + stack instead of guessing.
//
// Why a separate utility (vs just console.error): in production,
// console only helps when you can attach Safari devtools at the
// moment of failure. By the time the user explains the bug, the
// console history is gone. A Firestore doc survives.
//
// crashLogs are write-allowed for any authed user and read-restricted
// to platform admin (Patrick) — see firestore.rules.

const APP_VERSION = (process.env.REACT_APP_VERSION || '').trim()
  || (typeof window !== 'undefined' ? (window as any).__APP_VERSION || '' : '');

export async function logRenderCrash(
  error: Error | string | unknown,
  info?: { componentStack?: string } | null,
  source = 'unknown',
): Promise<void> {
  try {
    const user = auth.currentUser;
    // Cap stacks at ~4kb each so a runaway error doesn't write
    // a multi-megabyte doc.
    const cap = (s?: string | null) => (s ? String(s).slice(0, 4000) : null);
    const msg = (error as any)?.message
      ? String((error as any).message)
      : String(error || '').slice(0, 1000);

    await addDoc(collection(db, 'crash_logs'), {
      source,
      message: msg,
      name: (error as any)?.name || null,
      stack: cap((error as any)?.stack),
      componentStack: cap(info?.componentStack),
      uid: user?.uid || null,
      userEmail: user?.email || null,
      route: (typeof window !== 'undefined' && window.location?.pathname) || null,
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
      appVersion: APP_VERSION || null,
      createdAt: serverTimestamp(),
    });
  } catch {
    // Never throw from a crash logger; we're already in a degraded
    // state. Console is the last-resort sink.
  }
}
