// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../../utils/firebase';

/**
 * Small soft banner that reminds email/password users to click the
 * verification link that was auto-sent on signup by
 * AuthContext.signUp → worker /auth/send-verification. Hidden for
 * users who already verified, for users who signed in via Google
 * or Apple (OAuth providers flag emailVerified:true), and for the
 * session if they dismissed it.
 *
 * Banner copy assumes the initial send already went out — Patrick
 * 2026-07-08: 'they won't know they have to click. it should be
 * automated as much as possible. let them verify from their email
 * without needing to do anything in app.' So the default state is
 * "check your inbox" (not "please send") and the CTA is "Resend"
 * (not "Send verification"). Resend cooldown protects the sender.
 *
 * Placement: top of the dashboard. Not blocking — we don't gate
 * any features on verification. Clicking the link in the inbox
 * plus a return to the app is the entire flow; on foreground the
 * banner self-dismisses via the reload() in the effect below.
 */

const DISMISS_KEY = 'gk_emailVerifyDismissedAt';
const RESEND_COOLDOWN_MS = 60_000;

const EmailVerifyBanner: React.FC = () => {
  const [user, setUser] = useState(auth.currentUser);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUser(auth.currentUser);
    const unsub = auth.onAuthStateChanged((u) => setUser(u));
    return () => unsub();
  }, []);

  // When the app returns to foreground (e.g. user just clicked the
  // verification link in their browser, then switched back to the
  // app), reload the auth user to pick up emailVerified=true so the
  // banner self-dismisses without a manual refresh. Patrick: 'I had
  // to force close the app to get the email send verification to go
  // away.'
  useEffect(() => {
    const reloadIfPossible = () => {
      const u = auth.currentUser;
      if (!u || u.emailVerified) return;
      u.reload().then(() => setUser(auth.currentUser)).catch(() => {});
    };

    // Web: focus/visibilitychange covers the "switched tabs back"
    // case. The Capacitor App listener below covers native.
    window.addEventListener('focus', reloadIfPossible);
    document.addEventListener('visibilitychange', reloadIfPossible);

    let nativeRemove: (() => void) | null = null;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', (state: any) => {
          if (state.isActive) reloadIfPossible();
        });
        nativeRemove = () => { sub.remove?.(); };
      } catch { /* not native or plugin missing */ }
    })();

    return () => {
      window.removeEventListener('focus', reloadIfPossible);
      document.removeEventListener('visibilitychange', reloadIfPossible);
      nativeRemove?.();
    };
  }, []);

  useEffect(() => {
    try {
      const ts = parseInt(sessionStorage.getItem(DISMISS_KEY) || '0', 10);
      if (ts && Date.now() - ts < 24 * 3600_000) setDismissed(true);
    } catch { /* ignore */ }
  }, []);

  if (!user) return null;
  if (user.emailVerified) return null;
  if (dismissed) return null;
  // OAuth providers (Google / Apple) flag emailVerified=true by
  // default. Anyone unverified here is the email/password path.
  // Belt + suspenders: also skip if providerData says google/apple.
  const isOauth = (user.providerData || []).some(
    (p: any) => p.providerId === 'google.com' || p.providerId === 'apple.com',
  );
  if (isOauth) return null;

  const canResend = !sentAt || (Date.now() - sentAt) > RESEND_COOLDOWN_MS;

  const handleResend = async () => {
    if (sending || !canResend) return;
    setSending(true); setError(null);
    try {
      await sendEmailVerification(user);
      setSentAt(Date.now());
    } catch (e: any) {
      setError(e?.message || 'Could not send. Try again.');
    } finally {
      setSending(false);
    }
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div className="bg-amber-500/15 border-y border-amber-400/30 px-4 py-2.5">
      <div className="max-w-4xl mx-auto flex items-center gap-3 text-sm">
        <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </svg>
        <p className="text-amber-800 flex-1 min-w-0 truncate">
          {sentAt
            ? <>Sent again to <span className="font-mono text-amber-900">{user.email}</span>. Check your inbox.</>
            : <>Verification email sent to <span className="font-mono text-amber-900">{user.email}</span>. Just tap the link.</>}
        </p>
        <button
          type="button"
          onClick={handleResend}
          disabled={sending || !canResend}
          className="text-amber-800 hover:text-amber-900 text-xs font-bold underline disabled:opacity-50 whitespace-nowrap"
        >
          {sending ? 'Sending…' : 'Resend'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-amber-700/70 hover:text-amber-900 text-xs font-bold whitespace-nowrap"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {error && (
        <p className="max-w-4xl mx-auto mt-1 text-rose-300 text-xs">{error}</p>
      )}
    </div>
  );
};

export default EmailVerifyBanner;
