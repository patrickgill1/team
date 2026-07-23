import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';

/**
 * Admin-impersonation entry point. Opened by the goalkickr-admin
 * portal's "Sign in as user" button. The portal mints a Firebase
 * custom token via the Admin SDK and links here as:
 *
 *   https://app.goalkickr.com/auth/impersonate?token=<custom-token>
 *
 * This page:
 *   1. Signs out any currently-authed user (so the impersonation
 *      cleanly replaces the session — without this, Firebase Auth
 *      refuses to switch identities).
 *   2. Calls signInWithCustomToken() with the supplied token.
 *   3. Redirects to /dashboard.
 *
 * Token TTL is ~1 hour per Firebase Auth defaults; once consumed,
 * the resulting session lives as long as any other signed-in
 * session. Every mint is audit-logged in admin_actions on the
 * portal side.
 *
 * USE A DIFFERENT BROWSER OR INCOGNITO WINDOW if you want to keep
 * your own admin session open elsewhere — this page replaces the
 * current auth state in the browser it's opened in.
 */

// Race helper — signInWithCustomToken has historically hung with no
// rejection when Firebase Auth's IndexedDB persistence layer stalls
// or when a prior signOut left the SDK in a half-torn-down state.
// Wrapping in a timeout guarantees the user sees an actionable error
// instead of a permanent spinner.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { window.clearTimeout(t); resolve(v); }, e => { window.clearTimeout(t); reject(e); });
  });
}

const AuthImpersonate: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Ref-guard against React 18 StrictMode double-mount consuming the
  // one-shot custom token twice (Firebase rejects the second call and
  // we ended up in a permanent spinner because the reject won the
  // race with cancelled).
  const startedRef = React.useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      console.log('[impersonate] mount, token length:', token?.length || 0);
      if (!token) {
        setError('Missing token. This page is opened by the admin portal, not directly.');
        return;
      }
      const auth = getAuth();
      console.log('[impersonate] current user before signOut:', auth.currentUser?.uid || '(none)');
      try {
        // Sign out cleanly first. Without this, signInWithCustomToken
        // throws when there's already an authed user in a different
        // identity.
        if (auth.currentUser) {
          console.log('[impersonate] signing out current user');
          await withTimeout(signOut(auth), 8000, 'signOut');
          console.log('[impersonate] signOut resolved');
        }
        if (cancelled) return;
        console.log('[impersonate] calling signInWithCustomToken');
        const cred = await withTimeout(signInWithCustomToken(auth, token), 15000, 'signInWithCustomToken');
        console.log('[impersonate] signed in as', cred.user.uid);
        if (cancelled) return;
        // Drop the token out of the URL so a copy-paste of the
        // address bar doesn't leak it.
        window.history.replaceState({}, '', '/dashboard');
        // Tiny delay so AuthContext can sync userData before the
        // dashboard mounts, avoids the empty-state flash.
        setTimeout(() => {
          if (!cancelled) navigate('/dashboard', { replace: true });
        }, 250);
      } catch (err: any) {
        console.error('[impersonate] sign-in failed', err);
        setError(err?.message || 'Impersonation token rejected. It may have expired (1h TTL) or been used already.');
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base text-ink-primary px-6">
      <div className="max-w-md w-full text-center">
        {error ? (
          <>
            <p className="text-rose-300 font-bold mb-2">Couldn't sign in</p>
            <p className="text-ink-primary/65 text-sm">{error}</p>
            <button
              type="button"
              onClick={() => { window.location.href = '/'; }}
              className="mt-6 px-4 py-2 rounded-lg bg-brand-primary text-white text-sm font-bold"
            >
              Go to GoalKickr
            </button>
          </>
        ) : (
          <>
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-line-default/20 border-t-white mb-3" aria-hidden />
            <p className="text-ink-primary font-bold">Signing in as the user…</p>
            <p className="text-ink-primary/55 text-sm mt-1">Audit-logged on the admin portal.</p>
          </>
        )}
      </div>
    </div>
  );
};

export default AuthImpersonate;
