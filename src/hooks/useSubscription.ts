// @ts-nocheck
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from './useAuth';

// Live subscription state for the current user. Backed by the
// `subscriptions/{uid}` Firestore doc that the Cloudflare worker
// stamps in response to Stripe webhook events.
//
// Returns:
//   { loading, subscription, isActive, isTrialing, isPastDue,
//     willCancelAt, tier, manageHref }
//
// Doc id is the user's uid. Read rules in firestore.rules let the
// owner read their own doc and deny everyone else. The doc may also
// be absent — those users haven't subscribed yet.

export interface SubscriptionDoc {
  userId?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
  subscriptionId?: string | null;
  priceId?: string | null;
  productId?: string | null;
  tier?: 'annual' | 'monthly' | 'founder' | 'club' | 'club-pro' | 'unknown' | null;
  status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid' | string;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: any;  // Firestore Timestamp
  startedAt?: any;
  canceledAt?: any;
  trialEnd?: any;
  referralSource?: string | null;
  createdAt?: any;
  updatedAt?: any;
}

interface SubscriptionState {
  loading: boolean;
  subscription: SubscriptionDoc | null;
  isActive: boolean;
  isTrialing: boolean;
  isPastDue: boolean;
  willCancelAtPeriodEnd: boolean;
  tier: SubscriptionDoc['tier'] | null;
  currentPeriodEndDate: Date | null;
}

const EMPTY_SUBSCRIPTION: SubscriptionState = {
  loading: false,
  subscription: null,
  isActive: false,
  isTrialing: false,
  isPastDue: false,
  willCancelAtPeriodEnd: false,
  tier: null,
  currentPeriodEndDate: null,
};

const subscriptionCache = new Map<string, SubscriptionState>();
// Grace window before any "not active" state is reported to consumers.
// Covers all paths: doc-doesn't-exist, doc-exists-but-canceled,
// doc-exists-but-incomplete, doc-exists-but-past-due, denormalized
// user-doc fields lagging behind the actual subscriptions doc. The
// hook holds loading: true until the inactive state has been stable
// for this long, so a one-second blip from cache → fresh snapshot
// never gates a paying user.
const INACTIVE_GRACE_MS = 8000;
const ACTIVE_LOCAL_TTL_MS = 24 * 60 * 60 * 1000;

function isActiveState(state: SubscriptionState): boolean {
  return state.isActive || state.isTrialing;
}

function localActiveKey(uid: string): string {
  return `gk.subscription.active.${uid}`;
}

function readLocalActive(uid: string): SubscriptionState | null {
  try {
    const raw = window.localStorage.getItem(localActiveKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.at || Date.now() - Number(parsed.at) > ACTIVE_LOCAL_TTL_MS) return null;
    return stateFromSubscription({
      userId: uid,
      status: parsed.status || 'active',
      tier: parsed.tier || null,
    } as SubscriptionDoc);
  } catch {
    return null;
  }
}

function writeLocalActive(uid: string, next: SubscriptionState): void {
  try {
    if (next.isActive || next.isTrialing) {
      window.localStorage.setItem(localActiveKey(uid), JSON.stringify({
        at: Date.now(),
        status: next.subscription?.status || 'active',
        tier: next.tier || null,
      }));
    }
  } catch { /* ignore */ }
}

function timestampToDate(ts: any): Date | null {
  return ts?.toDate
    ? ts.toDate()
    : ts instanceof Date
      ? ts
      : null;
}

function stateFromSubscription(data: SubscriptionDoc | null): SubscriptionState {
  if (!data) return EMPTY_SUBSCRIPTION;
  const status = data.status || '';
  return {
    loading: false,
    subscription: data,
    isActive: status === 'active' || status === 'trialing',
    isTrialing: status === 'trialing',
    isPastDue: status === 'past_due',
    willCancelAtPeriodEnd: !!data.cancelAtPeriodEnd,
    tier: data.tier ?? null,
    currentPeriodEndDate: timestampToDate(data.currentPeriodEnd),
  };
}

function optimisticStateFromUserDoc(userData: any, uid: string): SubscriptionState | null {
  if (!userData) return null;
  const status = userData.subscriptionStatus as string | undefined;
  const tier = userData.subscriptionTier || null;
  const active = userData.subscriptionActive === true || status === 'active' || status === 'trialing';
  const pastDue = status === 'past_due';

  // The user doc is denormalized by the Stripe webhook specifically
  // so rules and first paint can answer "is this coach covered?"
  // without waiting for subscriptions/{uid}. Trust active/past-due
  // states immediately; let the subscriptions doc fill in customerId
  // and renewal dates when it arrives.
  if (!active && !pastDue) return null;

  return stateFromSubscription({
    userId: uid,
    status: status || (active ? 'active' : 'past_due'),
    tier,
  } as SubscriptionDoc);
}

