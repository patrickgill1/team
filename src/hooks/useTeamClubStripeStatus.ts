import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
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
 * Uses onSnapshot instead of one-shot getDoc so mobile users returning
 * from the Stripe Connect hosted flow don't see a stale "Not
 * connected" banner while the worker's Firestore write is still
 * propagating to the on-device cache. The live listener catches the
 * update within ~500ms of the write landing and the banner disappears
 * without a manual reload. Ref: Ship 1 decision #1 (2026-07-19).
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
    setIsReady(false);
    setIsLoading(true);
    if (!derivedClubId) {
      setIsLoading(false);
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'clubs', derivedClubId),
      (snap) => {
        const data: any = snap.exists() ? snap.data() : null;
        const ready = !!(data && data.stripeAccountId && data.stripeChargesEnabled === true);
        setIsReady(ready);
        setIsLoading(false);
      },
      (err) => {
        console.warn('[useTeamClubStripeStatus] club listener failed', err);
        setIsReady(false);
        setIsLoading(false);
      },
    );
    return () => unsub();
  }, [derivedClubId]);

  return { clubId: derivedClubId, isReady, isLoading };
}

export default useTeamClubStripeStatus;
