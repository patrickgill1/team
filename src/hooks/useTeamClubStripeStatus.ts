import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from './useAuth';
import { useTeam } from '../contexts/TeamContext';

/**
 * Resolve whether the currently-selected team's club can actually
 * accept charges through Stripe. Powers the "Set up payments" banner
 * on CoachPaymentCreate + CoachPayments.
 *
 * clubId resolution mirrors worker/src/paymentRequests.ts
 * ensureClubForTeam:
 *   1. selectedTeam.clubId (denorm on the team doc)
 *   2. personal_{currentUser.uid} fallback for standalone coaches
 *      whose team was never linked to a real club yet.
 *
 * Returns loading=true while the club doc is in-flight so callers can
 * hold the banner off during the initial atomic-render window.
 */
export function useTeamClubStripeStatus(): {
  clubId: string | undefined;
  isReady: boolean;
  isLoading: boolean;
} {
  const { currentUser } = useAuth();
  const { selectedTeam } = useTeam();
  const teamClubId = selectedTeam?.clubId;
  const uid = currentUser?.uid;
  const derivedClubId = teamClubId || (uid ? `personal_${uid}` : undefined);

  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsReady(false);
    setIsLoading(true);
    if (!derivedClubId) {
      setIsLoading(false);
      return;
    }
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'clubs', derivedClubId));
        if (cancelled) return;
        const data: any = snap.exists() ? snap.data() : null;
        const ready = !!(data && data.stripeAccountId && data.stripeChargesEnabled === true);
        setIsReady(ready);
      } catch (err) {
        console.warn('[useTeamClubStripeStatus] club fetch failed', err);
        if (!cancelled) setIsReady(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [derivedClubId]);

  return { clubId: derivedClubId, isReady, isLoading };
}

export default useTeamClubStripeStatus;
