// @ts-nocheck
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import { useApplyClubBrand } from '../../hooks/useApplyClubBrand';

/**
 * Mount-only component (renders nothing) that wires the active
 * club's brandColor into the CSS variable layer. Subscribes to
 * the club doc so changes in /club/branding re-tint the whole app
 * in real time without a reload.
 *
 * Drop it once inside any auth-gated tree (App.tsx renders it
 * inside ProtectedRoute via AppLayout) and forget about it —
 * primary buttons, accents, and any surface using bg-brand-primary
 * pick up the active club's color automatically.
 *
 * Fallback chain when no clubId is resolvable: hook receives null
 * and resets CSS variables to GoalKickr crimson defaults.
 */
const ApplyClubBrand: React.FC = () => {
  const { selectedTeam } = useTeam();
  const clubId = (selectedTeam as any)?.clubId || null;
  const [brandColor, setBrandColor] = useState<string | null>(null);

  useEffect(() => {
    // Reset to defaults IMMEDIATELY on any clubId change, before the
    // new club doc's snapshot fires. Without this, switching from a
    // blue-themed club to another club leaves the UI blue for the
    // ~200ms it takes to load the new club doc — Patrick caught this
    // when his color stayed blue after switching clubs. Even if the
    // new club has no brandColor (null), the reset still hides the
    // stale paint until the snapshot lands.
    setBrandColor(null);
    if (!clubId) return;
    const unsub = onSnapshot(
      doc(db, 'clubs', clubId),
      (snap) => {
        const data: any = snap.exists() ? snap.data() : null;
        setBrandColor(data?.brandColor || null);
      },
      () => setBrandColor(null),
    );
    return () => unsub();
  }, [clubId]);

  useApplyClubBrand(brandColor);
  return null;
};

export default ApplyClubBrand;
