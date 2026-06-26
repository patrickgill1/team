// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../../utils/firebase';

/**
 * Small soft banner that nudges email/password users to verify
 * their email. Hidden for users who already verified, for users
 * who signed in via Google/Apple (those are implicitly verified
 * via the OAuth provider), and for the session if they dismissed
 * it. Resend cooldown so a button-masher can't rate-limit
 * themselves out of Firebase.
 *
 * Placement: top of the dashboard. Not blocking — we don't gate
 * any features on verification yet, just nudge. Gating can come
 * later for high-trust surfaces (registrations, payouts).
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
        <svg className="w-4 h-4 text-amber-300 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </svg>
        <p className="text-amber-100 flex-1 min-w-0 truncate">
          {sentAt
            ? <>Verification email sent to <span className="font-mono text-amber-200">{user.email}</span>. Check your inbox.</>
            : <>Please verify <span className="font-mono text-amber-200">{user.email}</span> to confirm your account.</>}
        </p>
        <button
          type="button"
          onClick={handleResend}
          disabled={sending || !canResend}
          className="text-amber-100 hover:text-white text-xs font-bold underline disabled:opacity-50 whitespace-nowrap"
        >
          {sending ? 'Sending…' : sentAt ? 'Resend' : 'Send verification'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-amber-200/65 hover:text-amber-100 text-xs font-bold whitespace-nowrap"
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
