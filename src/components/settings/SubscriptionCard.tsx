// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { useSubscription } from '../../hooks/useSubscription';
import { openCustomerPortal, openWebSignup, isAppleDevice } from '../../utils/subscriptionApi';
import TierPickerSheet from '../common/TierPickerSheet';

// Settings-page tile for the coach's GoalKickr subscription. Reads
// from subscriptions/{uid} in real-time (worker stamps the doc from
// Stripe webhooks).
//
// Three render states:
//   1. Active   — "Founding Coach · renews Jul 22, 2026 · Manage at goalkickr.com"
//   2. Past due — amber banner: "Payment failed. Update card at goalkickr.com"
//   3. None     — "Coach for free until you're ready. Subscribe at goalkickr.com →"
//
// Wording note: every CTA explicitly names goalkickr.com. Apple App
// Store reviewers grade these screens (and screenshots that include
// them) for anti-steering compliance. "Subscribe at goalkickr.com"
// reads as informational; "Subscribe" or "Upgrade" reads as an
// in-app payment trigger that would push us into IAP territory.
//
// Apple compliance:
//   - In-app upgrade flow opens goalkickr.com/signup in the system
//     browser. Stripe Checkout never renders inside the WebView.
//   - Manage flow opens the Stripe Customer Portal in the system
//     browser, which is allowed for account servicing under the
//     Reader/Service-app rules.

const TIER_LABEL: Record<string, string> = {
  founder: 'Founder Rate',
  annual: 'Coach Annual',
  monthly: 'Coach Monthly',
  club: 'Club',
  'club-pro': 'Club Pro',
  unknown: 'GoalKickr',
};

const TIER_PRICE: Record<string, string> = {
  founder: '$5/mo',
  annual: '$99/yr',
  monthly: '$10/mo',
  club: '$299/yr',
  'club-pro': '$499/yr',
};

