// @ts-nocheck
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { isCoach } from '../utils/helpers';

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

export type ViewMode = 'parent' | 'coach';

interface ViewModeContextValue {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  availableModes: ViewMode[];
  isMultiRole: boolean;  // true when the user has both parent + coach affordances
}

const ViewModeContext = createContext<ViewModeContextValue | null>(null);

function storageKey(uid?: string): string {
  return `gk.viewMode.${uid || 'anon'}`;
}

function defaultModeFor(modes: ViewMode[]): ViewMode {
  // Parents are the larger population; if user has kids, default
  // to parent. Only coaches without kids default to coach.
  if (modes.includes('parent')) return 'parent';
  if (modes.includes('coach')) return 'coach';
  return 'parent';
}

export const ViewModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userData } = useAuth();

  const availableModes = useMemo<ViewMode[]>(() => {
    const modes: ViewMode[] = [];
    const hasKids = Array.isArray((userData as any)?.children) && (userData as any).children.length > 0;
    if (hasKids) modes.push('parent');
    if (userData && isCoach((userData as any).role)) modes.push('coach');
    // Always at least one — parents who are also coaches but
    // have no kids would still be 'coach'; anything with no
    // signals falls back to 'parent' as a safe default.
    if (modes.length === 0) modes.push('parent');
    return modes;
  }, [userData]);

  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    return defaultModeFor(availableModes);
  });

  // Hydrate from localStorage once auth resolves with a uid.
  useEffect(() => {
    if (!(userData as any)?.uid) return;
    try {
      const raw = localStorage.getItem(storageKey((userData as any).uid));
      if (raw && (raw === 'parent' || raw === 'coach') && availableModes.includes(raw as ViewMode)) {
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

  const value: ViewModeContextValue = {
    viewMode,
    setViewMode,
    availableModes,
    isMultiRole: availableModes.length > 1,
  };

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
};

export function useViewMode(): ViewModeContextValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) {
    // Permissive fallback — never crash a render if the provider
    // is missing. Treat as single-mode parent.
    return { viewMode: 'parent', setViewMode: () => {}, availableModes: ['parent'], isMultiRole: false };
  }
  return ctx;
}
