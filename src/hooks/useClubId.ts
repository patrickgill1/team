import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';

// Resolve + switch the user's active clubId. Admins can now belong to
// multiple clubs (patrick 2026-10-21 audit M6); this hook is the one
// seam every admin surface uses to read "which club am I looking at"
// so the picker in /club can flip them all in sync.
//
// Resolution order for the ACTIVE clubId:
//   1. localStorage 'activeClubId' IF it's in the user's clubIds set
//      (survives refresh + navigation; cleared when the user is no
//      longer a member of that club).
//   2. userData.clubId (canonical when present).
//   3. userData.clubIds[0] (first-of-array fallback, same as the raw
//      pattern this hook replaces).
//   4. clubId on the user's first team.
//   5. undefined — call sites must handle "no club resolved" with a
//      real empty state. The arbitrary-first-club-in-project fallback
//      (B4) stays removed.
//
// Call sites:
//   - Read: const { clubId } = useClubId();
//   - Switch (from the picker): useClubId().setActiveClubId(id)
//   - List available clubs for a picker: useClubId().availableClubIds

const STORAGE_KEY = 'activeClubId';
const CHANGE_EVENT = 'activeClubChange';

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function writeStored(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore quota / private mode */ }
}

export interface UseClubIdResult {
  clubId: string | undefined;
  loading: boolean;
  availableClubIds: string[];
  setActiveClubId: (id: string) => void;
}

export function useClubId(): UseClubIdResult {
  const { userData } = useAuth();
  const availableClubIds: string[] = (() => {
    const arr = (userData as any)?.clubIds;
    const canonical = (userData as any)?.clubId;
    const set = new Set<string>();
    if (canonical) set.add(canonical);
    if (Array.isArray(arr)) arr.forEach((id: string) => { if (id) set.add(id); });
    return Array.from(set);
  })();

  const [storedActive, setStoredActive] = useState<string | null>(() => readStored());

  // Re-read localStorage on both cross-tab storage events + the
  // same-tab custom event the setter fires. Keeps every mounted
  // useClubId reader in sync without a full React context.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStoredActive(e.newValue);
    };
    const onCustom = () => setStoredActive(readStored());
    window.addEventListener('storage', onStorage);
    window.addEventListener(CHANGE_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CHANGE_EVENT, onCustom);
    };
  }, []);

  // Reconcile: the stored active club must be one the user actually
  // belongs to. If a user leaves a club, the stale localStorage value
  // auto-expires back to the user's canonical / first club.
  const storedValid = storedActive && availableClubIds.includes(storedActive) ? storedActive : null;
  const canonical: string | undefined = (userData as any)?.clubId;
  const initial = storedValid || canonical || availableClubIds[0];
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

  const setActiveClubId = (id: string) => {
    if (!availableClubIds.includes(id)) return;
    writeStored(id);
    setStoredActive(id);
    // Notify every other mounted useClubId in this tab.
    try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* ignore */ }
  };

  return { clubId, loading, availableClubIds, setActiveClubId };
}
