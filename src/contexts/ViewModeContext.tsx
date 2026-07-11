// @ts-nocheck
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import { isCoach, isClubAdmin as isClubAdminFn } from '../utils/helpers';
import { getDedicatedKidPlayerId, verifyPin, suppressPushForKidMode, restorePushAfterKidMode } from '../utils/kidMode';

/**
 * ViewModeContext — Patrick 2026-06-21: 'my dashboard is coach, my
 * son, coach, my son... i think i just need a coach/parent/admin
 * selector where it gives me different views.'
 *
 * Multi-role users (admin + coach + parent — Patrick himself) face
 * a structural mismatch: no single dashboard layout serves all
 * three. ViewMode is a runtime toggle that gates which surfaces
 * render, so the user picks a context and the dashboard collapses
 * to that. Single-role users never see the switcher — their mode
 * is auto-determined and the picker UI hides.
 *
 * Modes:
 *   - 'parent'  — kid + family content, no coach cards
 *   - 'coach'   — team + coach cards (Tonight, Team Health,
 *                 accordion bar with inline inbox)
 *
 * Admin is intentionally NOT a view mode here — admins navigate to
 * /club via the bottom-nav Club tab (per the AdminCockpit-moved-
 * to-/club decision earlier today). The role-switcher sheet
 * surfaces a 'Club section' link as a navigation action, not a
 * view-mode flip.
 *
 * Persisted per-user in localStorage so the user returns to their
 * last picked view on next session.
 */

export type ViewMode = 'parent' | 'coach' | 'admin';

