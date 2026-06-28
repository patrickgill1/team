import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

// ThemeContext — light/dark/system. Writes `data-theme="dark"|"light"`
// to <html> so CSS variables in src/index.css swap atomically. New
// surfaces use the semantic Tailwind tokens (bg-surface-*, text-ink-*,
// border-line-*); legacy charcoal-* / bone classes stay dark until
// individually migrated.
//
// Persistence: per-device (localStorage). No per-user mirror —
// theme is a device preference (different glasses than view-mode),
// and sharing it across devices would override Patrick's at-night
// macbook setting from his phone's daytime setting.

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  resolved: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'gk.theme';

// Light mode is gated until the next iOS + Android binaries ship with
// the AppDelegate.swift / styles.xml theme-aware underlay patches
// (committed on main, awaiting submission). Until then the toggle is
// owner-only so Patrick can audit on his own devices via Capgo OTA —
// regular users still see dark only.
//
// The gate is computed at consumer-component-level (uses `useAuth`).
// This constant is a kill switch — flip to false to hide from everyone
// (including owner). When the binaries ship + light mode is launch-
// ready, change isPickerVisible() to `return true` to roll out to all.
export const THEME_PICKER_ENABLED = true;

// Caller passes their userData (or null). Owner sees the toggle, no
// one else does. Used by Settings → Appearance + Onboarding picker.
export function isThemePickerVisible(userData: { email?: string } | null | undefined): boolean {
  if (!THEME_PICKER_ENABLED) return false;
  // Lazy-import to avoid pulling helpers into the context module's
  // dependency graph (helpers.ts touches firestore types). Owner check
  // is a hardcoded allowlist on the email — same as isOwner() in
  // helpers.ts. Duplicated here to keep the gate evaluation pure.
  const email = (userData?.email || '').toLowerCase();
  return email === 'patrickgill4@gmail.com';
}

function readStoredMode(): ThemeMode {
  if (!THEME_PICKER_ENABLED) return 'dark';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch { /* ignore */ }
  return 'dark';
}

function systemPrefersLight(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return mode;
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveMode(readStoredMode()));

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
  };

  // Recompute resolved theme whenever mode changes OR (when mode is
  // 'system') when the OS preference flips.
  useEffect(() => {
    setResolved(resolveMode(mode));
    if (mode !== 'system') return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => setResolved(resolveMode('system'));
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, [mode]);

  // Reflect into the DOM. Set data-theme on <html> so the CSS
  // variables in :root vs html[data-theme="light"] swap together.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode, resolved }), [mode, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe default if a consumer renders outside the provider (e.g.
    // pre-mount loaders). Setter is a no-op.
    return { mode: 'dark', setMode: () => {}, resolved: 'dark' };
  }
  return ctx;
};