function loadingState(): SubscriptionState {
  return { ...EMPTY_SUBSCRIPTION, loading: true };
}

export function useSubscription(): SubscriptionState {
  const { currentUser, userData } = useAuth();
  const [state, setState] = useState<SubscriptionState>(() => {
    const uid = currentUser?.uid;
    if (!uid) return EMPTY_SUBSCRIPTION;
    return subscriptionCache.get(uid)
      || optimisticStateFromUserDoc(userData, uid)
      || readLocalActive(uid)
      || loadingState();
  });

  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) {
      setState(EMPTY_SUBSCRIPTION);
      return;
    }

    let cancelled = false;
    let pendingInactive: SubscriptionState | null = null;
    let pendingInactiveTimer: number | null = null;
    const cached = subscriptionCache.get(uid);
    const optimistic = optimisticStateFromUserDoc(userData, uid);
    const localActive = readLocalActive(uid);
    const hasActiveSignal = !!(optimistic || (cached && isActiveState(cached)) || localActive);

    const clearPendingInactive = () => {
      if (pendingInactiveTimer !== null) {
        window.clearTimeout(pendingInactiveTimer);
        pendingInactiveTimer = null;
      }
      pendingInactive = null;
    };

    const applyState = (next: SubscriptionState) => {
      subscriptionCache.set(uid, next);
      writeLocalActive(uid, next);
      if (!cancelled) setState(next);
    };

    // Apply the resolved inactive state once the grace window expires
    // OR right away if the user has never been seen as active (no need
    // to delay the truth for someone who's genuinely never paid).
    const scheduleInactive = (next: SubscriptionState) => {
      // If we already know they're inactive AND we don't have any
      // active signal to defend, surface immediately. The delay only
      // exists to protect against a momentary "no-data" or "stale-
      // canceled" flash on top of a real active subscription.
      if (!hasActiveSignal) {
        applyState(next);
        return;
      }
      // Already scheduled — let the existing timer fire.
      if (pendingInactive) {
        pendingInactive = next;
        return;
      }
      pendingInactive = next;
      pendingInactiveTimer = window.setTimeout(() => {
        const toApply = pendingInactive;
        pendingInactiveTimer = null;
        pendingInactive = null;
        if (toApply && !cancelled) applyState(toApply);
      }, INACTIVE_GRACE_MS);
    };

    // Seed initial state. Prefer the most confident signal.
    if (optimistic) applyState(optimistic);
    else if (cached) setState(cached);
    else if (localActive) setState(localActive);
    else setState(loadingState());

    const ref = doc(db, 'subscriptions', uid);
    const unsub = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        // Cache-only miss on cold mount when we have no other active
        // signal: ignore. Server snapshot will follow in a moment.
        if (!snap.exists() && snap.metadata.fromCache && !cached && !optimistic) {
          return;
        }

        const next = snap.exists()
          ? stateFromSubscription(snap.data() as SubscriptionDoc)
          : EMPTY_SUBSCRIPTION;

        if (isActiveState(next)) {
          // Active states always apply immediately — they unlock UX,
          // they don't gate it. Also drop any pending inactive timer
          // so a delayed false-positive can't fire after a true active.
          clearPendingInactive();
          applyState(next);
        } else {
          // Inactive in any form (no doc, canceled, past_due,
          // incomplete, unpaid). Hold the previous state and only
          // commit the inactive after the grace window. If a new
          // active snapshot arrives during the window we cancel and
          // commit that instead.
          scheduleInactive(next);
        }
      },
      // Silent on errors — most likely cause is rules denial because
      // the doc lives at subscriptions/cus_xxx for a marketing-site
      // signup that hasn't been linked to a uid yet.
      () => {
        clearPendingInactive();
        const fallback = optimistic || cached;
        if (fallback) applyState({ ...fallback, loading: false });
        else applyState(EMPTY_SUBSCRIPTION);
      },
    );
    return () => {
      cancelled = true;
      clearPendingInactive();
      unsub();
    };
  }, [
    currentUser?.uid,
    (userData as any)?.subscriptionActive,
    (userData as any)?.subscriptionStatus,
    (userData as any)?.subscriptionTier,
  ]);

  return state;
}
