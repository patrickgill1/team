// Worker-side error sink. Writes a doc to crash_logs (same
// collection the React app uses for SilentErrorBoundary crashes)
// so the GoalKickr admin portal can show a unified errors timeline.
//
// Design notes:
//   - Best-effort: catches its own errors and never throws back.
//     If the firestore write itself fails, we still console.error
//     locally so wrangler tail surfaces it.
//   - Always sets source: 'worker' so the admin portal can split
//     worker errors from client crashes.
//   - Caps fields the same way crashLog.ts does on the client
//     (stack 4000, message 1000) so a runaway error can't blow
//     past Firestore's 1MB-per-doc cap.

import { createDocument } from './firestore';
import { ServiceAccount, parseServiceAccount } from './fcm';

interface ErrorLogEnv {
  FIREBASE_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
}

function cap(s: unknown, n: number): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

function getSa(env: ErrorLogEnv): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  try { return parseServiceAccount(env.FCM_SERVICE_ACCOUNT); } catch { return null; }
}

function projectId(env: ErrorLogEnv): string | null {
  if (env.FIREBASE_PROJECT_ID) return env.FIREBASE_PROJECT_ID;
  return getSa(env)?.project_id || null;
}

interface LogWorkerErrorInput {
  err: unknown;
  /** Short identifier like 'widget' or 'stripe-webhook' for routing the admin filter. */
  workerRoute: string;
  /** Response status the worker ended up returning (null if it crashed before responding). */
  status?: number | null;
  /** Request URL when known. */
  url?: string | null;
  /** Optional extra context (will be JSON.stringified, capped). */
  context?: Record<string, any>;
}

export async function logWorkerError(env: ErrorLogEnv, input: LogWorkerErrorInput): Promise<void> {
  const pid = projectId(env);
  const sa = getSa(env);
  if (!pid || !sa) {
    console.error('[errorLog] firestore not configured; falling back to console only',
      input.workerRoute, (input.err as any)?.message);
    return;
  }

  const e: any = input.err;
  const doc = {
    source: 'worker',
    message: cap(e?.message ?? e ?? 'unknown', 1000) || 'unknown',
    name: cap(e?.name, 200),
    stack: cap(e?.stack, 4000),
    componentStack: null,
    uid: null,
    userEmail: null,
    route: null,
    userAgent: null,
    appVersion: null,
    workerRoute: cap(input.workerRoute, 200),
    status: typeof input.status === 'number' ? input.status : null,
    url: cap(input.url, 500),
    context: input.context ? cap(JSON.stringify(input.context), 2000) : null,
    createdAt: new Date(),
  };

  try {
    await createDocument(pid, 'crash_logs', doc, sa);
  } catch (writeErr) {
    console.error('[errorLog] failed to write crash_logs row',
      input.workerRoute, (writeErr as any)?.message);
  }
}
