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
  tier?: 'annual' | 'monthly' | 'founder' | 'unknown' | null;
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

export function useSubscription(): SubscriptionState {
  const { currentUser } = useAuth();
  const [state, setState] = useState<SubscriptionState>({
    loading: true,
    subscription: null,
    isActive: false,
    isTrialing: false,
    isPastDue: false,
    willCancelAtPeriodEnd: false,
    tier: null,
    currentPeriodEndDate: null,
  });

  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) {
      setState({
        loading: false,
        subscription: null,
        isActive: false,
        isTrialing: false,
        isPastDue: false,
        willCancelAtPeriodEnd: false,
        tier: null,
        currentPeriodEndDate: null,
      });
      return;
    }
    const ref = doc(db, 'subscriptions', uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setState({
            loading: false,
            subscription: null,
            isActive: false,
            isTrialing: false,
            isPastDue: false,
            willCancelAtPeriodEnd: false,
            tier: null,
            currentPeriodEndDate: null,
          });
          return;
        }
        const data = snap.data() as SubscriptionDoc;
        const ts = data.currentPeriodEnd;
        const currentPeriodEndDate: Date | null = ts?.toDate
          ? ts.toDate()
          : ts instanceof Date
            ? ts
            : null;
        setState({
          loading: false,
          subscription: data,
          isActive: data.status === 'active' || data.status === 'trialing',
          isTrialing: data.status === 'trialing',
          isPastDue: data.status === 'past_due',
          willCancelAtPeriodEnd: !!data.cancelAtPeriodEnd,
          tier: data.tier ?? null,
          currentPeriodEndDate,
        });
      },
      // Silent on errors — most likely cause is rules denial because
      // the doc lives at subscriptions/cus_xxx for a marketing-site
      // signup that hasn't been linked to a uid yet.
      () => setState((s) => ({ ...s, loading: false })),
    );
    return () => unsub();
  }, [currentUser?.uid]);

  return state;
}
