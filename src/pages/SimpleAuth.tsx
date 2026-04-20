import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/common/Logo';

const SimpleAuth: React.FC = () => {
  const { signIn, signUp, signInWithGoogle, currentUser, userData, loading, error } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register' | 'setup'>('login');
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
    role: 'parent' as 'coach' | 'parent',
    teamName: '',
    ageGroup: '',
    inviteCode: ''
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Redirect if user is already logged in AND has userData
  useEffect(() => {
    if (!loading && currentUser && userData) {
      console.log('User is authenticated and userData is loaded, redirecting to dashboard');
      navigate('/dashboard', { replace: true });
    }
  }, [currentUser, userData, loading, navigate]);

  // Check for invite code in URL only once when component mounts
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');
    if (inviteCode) {
      setFormData(prev => ({ ...prev, inviteCode }));
      setMode('register');
    }
  }, []);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.email.trim()) {
      newErrors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    if (!formData.password) {
      newErrors.password = 'Password is required';
    } else if (mode !== 'login' && formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters';
    }

    if (mode === 'register' || mode === 'setup') {
      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }

      if (!formData.name.trim()) {
        newErrors.name = 'Name is required';
      }

      if (mode === 'setup') {
        if (!formData.teamName.trim()) {
          newErrors.teamName = 'Team name is required';
        }
        if (!formData.ageGroup) {
          newErrors.ageGroup = 'Age group is required';
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent submission if form is invalid
    if (!validateForm()) {
      console.log('Form validation failed, not submitting');
      return;
    }

    // Don't submit if already submitting
    if (isSubmitting) {
      console.log('Already submitting, ignoring');
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    
    try {
      if (mode === 'login') {
        console.log('Attempting login with:', formData.email);
        await signIn(formData.email, formData.password);
        console.log('Login successful - waiting for auth state change');
      } else {
        const tempTeamId = formData.inviteCode || `team_${Date.now()}`;
        
        console.log('Attempting signup with:', {
          email: formData.email,
          name: formData.name,
          role: formData.role,
          teamId: tempTeamId
        });
        
        await signUp(formData.email, formData.password, {
          email: formData.email,
          name: formData.name,
          role: formData.role,
          teamId: tempTeamId,
          createdAt: new Date()
        });
        console.log('Signup successful - waiting for auth state change');
      }
    } catch (error: any) {
      console.error('Auth error:', error);
      
      let errorMessage = 'An error occurred. Please try again.';
      
      if (error?.code) {
        switch (error.code) {
          case 'auth/user-not-found':
            errorMessage = 'No account found with this email. Try creating an account instead.';
            setMode('register');
            break;
          case 'auth/wrong-password':
            errorMessage = 'Incorrect password. Please try again.';
            break;
          case 'auth/email-already-in-use':
            errorMessage = 'An account with this email already exists. Try signing in instead.';
            setMode('login');
            break;
          case 'auth/weak-password':
            errorMessage = 'Password is too weak. Please choose a stronger password.';
            break;
          case 'auth/invalid-email':
            errorMessage = 'Please enter a valid email address.';
            break;
          case 'auth/too-many-requests':
            errorMessage = 'Too many failed attempts. Please wait a moment and try again.';
            break;
          case 'permission-denied':
            errorMessage = 'There was a setup issue. Please contact support.';
            break;
          case 'auth/network-request-failed':
            errorMessage = 'Network error. Please check your connection and try again.';
            break;
          case 'auth/invalid-credential':
            errorMessage = 'Invalid email or password. Please check your credentials.';
            break;
          default:
            errorMessage = error.message || 'Authentication failed. Please try again.';
        }
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      setErrors({ submit: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    // Check if function exists
    if (!signInWithGoogle) {
      console.error('signInWithGoogle function not available');
      setErrors({ submit: 'Google Sign-In is not available. Please try email sign-in.' });
      return;
    }

    if (isSubmitting) {
      console.log('Already submitting, ignoring Google sign-in');
      return;
    }

    setIsSubmitting(true);
    setErrors({});
    
    try {
      console.log('Attempting Google sign-in');
      await signInWithGoogle(formData.inviteCode || undefined);
      console.log('Google sign-in successful - waiting for auth state change');
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      
      let errorMessage = 'Google sign-in failed. Please try again.';
      
      if (error?.code) {
        switch (error.code) {
          case 'auth/popup-closed-by-user':
            errorMessage = 'Sign-in was cancelled. Please try again.';
            break;
          case 'auth/popup-blocked':
            errorMessage = 'Pop-up was blocked. Please allow pop-ups and try again.';
            break;
          case 'auth/network-request-failed':
            errorMessage = 'Network error. Please check your connection and try again.';
            break;
          case 'auth/too-many-requests':
            errorMessage = 'Too many attempts. Please wait a moment and try again.';
            break;
          default:
            errorMessage = error.message || 'Google sign-in failed. Please try again.';
        }
      }
      
      setErrors({ submit: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchMode = (newMode: typeof mode) => {
    setMode(newMode);
    setErrors({});
    setFormData(prev => ({
      ...prev,
      password: '',
      confirmPassword: ''
    }));
  };

  // No loading spinner here — show the login form immediately.
  // If the user is already authenticated, the redirect useEffect above handles it.

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center px-4 py-8 sm:py-12">
      {/* Mobile-first container with better spacing */}
      <div className="w-full max-w-sm sm:max-w-md space-y-6 sm:space-y-8">
        {/* Logo and Header Section */}
        <div className="text-center">
          <div className="mb-6 sm:mb-8">
            <Logo size="lg" variant="full" className="sm:scale-110" />
          </div>
          
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">
            {mode === 'login' && 'Welcome back!'}
            {mode === 'register' && 'Join your team'}
            {mode === 'setup' && 'Create your team'}
          </h2>
          <p className="text-sm sm:text-base text-gray-600 px-2">
            {mode === 'login' && 'Sign in to your account'}
            {mode === 'register' && 'Create your account to join the team'}
            {mode === 'setup' && 'Set up a new team to get started'}
          </p>
        </div>

        {/* Form Container - Mobile optimized */}
        <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-xl border border-white/20">
          {/* Form padding optimized for mobile */}
          <div className="p-6 sm:p-8">
            {/* Google Sign-In Button - Only show if function is available */}
            {signInWithGoogle && (
              <div className="mb-6">
                <button
                  onClick={handleGoogleSignIn}
                  disabled={isSubmitting}
                  className="w-full flex items-center justify-center px-4 py-3.5 border border-gray-300 rounded-xl shadow-sm bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span className="text-gray-700 font-medium">
                    {isSubmitting ? 'Signing in...' : 'Continue with Google'}
                  </span>
                </button>
              </div>
            )}

            {/* Debug info - remove this after testing */}
            {!signInWithGoogle && (
              <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-600">
                  🚨 Google Sign-In not available. Check AuthContext.
                </p>
                <p className="text-xs text-red-500 mt-1">
                  Available functions: {Object.keys({ signIn, signUp, logout: signIn && 'logout' }).join(', ')}
                </p>
              </div>
            )}

            {/* Show divider only if Google Sign-In is available */}
            {signInWithGoogle && (
              <>
                {/* Divider */}
                <div className="relative mb-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-white text-gray-500">Or continue with email</span>
                  </div>
                </div>
              </>
            )}

            <form className="space-y-5 sm:space-y-6" onSubmit={handleSubmit}>
              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                    errors.email ? 'border-red-500 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder="Enter your email"
                  disabled={isSubmitting}
                  autoComplete="email"
                />
                {errors.email && <p className="text-red-500 text-sm mt-1">{errors.email}</p>}
              </div>

              {/* Password */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                    errors.password ? 'border-red-500 bg-red-50' : 'border-gray-300'
                  }`}
                  placeholder={mode === 'login' ? 'Enter your password' : 'Create a password (min 6 characters)'}
                  disabled={isSubmitting}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                {errors.password && <p className="text-red-500 text-sm mt-1">{errors.password}</p>}
              </div>

              {/* Confirm Password (Register/Setup only) */}
              {(mode === 'register' || mode === 'setup') && (
                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-2">
                    Confirm Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                      errors.confirmPassword ? 'border-red-500 bg-red-50' : 'border-gray-300'
                    }`}
                    placeholder="Confirm your password"
                    disabled={isSubmitting}
                    autoComplete="new-password"
                  />
                  {errors.confirmPassword && <p className="text-red-500 text-sm mt-1">{errors.confirmPassword}</p>}
                </div>
              )}

              {/* Name (Register/Setup only) */}
              {(mode === 'register' || mode === 'setup') && (
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-2">
                    Your Full Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                      errors.name ? 'border-red-500 bg-red-50' : 'border-gray-300'
                    }`}
                    placeholder="Enter your full name"
                    disabled={isSubmitting}
                    autoComplete="name"
                  />
                  {errors.name && <p className="text-red-500 text-sm mt-1">{errors.name}</p>}
                </div>
              )}

              {/* Role (Register/Setup only) - Mobile optimized */}
              {(mode === 'register' || mode === 'setup') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    I am a...
                  </label>
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <label className={`flex flex-col items-center p-4 sm:p-5 border-2 rounded-xl cursor-pointer transition-all duration-200 ${
                      formData.role === 'parent' 
                        ? 'border-blue-500 bg-blue-50 shadow-lg transform scale-105' 
                        : 'border-gray-200 hover:border-gray-300 bg-white/50'
                    }`}>
                      <input
                        type="radio"
                        value="parent"
                        checked={formData.role === 'parent'}
                        onChange={(e) => setFormData({ ...formData, role: e.target.value as 'parent' | 'coach' })}
                        disabled={isSubmitting}
                        className="sr-only"
                      />
                      <span className="text-2xl sm:text-3xl mb-2">👨‍👩‍👧‍👦</span>
                      <span className="font-medium text-gray-900 text-sm sm:text-base">Parent</span>
                    </label>
                    <label className={`flex flex-col items-center p-4 sm:p-5 border-2 rounded-xl cursor-pointer transition-all duration-200 ${
                      formData.role === 'coach' 
                        ? 'border-blue-500 bg-blue-50 shadow-lg transform scale-105' 
                        : 'border-gray-200 hover:border-gray-300 bg-white/50'
                    }`}>
                      <input
                        type="radio"
                        value="coach"
                        checked={formData.role === 'coach'}
                        onChange={(e) => setFormData({ ...formData, role: e.target.value as 'parent' | 'coach' })}
                        disabled={isSubmitting}
                        className="sr-only"
                      />
                      <span className="text-2xl sm:text-3xl mb-2">🏃‍♂️</span>
                      <span className="font-medium text-gray-900 text-sm sm:text-base">Coach</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Team Setup (Setup mode only) */}
              {mode === 'setup' && (
                <>
                  <div>
                    <label htmlFor="teamName" className="block text-sm font-medium text-gray-700 mb-2">
                      Team Name
                    </label>
                    <input
                      id="teamName"
                      type="text"
                      value={formData.teamName}
                      onChange={(e) => setFormData({ ...formData, teamName: e.target.value })}
                      className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                        errors.teamName ? 'border-red-500 bg-red-50' : 'border-gray-300'
                      }`}
                      placeholder="Enter team name"
                      disabled={isSubmitting}
                    />
                    {errors.teamName && <p className="text-red-500 text-sm mt-1">{errors.teamName}</p>}
                  </div>

                  <div>
                    <label htmlFor="ageGroup" className="block text-sm font-medium text-gray-700 mb-2">
                      Age Group
                    </label>
                    <select
                      id="ageGroup"
                      value={formData.ageGroup}
                      onChange={(e) => setFormData({ ...formData, ageGroup: e.target.value })}
                      className={`w-full px-4 py-3.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-white/90 text-base ${
                        errors.ageGroup ? 'border-red-500 bg-red-50' : 'border-gray-300'
                      }`}
                      disabled={isSubmitting}
                    >
                      <option value="">Select age group</option>
                      <option value="U8">Under 8</option>
                      <option value="U10">Under 10</option>
                      <option value="U12">Under 12</option>
                      <option value="U14">Under 14</option>
                      <option value="U16">Under 16</option>
                      <option value="U18">Under 18</option>
                      <option value="Adult">Adult</option>
                    </select>
                    {errors.ageGroup && <p className="text-red-500 text-sm mt-1">{errors.ageGroup}</p>}
                  </div>
                </>
              )}

              {/* Invite Code (Register mode only) */}
              {mode === 'register' && formData.inviteCode && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-emerald-800 font-medium text-sm">Joining existing team</span>
                  </div>
                  <p className="text-emerald-700 text-sm mt-1">You'll be added to the team automatically after creating your account.</p>
                </div>
              )}

              {/* Submit Error */}
              {errors.submit && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <div className="flex items-start space-x-2">
                    <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-red-600 text-sm font-medium">{errors.submit}</p>
                  </div>
                </div>
              )}

              {/* Submit Button - Add type="submit" and better disabled logic */}
              <button
                type="submit"
                disabled={isSubmitting || !formData.email.trim() || !formData.password.trim()}
                className="w-full bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 hover:from-blue-600 hover:via-blue-700 hover:to-indigo-700 text-white font-medium py-4 px-4 rounded-xl transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5 text-base"
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>
                      {mode === 'login' ? 'Signing in...' : mode === 'register' ? 'Creating account...' : 'Setting up team...'}
                    </span>
                  </>
                ) : (
                  <>
                    {mode === 'login' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                        </svg>
                        <span>Sign In</span>
                      </>
                    )}
                    {mode === 'register' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                        </svg>
                        <span>Create Account</span>
                      </>
                    )}
                    {mode === 'setup' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4" />
                        </svg>
                        <span>Create Team</span>
                      </>
                    )}
                  </>
                )}
              </button>

              {/* Mode Switching - Mobile optimized */}
              <div className="text-center space-y-3 pt-2">
                {mode === 'login' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                      Don't have an account?{' '}
                      <button 
                        type="button"
                        onClick={() => switchMode('register')}
                        className="font-semibold text-blue-600 hover:text-blue-500 transition-colors duration-200"
                        disabled={isSubmitting}
                      >
                        Join a team
                      </button>
                    </p>
                    <p className="text-sm text-gray-600">
                      Need to create a new team?{' '}
                      <button 
                        type="button"
                        onClick={() => switchMode('setup')}
                        className="font-semibold text-blue-600 hover:text-blue-500 transition-colors duration-200"
                        disabled={isSubmitting}
                      >
                        Set up your team
                      </button>
                    </p>
                  </div>
                )}
                
                {(mode === 'register' || mode === 'setup') && (
                  <p className="text-sm text-gray-600">
                    Already have an account?{' '}
                    <button 
                      type="button"
                      onClick={() => switchMode('login')}
                      className="font-semibold text-blue-600 hover:text-blue-500 transition-colors duration-200"
                      disabled={isSubmitting}
                    >
                      Sign in
                    </button>
                  </p>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SimpleAuth;