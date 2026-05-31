import React from 'react';
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

  // Navy bg matches the native splash + the app hero, so users don't
  // see a color flash transitioning from splash → spinner → app.
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-cyan-500/30 border-t-cyan-400" />
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