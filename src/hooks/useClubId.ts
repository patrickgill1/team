import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';

// Resolve the user's clubId without trusting that userData.clubId is
// set directly. Legacy admins (Patrick in particular) are flagged
// isClubAdmin: true on their user doc but don't have the clubId
// pointer — pages that try to read userData.clubId silently fail.
//
// Resolution order:
//   1. userData.clubId (canonical when present)
//   2. userData.clubIds[0] (every admin page already hardcodes this
//      pattern; centralizing it so the eventual multi-club picker
//      swaps in one place instead of 10 files)
//   3. clubId on the user's first team
//   4. undefined — call sites must handle "no club resolved" with
//      a real empty state. Previously fell through to loading ANY
//      single club doc in the project and returning its id, which
//      silently cross-leaked between tenants: user A with a stale
//      user doc could land on user B's club on first paint. Patrick
//      2026-10-21 audit (B4): fixed before any second real club
//      signs up. Multi-club picker remains TODO but is strictly
//      additive — the picker will set userData.clubId explicitly
//      and this hook will return it from branch (1).
//
// Returns { clubId, loading } so call sites can disable Save buttons
// while resolution is in-flight + surface "could not resolve" with a
// real error instead of writing junk.

export function useClubId(): { clubId: string | undefined; loading: boolean } {
  const { userData } = useAuth();
  const seeded = (userData as any)?.clubId as string | undefined;
  const firstFromArray: string | undefined = (() => {
    const arr = (userData as any)?.clubIds;
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : undefined;
  })();
  const initial = seeded || firstFromArray;
  const [clubId, setClubId] = useState<string | undefined>(initial);
  const [loading, setLoading] = useState(!initial);

  useEffect(() => {
    if (initial) { setClubId(initial); setLoading(false); return; }
    if (!userData) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const teamIds: string[] = (userData as any).teamIds || ((userData as any).teamId ? [(userData as any).teamId] : []);
        for (const tid of teamIds) {
          const tSnap = await getDoc(doc(db, 'teams', tid));
          const tClubId = tSnap.exists() ? (tSnap.data() as any)?.clubId : null;
          if (tClubId && !cancelled) { setClubId(tClubId); return; }
        }
        // No arbitrary-club fallback. If we got here, the user has no
        // club relationship on their user doc or any of their teams —
        // return undefined and let the UI render "no club" state.
      } catch (err) {
        console.warn('useClubId resolve failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initial, userData]);

  return { clubId, loading };
}
