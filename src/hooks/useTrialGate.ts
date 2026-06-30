// @ts-nocheck
import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { useSubscription } from './useSubscription';

// The trial wall, client side.
//
// Returns `{ gated, reason }` for any place that's about to perform a
// paid-feature action (create event, send announcement, add player,
// upload media, write a dev plan, etc.). When `gated` is true, the
// UI should swap the action for a friendly "Start your free trial"
// prompt instead of letting the click through.
//
// Defense in depth: firestore.rules ALSO checks
// userDoc.subscriptionActive via canCoachWrite(). The rule layer is
// the only thing that prevents a determined user from running the
// app in a custom client. This hook is the obvious-UX layer — it
// makes the gate visible and recoverable instead of a silent rules
// rejection.
//
// Gate logic:
//   - Not signed in -> no gate (sign-in is its own wall)
//   - Parent role -> never gated (parents don't pay)
//   - Platform admin (isClubAdmin) -> never gated (Patrick + comp accounts)
//   - Coach / team_manager with active subscription -> not gated
//   - Coach / team_manager without -> gated, must start trial
//
// Active = trialing OR active. Past_due / canceled / no doc -> gated.

const STABLE_GATE_REVEAL_DELAY_MS = 15000;

export interface TrialGateState {
  /** True when the current user is a coach without an active sub.
   *  CTAs should show "Start your free trial" instead of running. */
  gated: boolean;
  /** Human-readable reason. Shown in the upgrade modal title. */
  reason: 'none' | 'no-sub' | 'past-due' | 'canceled' | 'expired';
  /** True while subscription status is still loading. CTAs should
   *  stay enabled but no-op (or show a spinner) until this clears. */
  loading: boolean;
}

export function useTrialGate(): TrialGateState {
  const { userData } = useAuth();
  const { loading, subscription, isActive } = useSubscription();
  const [stableGateKey, setStableGateKey] = useState('');

  const baseState: TrialGateState = (() => {
    if (!userData) return { gated: false, reason: 'none', loading: false };

    const role = (userData as any)?.role;
    const isCoachRole = role === 'coach' || role === 'team_manager';
    const isPlatformAdmin = (userData as any)?.isClubAdmin === true;
    if (!isCoachRole || isPlatformAdmin) {
      return { gated: false, reason: 'none', loading: false };
    }
    // Coaches who joined via a club invite inherit coverage from the
    // club — the club owner is paying on behalf of the staff. Stamped
    // at invite-consume time (see consumeInvite in utils/invites.ts).
    // Default-solo "clubs" don't qualify; those are the implicit
    // wrapper around a one-coach team, and the owner pays on a Coach
    // tier, not Club tier.
    if ((userData as any).coverageSource === 'club') {
      return { gated: false, reason: 'none', loading: false };
    }
    if ((userData as any).subscriptionActive === true) {
      return { gated: false, reason: 'none', loading: false };
    }
    if (loading) return { gated: false, reason: 'none', loading: true };
    if (isActive) return { gated: false, reason: 'none', loading: false };

    const status = subscription?.status;
    const reason: TrialGateState['reason'] =
      status === 'past_due' ? 'past-due'
      : status === 'canceled' ? 'canceled'
      : !subscription ? 'no-sub'
      : 'expired';
    return { gated: true, reason, loading: false };
  })();

  const gateKey = baseState.gated
    ? `${(userData as any)?.uid || 'user'}:${baseState.reason}:${subscription?.status || 'missing'}`
    : '';

  useEffect(() => {
    if (!gateKey) {
      setStableGateKey('');
      return;
    }
    const timer = window.setTimeout(() => setStableGateKey(gateKey), STABLE_GATE_REVEAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [gateKey]);

  if (baseState.gated && stableGateKey !== gateKey) {
    return { gated: false, reason: 'none', loading: true };
  }

  return baseState;
}