interface ViewModeContextValue {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  availableModes: ViewMode[];
  isMultiRole: boolean;  // true when the user has both parent + coach affordances
  /** True when the user IS their own player — i.e. adult self-players
   *  (audit 2026-07-11). Sourced from user.selfPlayerId. Copy + gates
   *  that would otherwise treat the user as a family-member-of-player
   *  can flip to player-flavored surfaces without needing a whole new
   *  ViewMode enum. */
  isPlayerContext: boolean;
  /** Kid profile mode — set to a playerId when active. Not persisted
   *  in state; enter/exit go through enterKidMode/exitKidMode which
   *  verify the PIN. On a dedicated kid device, cold boot resolves
   *  this from localStorage (getDedicatedKidPlayerId) so the kid
   *  never sees parent view without a PIN prompt. */
  activeKidPlayerId: string | null;
  /** Try to enter kid mode for a player. Returns true on success. */
  enterKidMode: (playerId: string, pin: string) => Promise<boolean>;
  /** Try to exit kid mode. Requires the same PIN so a sibling can't
   *  escape. Returns true on success. On a dedicated kid device this
   *  drops back to parent view for the current session only — cold
   *  boot re-enters kid mode from the dedicated flag. */
  exitKidMode: (pin: string) => Promise<boolean>;
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

function storageKey(uid?: string): string {
  return `gk.viewMode.${uid || 'anon'}`;
}

function defaultModeFor(modes: ViewMode[]): ViewMode {
  // Default precedence: parent → coach → admin. Parents are the
  // largest population; coaches who are also admins will land on
  // coach view (their daily context); pure admins land on admin
  // since that's the only mode available to them.
  if (modes.includes('parent')) return 'parent';
  if (modes.includes('coach')) return 'coach';
  if (modes.includes('admin')) return 'admin';
  return 'parent';
}

export const ViewModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userData } = useAuth();

  // `User.children` exists in the schema but isn't reliably
  // populated (Patrick caught this 2026-06-21 — his account is a
  // parent of Hunter Gill but the children array is empty; the
  // canonical kid-linkage is on Player.parentIds[] instead).
  // Query once per session for the SOURCE OF TRUTH: any player
  // with this user's uid in their parentIds array. If found,
  // parent mode is available.
  const [hasKidsByQuery, setHasKidsByQuery] = useState<boolean | null>(null);
  useEffect(() => {
    const uid = (userData as any)?.uid;
    if (!uid) { setHasKidsByQuery(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = query(
          collection(db, 'players'),
          where('parentIds', 'array-contains', uid),
          limit(1)
        );
        const snap = await getDocs(q);
        if (cancelled) return;
        setHasKidsByQuery(snap.size > 0);
      } catch (err) {
        console.warn('[view-mode] parent-detection query failed', err);
        // On failure, fall back to the User.children field as a
        // best-effort signal.
        if (!cancelled) setHasKidsByQuery(null);
      }
    })();
    return () => { cancelled = true; };
  }, [(userData as any)?.uid]);

  const availableModes = useMemo<ViewMode[]>(() => {
    const modes: ViewMode[] = [];
    // Trust the live query first; fall back to the static
    // children field if the query is still pending or errored.
    const hasKids = hasKidsByQuery === true
      || (hasKidsByQuery === null && Array.isArray((userData as any)?.children) && (userData as any).children.length > 0);
    if (hasKids) modes.push('parent');
    if (userData && isCoach((userData as any).role)) modes.push('coach');
    if (userData && isClubAdminFn(userData)) modes.push('admin');
    // Always at least one — anything with no signals falls back
    // to 'parent' as a safe default.
    if (modes.length === 0) modes.push('parent');
    return modes;
  }, [userData, hasKidsByQuery]);

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    return defaultModeFor(availableModes);
  });

  // Hydrate from localStorage once auth resolves with a uid.
  useEffect(() => {
    if (!(userData as any)?.uid) return;
    try {
      const raw = localStorage.getItem(storageKey((userData as any).uid));
      if (raw && (raw === 'parent' || raw === 'coach' || raw === 'admin') && availableModes.includes(raw as ViewMode)) {
        setViewModeState(raw as ViewMode);
      } else {
        setViewModeState(defaultModeFor(availableModes));
      }
    } catch { /* ignore localStorage failures (private mode etc) */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(userData as any)?.uid, availableModes.join('|')]);

  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    try {
      if ((userData as any)?.uid) {
        localStorage.setItem(storageKey((userData as any).uid), m);
      }
    } catch { /* ignore */ }
  };

  const isPlayerContext = !!(userData as any)?.selfPlayerId;

  // Kid profile mode. Cold boot on a dedicated kid device auto-enters
  // the kid view (getDedicatedKidPlayerId reads localStorage). On a
  // household device it stays null until enterKidMode() is called.
  const [activeKidPlayerId, setActiveKidPlayerId] = useState<string | null>(() => {
    return getDedicatedKidPlayerId();
  });

  // Cold-boot push suppression on a dedicated kid device. If we land
  // straight into kid mode (activeKidPlayerId set from localStorage
  // before the parent could tap "enter"), immediately pull this
  // device's FCM token off the parent user doc so incoming pushes
  // don't leak parent-scoped notifications to the kid device.
  useEffect(() => {
    const uid = (userData as any)?.uid;
    if (!uid) return;
    if (activeKidPlayerId) {
      suppressPushForKidMode(uid);
    }
    // Only wants to fire once on mount + on uid resolution; the
    // enterKidMode / exitKidMode functions handle transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(userData as any)?.uid]);

  // Verify PIN against the player doc's stored hash. Reads through the
  // client SDK; rules already allow authed users to GET a player doc
  // via callerCanReadPlayer branches so no worker round-trip needed.
  const enterKidMode = async (playerId: string, pin: string): Promise<boolean> => {
    try {
      const snap = await getDoc(doc(db, 'players', playerId));
      if (!snap.exists()) return false;
      const data: any = snap.data();
      const km = data?.kidMode || {};
      if (km.enabled !== true) return false;
      const ok = await verifyPin(playerId, pin, km.pinHash);
      if (!ok) return false;
      setActiveKidPlayerId(playerId);
      // Pull this device's FCM token off the parent user doc so
      // parent-scoped pushes stop reaching this device while kid is
      // using it. Restored on exit.
      const uid = (userData as any)?.uid;
      if (uid) suppressPushForKidMode(uid);
      return true;
    } catch (err) {
      console.warn('[view-mode] enterKidMode failed', err);
      return false;
    }
  };

  const exitKidMode = async (pin: string): Promise<boolean> => {
    if (!activeKidPlayerId) return true;
    try {
      const snap = await getDoc(doc(db, 'players', activeKidPlayerId));
      if (!snap.exists()) {
        // Player gone — fail-safe to parent view. Still try to
        // restore push in case suppression happened before.
        const uid = (userData as any)?.uid;
        if (uid) restorePushAfterKidMode(uid);
        setActiveKidPlayerId(null);
        return true;
      }
      const data: any = snap.data();
      const km = data?.kidMode || {};
      const ok = await verifyPin(activeKidPlayerId, pin, km.pinHash);
      if (!ok) return false;
      setActiveKidPlayerId(null);
      // Restore the FCM token so parent starts receiving push again.
      const uid = (userData as any)?.uid;
      if (uid) restorePushAfterKidMode(uid);
      return true;
    } catch (err) {
      console.warn('[view-mode] exitKidMode failed', err);
      return false;
    }
  };

  const value: ViewModeContextValue = {
    viewMode,
    setViewMode,
    availableModes,
    isMultiRole: availableModes.length > 1,
    isPlayerContext,
    activeKidPlayerId,
    enterKidMode,
    exitKidMode,
  };

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
};

export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) {
    // Permissive fallback — never crash a render if the provider
    // is missing. Treat as single-mode parent, no kid mode.
    return {
      viewMode: 'parent',
      setViewMode: () => {},
      availableModes: ['parent'],
      isMultiRole: false,
      isPlayerContext: false,
      activeKidPlayerId: null,
      enterKidMode: async () => false,
      exitKidMode: async () => true,
    };
  }
  return ctx;
}
