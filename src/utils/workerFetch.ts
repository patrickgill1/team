/**
 * Small client helper that stamps every worker request with the
 * current Firebase Auth ID token instead of the legacy
 * NOTIFY_SECRET static bearer.
 *
 * Why this exists
 * ───────────────
 * REACT_APP_NOTIFY_SECRET was baked into every shipped bundle by CRA
 * and was accepted as admin bearer by every worker endpoint — anyone
 * who scraped the JS could refund via Stripe, send push, etc. This
 * helper replaces the static bearer with a per-request ID token
 * that:
 *   1. Google verifies at the worker via RS256 + JWKS
 *   2. Carries the caller's uid, so per-endpoint authorization can
 *      check role / team / club membership server-side.
 *
 * Callers use this instead of raw fetch() for anything hitting the
 * NOTIFY_URL origin (mailer / push / stripe / places / drills / ical
 * / customer portal / registration refund).
 *
 * If the user is not signed in, the request fails fast with a
 * 'not-signed-in' rejection — no request goes out. This is preferable
 * to hitting the worker anonymously and getting a 401 back.
 */

import { getAuth } from 'firebase/auth';

const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL || '';

export function hasWorkerConfig(): boolean {
  return NOTIFY_URL.length > 0;
}

export function workerOrigin(): string {
  return NOTIFY_URL;
}

async function currentIdToken(): Promise<string | null> {
  try {
    const auth = getAuth();
    const user = auth.currentUser;
    if (!user) return null;
    // Force refresh false — Firebase auto-refreshes tokens well before
    // expiry so a passthrough is fine. Explicit refresh only when we
    // catch a 401 and want to retry.
    return await user.getIdToken(false);
  } catch {
    return null;
  }
}

export interface WorkerFetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  /** Force-refresh the Firebase ID token before sending. Callers use
   *  this after a 401 to recover from an expired token. Defaults to
   *  false. */
  refreshToken?: boolean;
}

/**
 * Fetch against a worker endpoint with an auto-attached Firebase ID
 * token. Path may be:
 *   - absolute (`https://…/send`) — used as-is
 *   - relative (`/send`) — prepended with NOTIFY_URL
 *
 * Retries once on 401 with a force-refreshed token; this handles the
 * "token just expired" race cleanly without callers having to think
 * about it.
 */
export async function workerFetch(path: string, opts: WorkerFetchOptions = {}): Promise<Response> {
  if (!NOTIFY_URL) throw new Error('worker-url-not-configured');
  const url = /^https?:\/\//i.test(path) ? path : `${NOTIFY_URL}${path.startsWith('/') ? path : `/${path}`}`;

  const idToken = await currentIdToken();
  if (!idToken) {
    throw new Error('not-signed-in');
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${idToken}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && !opts.refreshToken) {
    // One retry with a force-refreshed token — covers the expiry race.
    try {
      const user = getAuth().currentUser;
      const fresh = user ? await user.getIdToken(true) : null;
      if (fresh) {
        return await fetch(url, {
          ...opts,
          headers: { ...headers, authorization: `Bearer ${fresh}` },
        });
      }
    } catch { /* fall through with the original 401 */ }
  }
  return res;
}
