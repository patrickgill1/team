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

  console.log('ProtectedRoute check:', {
    currentUser: !!currentUser,
    userData: !!userData,
    loading,
    path: location.pathname
  });

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-300">Loading...</p>
        </div>
      </div>
    );
  }

  // If no current user, redirect to auth
  if (!currentUser) {
    console.log('No current user, redirecting to:', fallbackPath);
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  // If user exists but no userData, they might be mid-registration
  if (!userData) {
    console.log('User exists but no userData, redirecting to:', fallbackPath);
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  // If user has temporary team ID, they need to complete setup
  if (userData.teamId && userData.teamId.startsWith('temp_')) {
    console.log('User has temporary team, needs setup');
    // You might want to redirect to a team setup page instead of auth
    // For now, let them continue but you could add team setup logic here
  }

  // User is authenticated and has data, render the protected content
  console.log('User authenticated, rendering protected content');
  return <>{children}</>;
};

export default ProtectedRoute;