// @ts-nocheck
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../utils/firebase';

// Live whether-this-club-has-a-team-store check. Returns
// { hasStore, loading, storeUrl, storeDiscountCode }. Drives:
//   1. Navigation: hide Team Store entry when no storeUrl set.
//   2. TeamStore page: read source data (already does its own load).
//
// Patrick 2026-06-25: 'can that be hidden if a team doesn't have
// a team store?'

interface ClubStoreState {
  hasStore: boolean;
  loading: boolean;
  storeUrl: string | null;
  storeDiscountCode: string | null;
}

export function useClubStore(clubId: string | null | undefined): ClubStoreState {
  const [state, setState] = useState<ClubStoreState>({
    hasStore: false,
    loading: !!clubId,
    storeUrl: null,
    storeDiscountCode: null,
  });

  useEffect(() => {
    if (!clubId) {
      setState({ hasStore: false, loading: false, storeUrl: null, storeDiscountCode: null });
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'clubs', clubId),
      (snap) => {
        const data: any = snap.exists() ? snap.data() : null;
        const url = data?.storeUrl || null;
        setState({
          hasStore: !!url,
          loading: false,
          storeUrl: url,
          storeDiscountCode: data?.storeDiscountCode || null,
        });
      },
      () => setState((s) => ({ ...s, loading: false })),
    );
    return () => unsub();
  }, [clubId]);

  return state;
}
