import React, { createContext, useContext, useEffect, useState } from 'react';

// Shared state for the desktop sidebar's collapsed/expanded width.
// Lives in a context so the Navigation component (the toggle owner)
// and App.tsx's <main> wrapper (which needs to set left margin) both
// see the same value. Without this, collapsing the sidebar from 64
// to 20 rem leaves a 44 rem ghost band between sidebar and content.
//
// Persists across reloads via localStorage so a coach who prefers
// the compact rail keeps their layout.

const STORAGE_KEY = 'gk_sidebar_collapsed';

interface SidebarState {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

export const SidebarProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch { /* private-browsing or quota — non-fatal */ }
  }, [collapsed]);

  const value: SidebarState = {
    collapsed,
    setCollapsed: setCollapsedState,
    toggle: () => setCollapsedState((c) => !c),
  };
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
};

export function useSidebar(): SidebarState {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    // Soft fallback rather than throwing — if a tree forgets the
    // provider, the sidebar still works in expanded mode and the
    // toggle is a no-op. Beats crashing the app.
    return { collapsed: false, setCollapsed: () => {}, toggle: () => {} };
  }
  return ctx;
}
