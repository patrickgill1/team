import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  fallbackPath?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  fallbackPath = '/auth'
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
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-500/30 border-t-cyan-400" />
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

  return <>{children}</>;
};

export default ProtectedRoute;