function fmtDate(d: Date | null): string {
  if (!d) return '';
  try {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

const SubscriptionCard: React.FC = () => {
  const { currentUser, userData } = useAuth();
  const { updateDocument } = useFirestore();
  const { loading, subscription, isActive, isTrialing, isPastDue, willCancelAtPeriodEnd, tier, currentPeriodEndDate } = useSubscription();
  const [opening, setOpening] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  // Email-confirm sheet — only shown when both Firebase Auth and the
  // user doc are missing an email (Apple private-relay sign-in, etc).
  // Without an email Stripe receipts have nowhere to land + the
  // marketing-site signup form has to pop a second prompt, which is
  // a clunky two-step. Catching it here saves the trip.
  const [emailIntent, setEmailIntent] = useState<null | 'subscribe' | 'upgrade'>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  // Tier picker (Coach vs Club) opens BEFORE the email-prompt /
  // Safari handoff. pickerIntent tracks why the picker was opened
  // so we can route the chosen tier through the right downstream
  // step (email prompt OR direct openWebSignup).
  const [pickerIntent, setPickerIntent] = useState<null | 'subscribe' | 'upgrade'>(null);

  const knownEmail = (currentUser?.email || userData?.email || '').trim();

  const handleManage = async () => {
    if (!subscription?.customerId) return;
    setOpening(true);
    setPortalError(null);
    const err = await openCustomerPortal({ customerId: subscription.customerId });
    setOpening(false);
    if (err) setPortalError('Could not open the billing portal. Try again in a moment.');
  };

  const openSignupWith = (intent: 'subscribe' | 'upgrade', email: string, tier?: 'annual' | 'club') => {
    openWebSignup({
      email,
      uid: currentUser?.uid,
      intent,
      tier,
    });
  };

  // Step 1: open the tier picker so the coach chooses Coach vs Club.
  // The picker's onPick callback below routes their choice through
  // the email-prompt (if needed) and into openWebSignup.
  const requestSubscribe = (intent: 'subscribe' | 'upgrade') => {
    setPickerIntent(intent);
  };

  // Step 2 (from TierPickerSheet's onPick): the user chose a tier.
  // If we have an email on file go straight to Safari; otherwise
  // open the email-prompt modal first so the receipt has somewhere
  // to land.
  const handleTierPicked = (tier: 'annual' | 'club') => {
    const intent = pickerIntent || 'subscribe';
    setPickerIntent(null);
    if (knownEmail) {
      openSignupWith(intent, knownEmail, tier);
      return;
    }
    setEmailError(null);
    setEmailDraft('');
    setEmailIntent(intent);
    // Stash tier so the email-prompt's submit can forward it.
    setPendingTier(tier);
  };
  const [pendingTier, setPendingTier] = useState<null | 'annual' | 'club'>(null);

  const handleSubscribe = () => requestSubscribe('subscribe');
  const handleUpgrade = () => requestSubscribe('upgrade');

  const handleEmailConfirm = async () => {
    const email = emailDraft.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setEmailError('That email doesn\'t look right.');
      return;
    }
    setEmailSaving(true);
    try {
      // Persist on the user doc so we don't ask again next time and
      // so any other code path reading userData.email gets the value.
      if (currentUser?.uid) {
        await updateDocument('users', currentUser.uid, { email, updatedAt: new Date() });
      }
      const intent = emailIntent || 'subscribe';
      const tier = pendingTier || undefined;
      setEmailIntent(null);
      setPendingTier(null);
      openSignupWith(intent, email, tier);
    } catch (err: any) {
      setEmailError(String(err?.message || err));
    } finally {
      setEmailSaving(false);
    }
  };

  // Modal: shared across all render branches via a fragment wrapper
  // on each return. Renders only when emailIntent is set.
  const emailModal = emailIntent && (
    <div
      className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 animate-fade-in"
      onClick={() => !emailSaving && setEmailIntent(null)}
    >
      <div
        className="bg-charcoal-900 ring-1 ring-white/10 rounded-2xl p-5 sm:p-6 w-full max-w-md space-y-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-1.5">
            One quick thing
          </p>
          <h3 className="text-bone text-lg font-bold leading-tight">
            What email should we put on the receipt?
          </h3>
          <p className="text-charcoal-300 text-sm mt-2">
            We don&apos;t have an email on file for your account. Add one and we&apos;ll
            open goalkickr.com for checkout.
          </p>
        </div>
        <label className="block">
          <span className="text-charcoal-300 text-[11px] font-bold uppercase tracking-widest">Email</span>
          <input
            type="email"
            autoComplete="email"
            autoFocus
            value={emailDraft}
            onChange={e => setEmailDraft(e.target.value)}
            placeholder="you@example.com"
            className="mt-1 w-full rounded-md bg-charcoal-950 ring-1 ring-white/10 focus:ring-crimson-500 focus:outline-none px-3 py-2.5 text-bone placeholder-charcoal-500"
            onKeyDown={e => { if (e.key === 'Enter' && !emailSaving) handleEmailConfirm(); }}
          />
        </label>
        {emailError && (
          <div className="rounded-md bg-crimson-950/40 ring-1 ring-crimson-700/40 px-3 py-2 text-crimson-100 text-xs">
            {emailError}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setEmailIntent(null)}
            disabled={emailSaving}
            className="px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEmailConfirm}
            disabled={emailSaving || !emailDraft.trim()}
            className="px-4 py-2.5 rounded-md font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white transition disabled:opacity-60 disabled:cursor-wait"
          >
            {emailSaving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm p-4">
        <p className="text-charcoal-400 text-sm">Loading subscription…</p>
      </div>
    );
  }

  // No subscription on file. Two reasons to land here:
  //   - User has only ever used GoalKickr for free (parent, or trial coach)
  //   - Marketing-site signup wrote subscriptions/cus_xxx but Firebase
  //     uid hasn't been linked yet; the doc isn't reachable from this uid
  if (!subscription || !isActive && subscription?.status !== 'past_due') {
    return (
      <>
        <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm p-4 space-y-3">
          <div>
            <p className="text-bone font-bold">Coach with GoalKickr</p>
            <p className="text-charcoal-300 text-sm mt-1">
              You&apos;re using GoalKickr for free. Coaches unlock the full toolkit (chat, RSVPs, gameday, dev plans) with a Team plan starting at $9.99/mo.
              {!isAppleDevice() && ' Founding Coach pricing locks in $4.99/mo forever.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSubscribe}
            className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-md font-bold bg-crimson-600 hover:bg-crimson-500 text-white transition-all"
          >
            Subscribe at goalkickr.com
          </button>
        </div>
        {emailModal}
        <TierPickerSheet
          open={!!pickerIntent}
          onClose={() => setPickerIntent(null)}
          email={knownEmail || undefined}
          uid={currentUser?.uid}
          intent={pickerIntent || 'subscribe'}
          onPick={handleTierPicked}
        />
      </>
    );
  }

  const tierLabel = TIER_LABEL[tier || 'unknown'] || TIER_LABEL.unknown;
  const tierPrice = TIER_PRICE[tier || 'unknown'] || '';
  const renewsAt = fmtDate(currentPeriodEndDate);

  return (
    <>
    <div className="bg-charcoal-900 rounded-xl border border-white/10 shadow-sm p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-bone font-bold">{tierLabel}</p>
          <p className="text-charcoal-300 text-sm mt-1">
            {tierPrice}
            {willCancelAtPeriodEnd && renewsAt && ` · ends ${renewsAt}`}
            {!willCancelAtPeriodEnd && renewsAt && ` · renews ${renewsAt}`}
            {isTrialing && ' · in trial'}
          </p>
        </div>
        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest ${
          isPastDue ? 'bg-amber-900/40 text-amber-300 ring-1 ring-amber-700/40'
          : willCancelAtPeriodEnd ? 'bg-charcoal-800 text-charcoal-300 ring-1 ring-white/10'
          : 'bg-emerald-900/40 text-emerald-300 ring-1 ring-emerald-700/40'
        }`}>
          {isPastDue ? 'Past due' : willCancelAtPeriodEnd ? 'Canceling' : isTrialing ? 'Trial' : 'Active'}
        </span>
      </div>

      {isPastDue && (
        <div className="rounded-md bg-amber-950/40 ring-1 ring-amber-700/40 px-3 py-2 text-amber-100 text-xs">
          Your last payment failed. Update your card at goalkickr.com to keep your subscription active.
        </div>
      )}

      {portalError && (
        <div className="rounded-md bg-crimson-950/40 ring-1 ring-crimson-700/40 px-3 py-2 text-crimson-100 text-xs">
          {portalError}
        </div>
      )}

      {/* Contextual upgrade nudge — shown when the user is on a tier
          below their next logical step. Coach tiers see "running
          multiple teams? Upgrade to Club"; Club sees "Add integrations
          + onboarding? Upgrade to Club Pro". Club Pro sees nothing.
          Apple-safe: copy names goalkickr.com explicitly and the
          handler routes through TierPickerSheet → openWebSignup,
          which opens the system browser. */}
      {(tier === 'founder' || tier === 'annual' || tier === 'monthly') && (
        <button
          type="button"
          onClick={handleUpgrade}
          className="w-full text-left rounded-lg bg-gradient-to-br from-crimson-950/40 to-charcoal-900 ring-1 ring-crimson-700/40 hover:ring-crimson-500/60 transition px-3 py-2.5"
        >
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-0.5">
            Running multiple teams?
          </p>
          <p className="text-bone text-sm font-bold leading-tight">
            Upgrade to Club at goalkickr.com →
          </p>
          <p className="text-charcoal-300 text-[11px] mt-1 leading-snug">
            One subscription covers every team in your club. $299/yr, waived for clubs running $15K+/yr in registrations.
          </p>
        </button>
      )}
      {tier === 'club' && (
        <button
          type="button"
          onClick={handleUpgrade}
          className="w-full text-left rounded-lg bg-gradient-to-br from-crimson-950/40 to-charcoal-900 ring-1 ring-crimson-700/40 hover:ring-crimson-500/60 transition px-3 py-2.5"
        >
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400 mb-0.5">
            Need integrations?
          </p>
          <p className="text-bone text-sm font-bold leading-tight">
            Upgrade to Club Pro at goalkickr.com →
          </p>
          <p className="text-charcoal-300 text-[11px] mt-1 leading-snug">
            Sports Affinity sync, registration onboarding, dedicated support. $499/yr.
          </p>
        </button>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onClick={handleManage}
          disabled={opening || !subscription?.customerId}
          className="inline-flex items-center justify-center px-3 py-2.5 rounded-md font-bold text-sm bg-crimson-600 hover:bg-crimson-500 text-white shadow-lg shadow-crimson-900/40 transition-all disabled:opacity-50"
        >
          {opening ? 'Opening…' : 'Manage subscription'}
        </button>
        <button
          type="button"
          onClick={handleUpgrade}
          className="inline-flex items-center justify-center px-3 py-2.5 rounded-md font-bold text-sm ring-1 ring-white/15 text-bone hover:bg-white/5 transition-all"
        >
          Change plan
        </button>
      </div>
      <p className="text-charcoal-500 text-[11px] leading-snug pt-1">
        Billing, cancellation, and plan changes happen on goalkickr.com in your system browser.
      </p>
      {emailModal}
    </div>
    <TierPickerSheet
      open={!!pickerIntent}
      onClose={() => setPickerIntent(null)}
      email={knownEmail || undefined}
      uid={currentUser?.uid}
      intent={pickerIntent || 'upgrade'}
      onPick={handleTierPicked}
    />
    </>
  );
};

export default SubscriptionCard;
