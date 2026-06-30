// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useTrialGate } from '../../hooks/useTrialGate';
import TierPickerSheet from '../common/TierPickerSheet';

// Persistent dashboard nudge for coaches without an active
// subscription. Dismissable; auto-reappears after 7 days so a
// distracted coach doesn't forget the offer forever. Hidden
// entirely for parents (who use GoalKickr free anyway), for
// subscribed coaches, and for the user who just dismissed it
// within the cooldown window.
//
// Wording mirrors the Apple-safe pattern: explicit "Subscribe at
// goalkickr.com" copy + system-browser handoff, never an in-app
// payment trigger.

const DISMISS_KEY = 'gk_dashboard_sub_dismissed_at';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GATE_REVEAL_DELAY_MS = 3000;

const SubscribeBanner: React.FC = () => {
  const { currentUser, userData } = useAuth();
  const { loading, gated } = useTrialGate();
  const [dismissed, setDismissed] = useState(false);
  const [tierSheet, setTierSheet] = useState(false);
  const [readyToReveal, setReadyToReveal] = useState(false);

  useEffect(() => {
    try {
      const at = Number(window.localStorage.getItem(DISMISS_KEY) || 0);
      if (at && Date.now() - at < DISMISS_COOLDOWN_MS) setDismissed(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (loading || !gated) {
      setReadyToReveal(false);
      return;
    }
    const timer = window.setTimeout(() => setReadyToReveal(true), GATE_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading, gated]);

  if (loading) return null;
  if (!userData) return null;
  if (!gated) return null;
  if (!readyToReveal) return null;
  if (dismissed) return null;

  // Open the tier picker first so a coach running a multi-team
  // club can pick Club instead of being railroaded into Coach.
  const handleStart = () => setTierSheet(true);

  const handleDismiss = () => {
    try { window.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div className="relative rounded-2xl bg-gradient-to-br from-brand-primary-deep/40 via-surface-elevated to-surface-elevated ring-1 ring-brand-primary/40 p-4 sm:p-5 overflow-hidden">
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full text-ink-primary/50 hover:text-ink-primary hover:bg-line-default/5 flex items-center justify-center transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>

      <div className="flex items-start gap-3 sm:gap-4">
        <div className="shrink-0 w-10 h-10 rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/40 flex items-center justify-center">
          <svg className="w-5 h-5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">
            Free version
          </p>
          <p className="text-ink-primary font-bold leading-tight">
            Start your 7-day free trial.
          </p>
          <p className="text-charcoal-300 text-sm mt-1.5 leading-snug">
            Keep everything you&apos;ve built and unlock the full coach toolkit.
            Cancel anytime. Trial billing happens on goalkickr.com.
          </p>
          <button
            type="button"
            onClick={handleStart}
            className="mt-3 inline-flex items-center justify-center px-4 py-2 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white shadow-lg shadow-brand-primary-dim/40 ring-1 ring-brand-primary-soft/20 transition"
          >
            Start free trial at goalkickr.com
          </button>
        </div>
      </div>

      <TierPickerSheet
        open={tierSheet}
        onClose={() => setTierSheet(false)}
        email={currentUser?.email || userData?.email || undefined}
        uid={currentUser?.uid}
        intent="subscribe"
      />
    </div>
  );
};

export default SubscribeBanner;
