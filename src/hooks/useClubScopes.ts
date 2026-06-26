// @ts-nocheck
import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from './useAuth';
import { hasClubScope, resolveClubScopes } from '../utils/clubScopes';
import type { Club, ClubAdminScope } from '../types';

/**
 * Subscribe to a club's admin permission set and expose a fast
 * has(scope) check + the full list. Re-emits when the club doc's
 * adminScopes change so a freshly-granted scope unlocks UI live.
 *
 * Note: this reads the entire club doc. Most pages already do so
 * via TeamContext / useClubId — this hook is for pages that don't
 * already have the club in scope.
 */
export function useClubScopes(clubId: string | null | undefined) {
  const { userData, currentUser } = useAuth();
  const uid = userData?.uid || currentUser?.uid || null;
  const [club, setClub] = useState<Club | null>(null);

  useEffect(() => {
    if (!clubId) { setClub(null); return; }
    const unsub = onSnapshot(doc(db, 'clubs', clubId), (snap) => {
      if (!snap.exists()) { setClub(null); return; }
      setClub({ id: snap.id, ...(snap.data() as any) });
    }, () => setClub(null));
    return () => unsub();
  }, [clubId]);

  const scopes = useMemo(() => resolveClubScopes(uid, club), [uid, club]);
  const has = (scope: ClubAdminScope) => hasClubScope(uid, club, scope);
  const isOwner = !!(uid && club && club.ownerUid === uid);
  return { scopes, has, isOwner, club };
}
