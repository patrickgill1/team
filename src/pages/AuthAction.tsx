// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { applyActionCode, checkActionCode, confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { auth } from '../utils/firebase';

/**
 * Branded handler for Firebase Auth action links (email verification,
 * password reset, etc). Lives at /auth/action so the worker can
 * rewrite Firebase's <project>.firebaseapp.com URL to our domain
 * without losing the oobCode in the query string.
 *
 * Replaces the default Firebase hosted page (which says
 * 'soccer-team-app-7f6b4...' all over it) with a GoalKickr-branded
 * success / failure screen + a clear 'Open the app' CTA.
 *
 * Supported modes:
 *   verifyEmail     — apply the action, mark user.emailVerified=true
 *   resetPassword   — show password form, confirm with new password
 *   recoverEmail    — apply (rare; honored for completeness)
 */

type Mode = 'verifyEmail' | 'resetPassword' | 'recoverEmail';
type Status = 'loading' | 'success' | 'error' | 'awaiting-password';

const AuthAction: React.FC = () => {
  const [params] = useSearchParams();
  const mode = (params.get('mode') || '') as Mode;
  const oobCode = params.get('oobCode') || '';
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [emailForReset, setEmailForReset] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    if (!mode || !oobCode) {
      setStatus('error');
      setError('This link is missing required information. Try the original email again, or request a new one.');
      return;
    }

    if (mode === 'verifyEmail' || mode === 'recoverEmail') {
      applyActionCode(auth, oobCode)
        .then(() => setStatus('success'))
        .catch((e: any) => {
          setStatus('error');
          setError(friendly(e?.code || ''));
        });
      return;
    }

    if (mode === 'resetPassword') {
      // Two-step: verify the code first to surface a friendly error
      // BEFORE asking the user for a new password.
      verifyPasswordResetCode(auth, oobCode)
        .then((email) => {
          setEmailForReset(email);
          setStatus('awaiting-password');
        })
        .catch((e: any) => {
          setStatus('error');
          setError(friendly(e?.code || ''));
        });
      return;
    }

    setStatus('error');
    setError(`This action type ('${mode}') isn't supported yet.`);
  }, [mode, oobCode]);

  const handleResetPassword = async () => {
    if (pwBusy) return;
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setPwBusy(true); setError(null);
    try {
      await confirmPasswordReset(auth, oobCode, newPassword);
      setStatus('success');
    } catch (e: any) {
      setError(friendly(e?.code || ''));
    } finally {
      setPwBusy(false);
    }
  };

  // Deep-link target for 'Open the app' button. Universal links would
  // open the native app directly; without them we fall back to the
  // web origin and let Safari's smart app banner suggest the app.
  const openAppUrl = window.location.origin || 'https://firefc.app';

  return (
    <div className="min-h-screen bg-gradient-to-b from-charcoal-950 via-charcoal-900 to-charcoal-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-6 flex justify-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-primary/15 ring-1 ring-brand-primary/30 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6 text-brand-primary-soft">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>
        <p className="text-[10px] font-extrabold tracking-[0.25em] uppercase text-brand-primary-soft mb-2">GoalKickr</p>

        {status === 'loading' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">One moment…</h1>
            <p className="text-bone/55 text-sm">Verifying your link.</p>
          </>
        )}

        {status === 'success' && mode === 'verifyEmail' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">Email verified.</h1>
            <p className="text-bone/65 text-sm mb-6">
              You're all set. Head back to the app — your account is ready.
            </p>
            <a
              href={openAppUrl}
              className="inline-block bg-brand-primary hover:bg-brand-primary-soft hover:text-charcoal-950 text-white font-bold px-6 py-3 rounded-xl transition"
            >
              Open GoalKickr
            </a>
          </>
        )}

        {status === 'success' && mode === 'resetPassword' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">Password updated.</h1>
            <p className="text-bone/65 text-sm mb-6">
              Sign in with your new password.
            </p>
            <a
              href={openAppUrl + '/auth'}
              className="inline-block bg-brand-primary hover:bg-brand-primary-soft hover:text-charcoal-950 text-white font-bold px-6 py-3 rounded-xl transition"
            >
              Open GoalKickr
            </a>
          </>
        )}

        {status === 'success' && mode === 'recoverEmail' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">Email change reverted.</h1>
            <p className="text-bone/65 text-sm mb-6">Your account email is back to the previous address.</p>
            <a href={openAppUrl} className="inline-block bg-brand-primary text-white font-bold px-6 py-3 rounded-xl">Open GoalKickr</a>
          </>
        )}

        {status === 'awaiting-password' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">Set a new password.</h1>
            <p className="text-bone/55 text-sm mb-5">For <span className="text-bone font-mono text-xs">{emailForReset}</span></p>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (8+ chars)"
              autoComplete="new-password"
              className="w-full bg-charcoal-900 border border-white/10 rounded-lg px-3 py-3 text-bone placeholder:text-bone/30 focus:outline-none focus:border-brand-primary"
            />
            <button
              onClick={handleResetPassword}
              disabled={pwBusy || newPassword.length < 8}
              className="mt-3 w-full bg-brand-primary hover:bg-brand-primary-soft hover:text-charcoal-950 disabled:opacity-50 text-white font-bold rounded-lg py-3 transition"
            >
              {pwBusy ? 'Updating…' : 'Update password'}
            </button>
            {error && (
              <p className="mt-3 text-rose-300 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{error}</p>
            )}
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className="text-2xl font-black text-bone mb-2">Something's not right.</h1>
            <p className="text-bone/65 text-sm mb-6">{error}</p>
            <Link to="/auth" className="inline-block bg-brand-primary text-white font-bold px-6 py-3 rounded-xl">
              Open GoalKickr
            </Link>
          </>
        )}
      </div>
    </div>
  );
};

function friendly(code: string): string {
  switch (code) {
    case 'auth/expired-action-code':
      return 'This link has expired. Request a fresh one from the app.';
    case 'auth/invalid-action-code':
      return "This link isn't valid anymore. It may already have been used or expired.";
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact support@goalkickr.com.';
    case 'auth/user-not-found':
      return "We couldn't find an account for this link.";
    case 'auth/weak-password':
      return 'Pick a stronger password (8+ characters).';
    default:
      return 'The link could not be processed. Try again or request a new one.';
  }
}

export default AuthAction;
