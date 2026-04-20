import { useAuth as useAuthContext } from '../contexts/AuthContext';

// Re-export the useAuth hook from AuthContext for convenience
// This allows components to import useAuth directly from hooks
export const useAuth = () => {
  return useAuthContext();
};

export default useAuth;