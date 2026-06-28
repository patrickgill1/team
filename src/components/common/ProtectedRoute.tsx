import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  fallbackPath?: string;
  /** When true, do NOT redirect coaches with empty teamIds to
   *  /onboarding. The /onboarding route itself sets this so we don't
   *  redirect-loop. Settings + a few other "always accessible" pages
   *  may also opt in if we expand the gate later. */
  allowEmpty?: boolean;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  fallbackPath = '/auth',
  allowEmpty = false,
}) => {
  const { currentUser, userData, loading } = useAuth();
  const location = useLocation();
  // After 3s of loading, surface a 'Reconnecting…' subtitle so the user
  // knows the app isn't frozen. The case this addresses: post-OTA reload
  // recovery — AuthContext is waiting for Firebase Auth to re-validate
  // its token, which can take 4–6s on cold cellular. A bare spinner
  // looks like a hang.
  const [showReconnecting, setShowReconnecting] = useState(false);
  useEffect(() => {
    if (!loading) { setShowReconnecting(false); return; }
    const t = window.setTimeout(() => setShowReconnecting(true), 3000);
    return () => window.clearTimeout(t);
  }, [loading]);

  // Navy bg matches the native splash + the app hero, so users don't
  // see a color flash transitioning from splash → spinner → app.
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-base via-surface-input to-surface-base flex flex-col items-center justify-center gap-4">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-primary/30 border-t-cyan-400" />
        <p
          className={`text-xs font-semibold tracking-wide text-white/60 transition-opacity duration-500 ${
            showReconnecting ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Reconnecting…
        </p>
      </div>
    );
  }

  if (!currentUser) {
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  if (!userData) {
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  // First-run gate. A signed-in coach with no teams belongs in the
  // onboarding wizard. Parents are excluded — they're handled by
  // InThePoolHero on the dashboard (unrostered = "in the pool" status
  // page). Routes that should bypass this (the wizard itself,
  // anything we add to an allowlist) set allowEmpty.
  if (!allowEmpty) {
    const teamIds: any[] = Array.isArray((userData as any).teamIds)
      ? (userData as any).teamIds
      : [];
    const hasAnyTeam = teamIds.length > 0 || !!(userData as any).teamId;
    const role = (userData as any).role;
    const needsOnboarding = !hasAnyTeam && role !== 'parent';
    if (needsOnboarding && location.pathname !== '/onboarding') {
      return <Navigate to="/onboarding" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;