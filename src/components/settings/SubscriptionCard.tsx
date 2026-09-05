// @ts-nocheck
import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useFirestore } from '../../hooks/useFirestore';
import { useSubscription } from '../../hooks/useSubscription';
import { useTeam } from '../../contexts/TeamContext';
import { openCustomerPortal, openWebSignup, isAppleDevice, cancelSubscription, reactivateSubscription } from '../../utils/subscriptionApi';
import TierPickerSheet from '../common/TierPickerSheet';
import { Button, Pill } from '../ui';
import { useConfirm } from '../common/ConfirmDialog';

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
  const { teams } = useTeam();
  // Only offer teams the caller actually coaches for the attach-video
  // picker. The attach-team worker endpoint enforces the same rule,
  // but hiding non-eligible teams in the UI keeps the picker honest.
  const uid = (currentUser as any)?.uid;
  const coachTeams = React.useMemo(
    () => (Array.isArray(teams) ? teams : []).filter((t: any) =>
      Array.isArray(t.coachIds) && uid && t.coachIds.includes(uid) && t.isActive !== false
    ),
    [teams, uid],
  );
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
  const confirm = useConfirm();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  // Resync state — fixes "subscribed via Stripe portal, app shows
  // stale plan / video upload blocked" per 2026-09-05 Patrick report.
  const [resyncBusy, setResyncBusy] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [resyncMessage, setResyncMessage] = useState<string | null>(null);
  const [unattachedVideoSubs, setUnattachedVideoSubs] = useState<Array<{
    id: string; videoTier: string; status: string; currentPeriodEnd: number;
  }>>([]);
  const [attachBusyId, setAttachBusyId] = useState<string | null>(null);
  const [attachPickerId, setAttachPickerId] = useState<string | null>(null);
  const [attachTeamId, setAttachTeamId] = useState<string>('');

  const handleResync = async () => {
    setResyncBusy(true);
    setResyncError(null);
    setResyncMessage(null);
    try {
      const { workerFetch } = await import('../../utils/workerFetch');
      const res = await workerFetch('/subscriptions/resync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setResyncError(String(data?.hint || data?.error || `Request failed (${res.status})`));
        return;
      }
      const attached = (data.summary || []).filter((s: any) => s.synced).length;
      const unatt = data.unattachedVideoSubs || [];
      setUnattachedVideoSubs(unatt);
      const msgs: string[] = [];
      if (attached > 0) msgs.push(`Synced ${attached} ${attached === 1 ? 'subscription' : 'subscriptions'} from Stripe.`);
      if (unatt.length > 0) msgs.push(`${unatt.length} Media ${unatt.length === 1 ? 'plan' : 'plans'} still need a team assigned — see below.`);
      if (msgs.length === 0) msgs.push('Nothing to sync — you already look up to date.');
      setResyncMessage(msgs.join(' '));
    } catch (err) {
      setResyncError(String((err as any)?.message || err));
    } finally {
      setResyncBusy(false);
    }
  };

  const handleAttachTeam = async (subscriptionId: string, teamId: string) => {
    if (!subscriptionId || !teamId) return;
    setAttachBusyId(subscriptionId);
    try {
      const { workerFetch } = await import('../../utils/workerFetch');
      const res = await workerFetch('/video-subscriptions/attach-team', {
        method: 'POST',
        body: JSON.stringify({ subscriptionId, teamId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setResyncError(String(data?.hint || data?.error || 'Attach failed'));
        return;
      }
      setUnattachedVideoSubs(prev => prev.filter(s => s.id !== subscriptionId));
      setAttachPickerId(null);
      setAttachTeamId('');
      setResyncMessage('Media plan attached. Force-close and reopen the app to see uploads unlock on that team.');
    } catch (err) {
      setResyncError(String((err as any)?.message || err));
    } finally {
      setAttachBusyId(null);
    }
  };

  const knownEmail = (currentUser?.email || userData?.email || '').trim();

  const handleManage = async () => {
    if (!subscription?.customerId) return;
    setOpening(true);
    setPortalError(null);
    const err = await openCustomerPortal({ customerId: subscription.customerId });
    setOpening(false);
    if (err) setPortalError('Could not open the billing portal. Try again in a moment.');
  };

  const handleCancel = async () => {
    if (!subscription?.subscriptionId) return;
    const label = renewsAt ? `You'll keep access until ${renewsAt}. ` : '';
    if (!(await confirm({
      title: 'Cancel your subscription?',
      body: `${label}You can reactivate any time before then.`,
      destructive: true,
      confirmText: 'Cancel subscription',
      cancelText: 'Keep it',
    }))) return;
    setCancelBusy(true);
    setCancelError(null); setCancelMessage(null);
    const err = await cancelSubscription({ subscriptionId: subscription.subscriptionId, atPeriodEnd: true });
    setCancelBusy(false);
    if (err) setCancelError('Could not cancel. Try again in a moment.');
    else setCancelMessage(renewsAt ? `Canceled. Access continues until ${renewsAt}.` : 'Canceled.');
  };

  const handleReactivate = async () => {
    if (!subscription?.subscriptionId) return;
    setReactivateBusy(true);
    setCancelError(null); setCancelMessage(null);
    const err = await reactivateSubscription({ subscriptionId: subscription.subscriptionId });
    setReactivateBusy(false);
    if (err) setCancelError('Could not reactivate. Try again in a moment.');
    else setCancelMessage('Reactivated. Your subscription will renew as normal.');
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
        className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl p-5 sm:p-6 w-full max-w-md space-y-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1.5">
            One quick thing
          </p>
          <h3 className="text-ink-primary text-lg font-bold leading-tight">
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
            className="mt-1 w-full rounded-md bg-surface-base ring-1 ring-line-default/10 focus:ring-brand-primary focus:outline-none px-3 py-2.5 text-ink-primary placeholder-charcoal-500"
            onKeyDown={e => { if (e.key === 'Enter' && !emailSaving) handleEmailConfirm(); }}
          />
        </label>
        {emailError && (
          <div className="rounded-md bg-brand-primary-deep/40 ring-1 ring-brand-primary/40 px-3 py-2 text-brand-primary-soft text-xs">
            {emailError}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setEmailIntent(null)}
            disabled={emailSaving}
            className="px-4 py-2.5 rounded-md font-bold text-sm ring-1 ring-line-default/15 text-ink-primary hover:bg-line-default/5 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEmailConfirm}
            disabled={emailSaving || !emailDraft.trim()}
            className="px-4 py-2.5 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white transition disabled:opacity-60 disabled:cursor-wait"
          >
            {emailSaving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm p-4">
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
        <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm p-4 space-y-3">
          <div>
            <p className="text-ink-primary font-bold">Coach with GoalKickr</p>
            <p className="text-charcoal-300 text-sm mt-1">
              You&apos;re using GoalKickr for free. Coaches unlock the full toolkit (chat, RSVPs, gameday, dev plans) with a Team plan starting at $9.99/mo.
              {!isAppleDevice() && ' Founding Coach pricing locks in $4.99/mo forever.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSubscribe}
            className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-md font-bold bg-brand-primary hover:bg-brand-primary text-white transition-all"
          >
            Subscribe at goalkickr.com
          </button>
          {/* Portal-purchase resync — same button that lives on the
              active-sub branch. Anyone landing on this "free" state
              might actually have a live Stripe sub the app hasn't
              picked up (portal purchase, email mismatch, wiped doc
              after webhook rebuild). One tap syncs from Stripe. */}
          <div className="pt-2 border-t border-line-default/10">
            <p className="text-[11px] text-ink-primary/55 leading-snug">
              Already subscribed on goalkickr.com or in Stripe? Sync it here.
            </p>
            <button
              type="button"
              onClick={handleResync}
              disabled={resyncBusy}
              className="mt-2 w-full text-xs font-bold py-2 text-ink-primary/70 hover:text-ink-primary hover:bg-line-default/[0.05] rounded-lg transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {resyncBusy ? 'Refreshing…' : 'Refresh from Stripe'}
            </button>
            {resyncMessage && (
              <p className="mt-2 text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 leading-snug">
                {resyncMessage}
              </p>
            )}
            {resyncError && (
              <p className="mt-2 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 leading-snug">
                {resyncError}
              </p>
            )}
            {unattachedVideoSubs.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">
                  Media plans to attach
                </p>
                {unattachedVideoSubs.map((sub) => (
                  <div key={sub.id} className="rounded-lg bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-ink-primary">
                          Media plan · {sub.videoTier === 'pro' ? 'Full Game Film' : 'Highlight Add-on'}
                        </p>
                        <p className="text-[11px] text-ink-primary/55">Status: {sub.status}</p>
                      </div>
                      {attachPickerId !== sub.id && (
                        <button
                          type="button"
                          onClick={() => { setAttachPickerId(sub.id); setAttachTeamId(''); }}
                          className="px-3 py-1.5 rounded-full bg-brand-primary/15 hover:bg-brand-primary/25 text-brand-primary text-[11px] font-black uppercase tracking-widest transition"
                        >
                          Attach to team
                        </button>
                      )}
                    </div>
                    {attachPickerId === sub.id && (
                      <div className="mt-3 space-y-2">
                        <select
                          value={attachTeamId}
                          onChange={(e) => setAttachTeamId(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/15 text-ink-primary text-sm outline-none focus:ring-brand-primary-soft"
                        >
                          <option value="">Choose a team…</option>
                          {coachTeams.map((t: any) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => { setAttachPickerId(null); setAttachTeamId(''); }}
                            className="px-3 py-1.5 text-xs font-bold text-ink-primary/60 hover:text-ink-primary"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAttachTeam(sub.id, attachTeamId)}
                            disabled={!attachTeamId || attachBusyId === sub.id}
                            className="px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-black uppercase tracking-widest hover:bg-brand-primary/90 disabled:opacity-40 transition" /* theme-ok: brand CTA */
                          >
                            {attachBusyId === sub.id ? 'Attaching…' : 'Attach'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
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
    <div className="bg-surface-elevated rounded-xl border border-line-default/10 shadow-sm p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-ink-primary font-bold">{tierLabel}</p>
          <p className="text-charcoal-300 text-sm mt-1">
            {tierPrice}
            {willCancelAtPeriodEnd && renewsAt && ` · ends ${renewsAt}`}
            {!willCancelAtPeriodEnd && renewsAt && ` · renews ${renewsAt}`}
            {isTrialing && ' · in trial'}
          </p>
        </div>
        <Pill
          tone={isPastDue ? 'amber' : willCancelAtPeriodEnd ? 'neutral' : 'emerald'}
          size="sm"
          dot
        >
          {isPastDue ? 'Past due' : willCancelAtPeriodEnd ? 'Canceling' : isTrialing ? 'Trial' : 'Active'}
        </Pill>
      </div>

      {isPastDue && (
        <div className="rounded-md bg-amber-950/40 ring-1 ring-amber-700/40 px-3 py-2 text-amber-100 text-xs">
          Your last payment failed. Update your card at goalkickr.com to keep your subscription active.
        </div>
      )}

      {portalError && (
        <div className="rounded-md bg-brand-primary-deep/40 ring-1 ring-brand-primary/40 px-3 py-2 text-brand-primary-soft text-xs">
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
          className="w-full text-left rounded-lg bg-gradient-to-br from-brand-primary-deep/40 to-surface-elevated ring-1 ring-brand-primary/40 hover:ring-brand-primary/60 transition px-3 py-2.5"
        >
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">
            Running multiple teams?
          </p>
          <p className="text-ink-primary text-sm font-bold leading-tight">
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
          className="w-full text-left rounded-lg bg-gradient-to-br from-brand-primary-deep/40 to-surface-elevated ring-1 ring-brand-primary/40 hover:ring-brand-primary/60 transition px-3 py-2.5"
        >
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-0.5">
            Need integrations?
          </p>
          <p className="text-ink-primary text-sm font-bold leading-tight">
            Upgrade to Club Pro at goalkickr.com →
          </p>
          <p className="text-charcoal-300 text-[11px] mt-1 leading-snug">
            Sports Affinity sync, registration onboarding, dedicated support. $499/yr.
          </p>
        </button>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <Button
          variant="primary"
          onClick={handleManage}
          disabled={!subscription?.customerId}
          loading={opening}
          fullWidth
        >
          Manage subscription
        </Button>
        <Button variant="outline" onClick={handleUpgrade} fullWidth>
          Change plan
        </Button>
      </div>

      {/* In-app cancel / reactivate. Kept SEPARATE from the primary
          buttons so the destructive path doesn't sit next to Change
          plan. Cancel defaults to at-period-end so the coach keeps
          what they've already paid for. Reactivate is only meaningful
          when cancel_at_period_end is set and the window hasn't
          closed. Both hit /stripe/subscription-cancel and
          /stripe/subscription-reactivate on the worker; Stripe's
          webhook handles the subscriptions/{uid} update. */}
      {subscription?.subscriptionId && (
        <div className="pt-1">
          {willCancelAtPeriodEnd ? (
            <button
              type="button"
              onClick={handleReactivate}
              disabled={reactivateBusy}
              className="w-full text-sm font-bold py-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/30 transition-colors disabled:opacity-50"
            >
              {reactivateBusy ? 'Reactivating…' : 'Reactivate subscription'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelBusy || !isActive}
              className="w-full text-xs font-bold py-2 text-rose-300 hover:text-rose-200 hover:bg-rose-500/10 rounded-lg transition-colors disabled:opacity-50"
            >
              {cancelBusy ? 'Canceling…' : 'Cancel subscription'}
            </button>
          )}
          {cancelMessage && (
            <p className="mt-2 text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
              {cancelMessage}
            </p>
          )}
          {cancelError && (
            <p className="mt-2 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
              {cancelError}
            </p>
          )}
        </div>
      )}

      {/* Refresh from Stripe — force-syncs subscription state when
          a portal purchase or cancel didn't propagate to Firestore.
          Also surfaces Media plans that need a team assigned. */}
      <div className="pt-2 border-t border-line-default/10">
        <button
          type="button"
          onClick={handleResync}
          disabled={resyncBusy}
          className="w-full text-xs font-bold py-2 text-ink-primary/65 hover:text-ink-primary hover:bg-line-default/[0.05] rounded-lg transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {resyncBusy ? 'Refreshing…' : 'Refresh from Stripe'}
        </button>
        {resyncMessage && (
          <p className="mt-2 text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 leading-snug">
            {resyncMessage}
          </p>
        )}
        {resyncError && (
          <p className="mt-2 text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 leading-snug">
            {resyncError}
          </p>
        )}
        {unattachedVideoSubs.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">
              Media plans to attach
            </p>
            {unattachedVideoSubs.map((sub) => (
              <div key={sub.id} className="rounded-lg bg-line-default/[0.04] ring-1 ring-line-default/10 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink-primary">
                      Media plan · {sub.videoTier === 'pro' ? 'Full Game Film' : 'Highlight Add-on'}
                    </p>
                    <p className="text-[11px] text-ink-primary/55">Status: {sub.status}</p>
                  </div>
                  {attachPickerId !== sub.id && (
                    <button
                      type="button"
                      onClick={() => { setAttachPickerId(sub.id); setAttachTeamId(''); }}
                      className="px-3 py-1.5 rounded-full bg-brand-primary/15 hover:bg-brand-primary/25 text-brand-primary text-[11px] font-black uppercase tracking-widest transition"
                    >
                      Attach to team
                    </button>
                  )}
                </div>
                {attachPickerId === sub.id && (
                  <div className="mt-3 space-y-2">
                    <select
                      value={attachTeamId}
                      onChange={(e) => setAttachTeamId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-surface-elevated ring-1 ring-line-default/15 text-ink-primary text-sm outline-none focus:ring-brand-primary-soft"
                    >
                      <option value="">Choose a team…</option>
                      {coachTeams.map((t: any) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => { setAttachPickerId(null); setAttachTeamId(''); }}
                        className="px-3 py-1.5 text-xs font-bold text-ink-primary/60 hover:text-ink-primary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAttachTeam(sub.id, attachTeamId)}
                        disabled={!attachTeamId || attachBusyId === sub.id}
                        className="px-3 py-1.5 rounded-full bg-brand-primary text-white text-[11px] font-black uppercase tracking-widest hover:bg-brand-primary/90 disabled:opacity-40 transition" /* theme-ok: brand CTA */
                      >
                        {attachBusyId === sub.id ? 'Attaching…' : 'Attach'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-charcoal-500 text-[11px] leading-snug pt-1">
        Cancel any time in the app. Plan changes and payment method updates open goalkickr.com in your system browser.
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
