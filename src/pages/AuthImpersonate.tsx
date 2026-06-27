import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';

/**
 * Admin-impersonation entry point. Opened by the goalkickr-admin
 * portal's "Sign in as user" button. The portal mints a Firebase
 * custom token via the Admin SDK and links here as:
 *
 *   https://goalkickr.com/auth/impersonate?token=<custom-token>
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

const AuthImpersonate: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (!token) {
        setError('Missing token. This page is opened by the admin portal — not directly.');
        return;
      }
      const auth = getAuth();
      try {
        // Sign out cleanly first. Without this, signInWithCustomToken
        // throws when there's already an authed user in a different
        // identity.
        if (auth.currentUser) {
          await signOut(auth);
        }
        if (cancelled) return;
        const cred = await signInWithCustomToken(auth, token);
        if (cancelled) return;
        // Drop the token out of the URL so a copy-paste of the
        // address bar doesn't leak it.
        window.history.replaceState({}, '', '/dashboard');
        // Tiny delay so AuthContext can sync userData before the
        // dashboard mounts — avoids the empty-state flash.
        setTimeout(() => {
          if (!cancelled) navigate('/dashboard', { replace: true });
        }, 250);
        console.log('[impersonate] signed in as', cred.user.uid);
      } catch (err: any) {
        console.error('[impersonate] sign-in failed', err);
        setError(err?.message || 'Impersonation token rejected. It may have expired (1h TTL) or been used already.');
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-charcoal-950 text-bone px-6">
      <div className="max-w-md w-full text-center">
        {error ? (
          <>
            <p className="text-rose-300 font-bold mb-2">Couldn't sign in</p>
            <p className="text-bone/65 text-sm">{error}</p>
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
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-white/20 border-t-white mb-3" aria-hidden />
            <p className="text-bone font-bold">Signing in as the user…</p>
            <p className="text-bone/55 text-sm mt-1">Audit-logged on the admin portal.</p>
          </>
        )}
      </div>
    </div>
  );
};

export default AuthImpersonate;
