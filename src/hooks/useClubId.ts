import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, limit, query } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';

// Resolve the user's clubId without trusting that userData.clubId is
// set directly. Legacy admins (Patrick in particular) are flagged
// isClubAdmin: true on their user doc but don't have the clubId
// pointer — pages that try to read userData.clubId silently fail.
//
// Resolution order:
//   1. userData.clubId (canonical when present)
//   2. clubId on the user's first team
//   3. Any single club doc in the project (single-tenant Fire FC
//      reality). When goalkickr ships multi-club this needs a proper
//      picker; until then this fallback keeps admin pages working.
//
// Returns { clubId, loading } so call sites can disable Save buttons
// while resolution is in-flight + surface "could not resolve" with a
// real error instead of writing junk.

export function useClubId(): { clubId: string | undefined; loading: boolean } {
  const { userData } = useAuth();
  const seeded = (userData as any)?.clubId as string | undefined;
  const [clubId, setClubId] = useState<string | undefined>(seeded);
  const [loading, setLoading] = useState(!seeded);

  useEffect(() => {
    if (seeded) { setClubId(seeded); setLoading(false); return; }
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
        const clubsSnap = await getDocs(query(collection(db, 'clubs'), limit(1)));
        if (!clubsSnap.empty && !cancelled) setClubId(clubsSnap.docs[0].id);
      } catch (err) {
        console.warn('useClubId resolve failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [seeded, userData]);

  return { clubId, loading };
}
