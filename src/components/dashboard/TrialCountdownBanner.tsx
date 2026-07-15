// @ts-nocheck
import React from 'react';
import { useAuth } from '../../hooks/useAuth';
import { openWebSignup } from '../../utils/subscriptionApi';

/**
 * Trial countdown banner. Shows on Dashboard for coaches on an
 * auto-trial (subscriptionSource starts with 'auto-trial-') so they
 * know their free access is finite and see a clear path to a paid
 * plan before day 8 silently locks them out of content creation.
 *
 * Escalates tone as expiry approaches:
 *   ≥5 days out  — subtle brand-primary "Free trial · N days left"
 *   2-4 days out — amber "Trial ends in N days — pick a plan"
 *   ≤1 day out   — rose "Trial ends today/tomorrow — pick a plan"
 *
 * Non-dismissible on purpose. Nudge conversion; a user who's
 * subscribed sees nothing (subscriptionSource is 'stripe' or unset).
 */

const TrialCountdownBanner: React.FC = () => {
  const { userData, currentUser } = useAuth();

  const source = String((userData as any)?.subscriptionSource || '');
  const active = !!(userData as any)?.subscriptionActive;
  const expiresRaw = (userData as any)?.subscriptionExpiresAt;

  // Only show for auto-trials — paying subscribers should never see
  // this. If subscriptionSource is missing (older accounts) or is
  // 'stripe' / 'manual', bail.
  if (!source.startsWith('auto-trial')) return null;
  if (!active) return null;

  const ms = expiresRaw?.toDate?.().getTime?.()
    ?? (expiresRaw instanceof Date ? expiresRaw.getTime() : null)
    ?? (typeof expiresRaw === 'string' ? Date.parse(expiresRaw) : null);
  if (!ms) return null;

  const daysLeft = Math.max(0, Math.ceil((ms - Date.now()) / (24 * 60 * 60 * 1000)));

  const tone: 'brand' | 'amber' | 'rose' =
    daysLeft <= 1 ? 'rose'
    : daysLeft <= 4 ? 'amber'
    : 'brand';

  const toneClasses = {
    brand: 'bg-brand-primary/15 ring-brand-primary-soft/30 text-brand-primary-soft',
    amber: 'bg-amber-500/15 ring-amber-400/40 text-amber-200',
    rose:  'bg-rose-500/15 ring-rose-400/40 text-rose-200',
  }[tone];

  const label =
    daysLeft <= 0 ? 'Trial ends today'
    : daysLeft === 1 ? 'Trial ends tomorrow'
    : `Free trial · ${daysLeft} days left`;

  const subLine =
    daysLeft <= 1 ? "Pick a plan to keep going — otherwise you'll lose write access."
    : daysLeft <= 4 ? "Pick a plan before it ends. Founder's deal locks in 50% off."
    : "You're on the founder's-deal free trial. Cancel anytime.";

  const cta = daysLeft <= 4 ? 'Pick a plan' : 'See plans';

  const handleClick = () => {
    openWebSignup({
      email: userData?.email || currentUser?.email || undefined,
      uid: userData?.uid,
      tier: 'founder',
      intent: 'subscribe',
    });
  };

  return (
    <div className={`rounded-2xl ring-1 ${toneClasses} px-4 py-3 mb-3 flex items-center gap-3`}>
      <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-black leading-tight">{label}</p>
        <p className="text-xs opacity-80 leading-snug mt-0.5">{subLine}</p>
      </div>
      <button
        type="button"
        onClick={handleClick}
        className="flex-shrink-0 px-3 py-1.5 rounded-full bg-charcoal-900 hover:bg-charcoal-800 ring-1 ring-line-default/20 text-white text-[11px] font-black tracking-widest uppercase transition"
      >
        {cta}
      </button>
    </div>
  );
};

export default TrialCountdownBanner;
